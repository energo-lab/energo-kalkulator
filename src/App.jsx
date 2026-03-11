import { useState, useMemo, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, ComposedChart, Area, ReferenceLine, Cell,
} from "recharts";

/* ══════════════════════════════════════════════════
   CONSTANTS & HELPERS
   ══════════════════════════════════════════════════ */
const LIFETIME = 25;
const PV_DEG = 0.005;
const MONTHS = ["Led","Úno","Bře","Dub","Kvě","Čvn","Čvc","Srp","Zář","Říj","Lis","Pro"];
const MONTHLY_IRRADIANCE = [0.03,0.05,0.08,0.10,0.13,0.13,0.13,0.12,0.09,0.06,0.04,0.04];
const fmt = n => n == null ? "—" : Math.abs(n) >= 1e6 ? `${(n/1e6).toLocaleString("cs-CZ",{maximumFractionDigits:1})} M` : n.toLocaleString("cs-CZ");
const fmtCZK = n => `${fmt(n)} Kč`;
const pct = n => `${Math.round(n)}%`;

/* ══════════════════════════════════════════════════
   SOLAR & LOAD PROFILES
   ══════════════════════════════════════════════════ */
const SOLAR = {
  south: [0,0,0,0,0,0.01,0.08,0.22,0.42,0.62,0.80,0.93,1.0,0.96,0.85,0.70,0.50,0.30,0.12,0.03,0,0,0,0],
  eastwest: [0,0,0,0,0,0.03,0.14,0.32,0.50,0.64,0.74,0.78,0.76,0.78,0.74,0.64,0.50,0.32,0.14,0.03,0,0,0,0],
};
const LOAD_WD = [0.30,0.25,0.25,0.25,0.28,0.42,0.68,0.84,0.94,1.00,0.97,0.93,0.82,0.90,0.96,1.00,0.94,0.78,0.58,0.44,0.38,0.35,0.33,0.30];
const LOAD_WE = LOAD_WD.map(v => v * 0.32);
const SY = { south: 1060, eastwest: 985 };

function buildLoadProfile(annualMwh, wdRatio) {
  const dKwh = (annualMwh * 1000) / 365;
  const wdS = LOAD_WD.reduce((a,b) => a+b, 0);
  const weS = LOAD_WE.reduce((a,b) => a+b, 0);
  const wdF = dKwh / wdS * (wdRatio / (5/7));
  const weF = dKwh / weS * ((1 - wdRatio) / (2/7));
  return {
    wd: LOAD_WD.map(v => v * wdF),
    we: LOAD_WE.map(v => v * weF),
    avg: Array.from({length:24}, (_,h) => (LOAD_WD[h]*wdF*5 + LOAD_WE[h]*weF*2)/7),
  };
}

/* ══════════════════════════════════════════════════
   CORE FINANCIAL MODEL
   ══════════════════════════════════════════════════ */
function runModel(I) {
  const netCapex = I.capex - I.subsidy + I.trafo;
  const sy = SY[I.orient] || 1060;
  const solar = SOLAR[I.orient] || SOLAR.south;
  const solarSum = solar.reduce((a,b) => a+b, 0);
  const load = buildLoadProfile(I.annualMwh, I.wdRatio);
  const cRate = 0.5;
  const bessMaxP = I.bessKwh * cRate;
  const yearly = [];
  let cumCF = -netCapex, pbp = null;
  let cumCFpre = -netCapex, pbpPre = null;

  for (let y = 1; y <= LIFETIME; y++) {
    const deg = 1 - PV_DEG * (y - 1);
    const annProd = I.pvKwp * sy * deg;
    const dProd = solar.map(v => (v / solarSum) * (annProd / 365));

    // Simulate average day
    let directSC = 0, surplus = new Float64Array(24), deficit = new Float64Array(24);
    for (let h = 0; h < 24; h++) {
      const sc = Math.min(dProd[h], load.avg[h]);
      directSC += sc;
      surplus[h] = Math.max(0, dProd[h] - load.avg[h]);
      deficit[h] = Math.max(0, load.avg[h] - dProd[h]);
    }

    // BESS simulation with degradation
    const bessDeg = I.bessKwh > 0 ? Math.max(0.7, 1 - 0.02 * (y - 1)) : 0;
    const effCap = I.bessKwh * bessDeg;
    let soc = 0, charged = 0, discharged = 0;
    // Charge from surplus
    for (let h = 0; h < 24; h++) {
      if (surplus[h] > 0 && soc < effCap) {
        const ch = Math.min(surplus[h], bessMaxP, effCap - soc);
        soc += ch * I.bessEff;
        charged += ch;
        surplus[h] -= ch;
      }
    }
    // Discharge to deficit (prioritize peak hours)
    const peakOrder = [9,10,11,16,15,14,13,12,8,17,7,18,19,6,20,21,22,23,0,1,2,3,4,5];
    for (const h of peakOrder) {
      if (deficit[h] > 0 && soc > 0) {
        const dc = Math.min(deficit[h], bessMaxP, soc);
        soc -= dc;
        discharged += dc * I.bessEff;
        deficit[h] -= dc * I.bessEff;
      }
    }

    const totalSC = (directSC + discharged) * 365;
    const gridFeedIn = Math.max(0, annProd - totalSC);
    const scRate = annProd > 0 ? totalSC / annProd : 0;

    // Peak Shaving
    const peakOrig = Math.max(...load.avg);
    const peakNew = Math.max(...load.avg.map((v, h) => {
      const pv = dProd[h];
      const bs = (h >= 7 && h <= 18 && effCap > 0) ? bessMaxP * 0.35 * bessDeg : 0;
      return Math.max(0, v - pv - bs);
    }));
    const peakCutKw = Math.max(0, peakOrig - peakNew);
    const peakSavings = (peakCutKw / 1000) * I.resCapFee * 12;

    // Spot trading bonus (simplified: BESS arbitrage)
    const spotBonus = I.bessKwh > 0 ? effCap * 0.3 * I.spotSpread * 365 / 1000 * bessDeg : 0;

    // Revenue
    const scRev = totalSC * (I.elPrice + I.distrib) / 1000;
    const fiRev = gridFeedIn * I.feedIn / 1000;
    const totalRev = scRev + fiRev + peakSavings + spotBonus;

    // Costs
    const opex = netCapex * I.opex / 100;
    const ins = netCapex * I.insurance / 100;
    let replacement = 0;
    if (y === I.bessReplYear && I.bessKwh > 0) replacement = I.bessReplCost;
    const totalCost = opex + ins + replacement;

    // Tax & depreciation
    const depr = y <= I.deprYears ? netCapex / I.deprYears : 0;
    const ebt = totalRev - totalCost - depr;
    const tax = Math.max(0, ebt * I.taxRate / 100);
    const cf = ebt - tax + depr - replacement;
    const cfPre = totalRev - totalCost; // CF before tax (no depreciation effect)

    cumCF += cf;
    if (!pbp && cumCF >= 0) pbp = y;
    cumCFpre += cfPre;
    if (!pbpPre && cumCFpre >= 0) pbpPre = y;

    yearly.push({
      year: y, prod: Math.round(annProd), sc: Math.round(totalSC),
      scRate: Math.round(scRate * 100), fi: Math.round(gridFeedIn),
      scRev: Math.round(scRev), fiRev: Math.round(fiRev),
      peak: Math.round(peakSavings), spot: Math.round(spotBonus),
      rev: Math.round(totalRev), cost: Math.round(totalCost),
      depr: Math.round(depr), tax: Math.round(tax),
      cf: Math.round(cf), cumCF: Math.round(cumCF),
      cfPre: Math.round(cfPre), cumCFpre: Math.round(cumCFpre),
      peakKw: Math.round(peakCutKw), bessDeg: Math.round(bessDeg * 100),
    });
  }

  // LCOE
  let dcost = netCapex, denergy = 0;
  for (let y = 1; y <= LIFETIME; y++) {
    const df = 1 / Math.pow(1 + I.wacc / 100, y);
    dcost += (yearly[y-1].cost) * df;
    denergy += yearly[y-1].prod * df / 1000;
  }
  const lcoe = denergy > 0 ? dcost / denergy : 0;

  // NPV
  let npv = -netCapex;
  for (let y = 1; y <= LIFETIME; y++) npv += yearly[y-1].cf / Math.pow(1 + I.wacc / 100, y);

  // IRR bisection
  let lo = -0.1, hi = 0.6;
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    let n = -netCapex;
    for (let y = 1; y <= LIFETIME; y++) n += yearly[y-1].cf / Math.pow(1 + m, y);
    if (n > 0) lo = m; else hi = m;
  }
  const irr = (lo + hi) / 2;

  // Sensitivity ±20%
  const sensitivity = [];
  for (let d = -20; d <= 20; d += 5) {
    const f = 1 + d / 100;
    let sCum = -netCapex, sPbp = null;
    for (let y = 1; y <= LIFETIME; y++) {
      const yd = yearly[y-1];
      const adjRev = yd.sc * (I.elPrice * f + I.distrib) / 1000 + yd.fi * I.feedIn * f / 1000 + yd.peak + yd.spot;
      const cfPre2 = adjRev - yd.cost;
      sCum += cfPre2;
      if (!sPbp && sCum >= 0) sPbp = y;
    }
    sensitivity.push({ delta: d, label: `${d >= 0 ? "+" : ""}${d}%`, cumCF: Math.round(sCum), pbp: sPbp || 25 });
  }

  // Hourly heatmap data
  const dProdY1 = solar.map(v => (v / solarSum) * (I.pvKwp * sy / 365));
  const heatmap = Array.from({length: 24}, (_, h) => ({
    hour: `${String(h).padStart(2,"0")}:00`,
    prod: Math.round(dProdY1[h] * 10) / 10,
    load: Math.round(load.avg[h] * 10) / 10,
    surplus: Math.round(Math.max(0, dProdY1[h] - load.avg[h]) * 10) / 10,
    deficit: Math.round(Math.max(0, load.avg[h] - dProdY1[h]) * 10) / 10,
  }));

  // Monthly production
  const monthlyProd = MONTHS.map((m, i) => ({
    month: m, prod: Math.round(I.pvKwp * sy * MONTHLY_IRRADIANCE[i]),
  }));

  // BESS lifecycle
  const dailyCyc = I.bessKwh > 0 ? 2 : 0;
  const annCyc = Math.round(dailyCyc * 365);
  const bessLife = I.bessKwh > 0 ? Math.min(20, Math.round(I.bessCycles / Math.max(1, annCyc))) : 0;

  // PPA comparison
  const ppaYearly = [];
  let ppaCum = 0;
  for (let y = 1; y <= LIFETIME; y++) {
    const esc = Math.pow(1 + I.ppaEsc / 100, y - 1);
    const ppaCost = I.pvKwp * sy * (1 - PV_DEG * (y-1)) * I.ppaPrice * esc / 1000;
    const ownCF = yearly[y-1].cf;
    const ppaSaving = yearly[y-1].rev - ppaCost;
    ppaCum += (ownCF - ppaSaving);
    ppaYearly.push({
      year: y,
      ownCF: Math.round(ownCF),
      ppaSaving: Math.round(ppaSaving),
      diff: Math.round(ownCF - ppaSaving),
      cumDiff: Math.round(ppaCum),
    });
  }

  return {
    netCapex, yearly, pbp, pbpPre, lcoe: Math.round(lcoe * 100) / 100,
    npv: Math.round(npv), irr: Math.round(irr * 1000) / 10,
    sensitivity, heatmap, monthlyProd,
    dailyCyc, annCyc, bessLife, ppaYearly,
    y1: yearly[0],
    totalRevenue25: yearly.reduce((a, y) => a + y.rev, 0),
    totalCF25: yearly.reduce((a, y) => a + y.cf, 0),
    totalCFpre25: yearly.reduce((a, y) => a + y.cfPre, 0),
  };
}

/* ══════════════════════════════════════════════════
   STYLED COMPONENTS
   ══════════════════════════════════════════════════ */
const C = {
  bg: "#06090f", card: "#0c1117", cardHover: "#111820", border: "#1a2332",
  accent: "#d4870e", accentBright: "#f5a623", green: "#10b981", red: "#ef4444",
  blue: "#3b82f6", purple: "#8b5cf6", cyan: "#06b6d4", text: "#c9d1d9",
  muted: "#6b7280", dim: "#374151", white: "#f0f4f8",
};

const font = `"IBM Plex Mono", "Fira Code", "SF Mono", monospace`;
const fontSans = `"IBM Plex Sans", "Helvetica Neue", sans-serif`;

function Inp({ label, value, onChange, unit, hint, min, max, step = 1 }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.6px", fontFamily: fontSans }}>{label}</label>
        {unit && <span style={{ fontSize: 10, color: C.dim, fontFamily: font }}>{unit}</span>}
      </div>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        style={{ width: "100%", padding: "7px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 5, color: C.white, fontSize: 13, fontFamily: font, outline: "none", boxSizing: "border-box", transition: "border-color .15s" }}
        onFocus={e => e.target.style.borderColor = C.accent}
        onBlur={e => e.target.style.borderColor = C.border}
      />
      {hint && <div style={{ fontSize: 9, color: C.dim, marginTop: 3, fontFamily: fontSans }}>{hint}</div>}
    </div>
  );
}

function Sel({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 4, fontFamily: fontSans }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "7px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 5, color: C.white, fontSize: 13, fontFamily: font, outline: "none", cursor: "pointer" }}>
        {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );
}

function KPI({ label, value, unit, color, sub }) {
  return (
    <div style={{ background: C.card, borderRadius: 8, padding: "12px 14px", border: `1px solid ${C.border}`, flex: "1 1 150px", minWidth: 140, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, width: 3, height: "100%", background: color, borderRadius: "8px 0 0 8px" }} />
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.8px", color: C.muted, marginBottom: 6, fontFamily: fontSans }}>{label}</div>
      <div style={{ fontFamily: font, fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>
        {value}<span style={{ fontSize: 12, fontWeight: 400, color: C.muted, marginLeft: 3 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: 9, color: C.dim, marginTop: 5, fontFamily: fontSans }}>{sub}</div>}
    </div>
  );
}

function Section({ children, title, icon }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "0 2px" }}>
          {icon && <span style={{ fontSize: 15 }}>{icon}</span>}
          <span style={{ fontSize: 13, fontWeight: 700, color: C.white, fontFamily: fontSans, letterSpacing: "-0.2px" }}>{title}</span>
          <div style={{ flex: 1, height: 1, background: C.border }} />
        </div>
      )}
      {children}
    </div>
  );
}

function ChartCard({ children, title, icon, extra }) {
  return (
    <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {icon && <span style={{ fontSize: 14 }}>{icon}</span>}
          <span style={{ fontSize: 12, fontWeight: 700, color: C.white, fontFamily: fontSans }}>{title}</span>
        </div>
        {extra}
      </div>
      {children}
    </div>
  );
}

const tooltipStyle = { background: "#1a2332", border: "1px solid #2a3a4e", borderRadius: 6, fontSize: 11, fontFamily: font };

/* ══════════════════════════════════════════════════
   MAIN APP
   ══════════════════════════════════════════════════ */
export default function App() {
  const [I, setI] = useState({
    capex: 8500000, subsidy: 2000000, trafo: 350000,
    pvKwp: 200, bessKwh: 200, orient: "eastwest",
    annualMwh: 800, wdRatio: 0.75,
    elPrice: 3200, distrib: 450, resCapFee: 180000, feedIn: 800,
    opex: 1.5, insurance: 0.3,
    spotSpread: 1200,
  });

  const [tab, setTab] = useState("tech");
  const [chart, setChart] = useState("cashflow");
  const s = useCallback((k, v) => setI(p => ({ ...p, [k]: v })), []);

  // Auto-calculated battery parameters (industry averages for LFP)
  const batteryParams = useMemo(() => {
    const bessEff = 0.92;
    const bessCycles = 8000;
    const bessReplYear = 10;
    const pricePerKwhToday = 6500;
    const annualDecline = 0.10; // 10% meziroční pokles ceny baterií
    const pricePerKwhAtRepl = Math.round(pricePerKwhToday * Math.pow(1 - annualDecline, bessReplYear));
    const bessReplCost = Math.round(I.bessKwh * pricePerKwhAtRepl);
    // Auto-estimate lifecycle
    const avgDailyKwh = (I.annualMwh * 1000) / 365;
    const estDailyCycles = 2;
    const estLifeYears = I.bessKwh > 0 ? Math.min(20, Math.round(bessCycles / Math.max(1, estDailyCycles * 365))) : 0;
    return { bessEff, bessCycles, bessReplCost, bessReplYear, pricePerKwhToday, pricePerKwhAtRepl };
  }, [I.bessKwh, I.annualMwh]);

  const R = useMemo(() => runModel({
    ...I, wacc: 5, deprYears: 10, taxRate: 21,
    bessEff: batteryParams.bessEff,
    bessCycles: batteryParams.bessCycles,
    bessReplCost: batteryParams.bessReplCost,
    bessReplYear: batteryParams.bessReplYear,
    ppaPrice: 2400, ppaEsc: 2.5,
  }), [I, batteryParams]);

  const inputTabs = [
    { id: "tech", label: "FVE & Baterie", ico: "⚡" },
    { id: "invest", label: "Investice", ico: "💰" },
    { id: "load", label: "Spotřeba", ico: "📊" },
    { id: "fin", label: "Finance", ico: "🏛" },
  ];

  const chartTabs = [
    { id: "cashflow", label: "Cash Flow" },
    { id: "profile", label: "Denní profil" },
    { id: "sensitivity", label: "Citlivost" },
    { id: "revenue", label: "Výnosy" },
    { id: "monthly", label: "Měsíční" },
  ];

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: fontSans }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        *, *::before, *::after { box-sizing: border-box; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        select option { background: ${C.bg}; color: ${C.white}; }
      `}</style>

      {/* ═══ HEADER ═══ */}
      <header style={{ background: `linear-gradient(135deg, ${C.card} 0%, #0e1520 50%, #121a12 100%)`, borderBottom: `1px solid ${C.border}`, padding: "12px 20px" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ width: 42, height: 42, borderRadius: 6, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAACNCAYAAADyzTVBAABCDklEQVR42u2dd5wV1d3/P99zZub27YWy9L4IUgQR0QWiaKxY7lqiRo0BW4z6aIyxXK6aGHs0sSZRH2Mse+1GwQprjQqIlKX3vmxhy20zc87398ddEBEV0OTJ83vm/Xqhr9fu3jNnZs73fPu5gIeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4fH/4fQf/LcYgANjoJK66sIAMaP//KX0+K1enA0StHKepoFALNyP3+grJZrEtAEsPd6Pf6/E9iZVVUGx6oM8T1Fl2MxMTNWZdREo/I/fCPw8DTINxMDxPiqKjG+rIwpkVC7zu2Iyt7dDikTvfoGAl0LTdG11GeIlKt6loWDvpq1qQeHFMoxPf2yUku5ckPSFk0Ze/3i5vTqv2xILW/btKlx1+vMrKoytpXVcnUCynvtHv/xAlITjcoogF2F4hfj+paOLIgc193Ph+Rb1iF5kvvkW0agQBowJQPEABgwfbhhQdsZJ3eS1w8vDwxGxgGIYbsCTbaDdgeNKRJztqTtjz9vzn4opfjo6rfmJwGAmSlRXS2qvyqMHh57xPgfEYyaGk1ECgCOr6zse1G/4GRliMp3t6XfjnYLPBoUBLgMaIUsa62UrbULVmBIANvThHXt6a0hhEydzDoZR7MgCAiXCiyITpYohqRJQyPWpBGFIdyxvDX66PEj+m9rcd4novcBKEHAM6dCehrF4z9CQGIxiGnTmIlIgQjxQwf9+IiukTM7W+LUXnnCn2WJl9dlXljT4qwcGLa6J13FklwSADEZQhAJSwCGIZBtd5Prbbspz5fXSUiYFgtoZmZmrV2tkmDA0ToU8IllSfuDIMni83qGflvf5mJil4NrP25O33fZG/NfqE5AcTQqkUh4Tr3HHhH/jotwNCrjcWgi4tuqBh/3yWkHz7psYOHrY4uts7oF2Z+13YyPhJrUxV++st1+SfhhRkxpBf1+028FDC2EaFSMdWluW5fC9rp29Um2MdO+JqXbVra5bRvTbrpdM0nTlIGA3wj5pRGyhNViu/KPi5puPqGLPA+u6+YZrjqoUFad2zP0/JzTDvrgtsMHT6BEQhHAHc68h8e/0Qfp8DMSiYT66cHdR/60ovzWEUXGkfkmkLW1dnObPkkYTiBi+ObUZ2Y9sjHzm1/3Cr6TyeoFrTDeWp9Jz/9oS2rNzIa29nlNdkshB4uatdiAlnXNiHTtB7vdRSjsnFAUyPtxD19Zv6LwgfkW/6izZRwxr8mesbbdffviyrz77VQmazNMAWILDMMvZUMamN3i/PcvPnKvXrFl3jYGyNMkHv8eAYnWSCSqFQA8Hx1z16gQX9otaFiO7aisZmJiWJDsM4UESWxMOdnPmlP/fdIrCy4+qEufLrM3bVJTh5WX/qiicGAnQ4wp9MnBwhBlAUt2/aw++dD8jPPO+d0Knne105Bitw1aLmrIurM/2NqyKP7+lsWH9CyzPl5jbHnymPyph5bIW7oHrYhghZRSSmsIwWBTEkzLJ+panTXvbU1ffeFb855HTko8IfH4lwkIgZlApHsed1HVtkzWeLFo/m+O7Bya2N6atkFkSRIqYJBUJFDX5ixb0qjurZ5R/+JPRhcVhpSsP7avnDA8JB/Ngwjn+yk3S9aAUoDfj5dWtlzdKlTLOT0LH0HGBiQBlEt3ZBwXWxXp6ZvsX8yzW15ONpuBJz+v2/zssZVnHpAXvH5Qga87tIO0I5QGS5N0xhcJ+WuWbZ912uvzJnAsJige7wiXeXg+yL9IOMrOvPG/GoYfP8scM7nm+EU8pa4+PS8cNC2fwRywDLmk3V30+KrGk4b+feFha92mtZ//pPMjfxyZt2hyL33F7A2t27v5ZThiuE7GzrjpTNZNZV2VVmxrW/MqW20KOqKrVppTStupjNapjK3SGdvxC2UHtVavLmmYc05ZwQu3Dyta+skZY297fGW6dvDTs/s8s671iuXt3BL0GTIo2LF8ln/66vaa0+bMO84TDo9/oYDEBEgwEemiqfc/0Dr0qDvbg/lOe37XotBx1zz2x9rFpy9J2c0bs8g8t679Z4P+/mlV0gpF6s6tfO/ygZ3+MawQxxUaGfQI+U64+cMlny5uS2+DoQ1HgLTURILYEmCXtN5gOxs7R8xCQVoRsRakdS5LwgTTZ32wPXXPwT0j4dGF1ugSw8HoAr7kr2PKlr5x8tBHznxtwV8H/H1x3/e2tte0Sst8cV37fx/z8uzTaSuSnnB47M4PE7mJxQTeu0lXMftbLv3T8+29Dz7LcVyXtGtqO+tQaY9eTcWdy8KLZpz3yubI321/sv2uQ3vXnNBNTi3ziRJX2SoFZkGCXNIl72xQ9x7aK6+kd5E52iQlfH5TmD4phGUYLYrELXXbbjmik++SnsXBHibDMCwhLEgyJYnVSd0y9tk5k+85uPPDXYJWj4zjalsz5wtJ/Qp9w6sHlU8ZUhpZeupr828KB/Lfv/Dt+XcLAm4ERK0nHB678QPkQWICgwfTGObA/Esfeam914hJTqbdAZMJaEWBiEnb1tjspN66+uOtCycPLex/ba/8T3pEJJIZxwVYkCQJZoZwshWFhv+mqm4TP9mY/FuvfP8lrqLVTS16UcpJLwSCq5e02M1zFq1fvbRX/lWhLbpvc3uqb3nE7BsUxoiIJQd+2tpyz72H9zzmwKJQlZ11bIBMA0Q2NDIpOJVhX3FBL/9TMw8ZuOCGDxa8zcxERIgD2lsOHj+0gBB4GoNI1110/3PpXqMnOelWhwATUEr486W1eXlTcvncw+/Z8qBTdsGoL95c0nLxrIbkz0+NhP9sWoptl0kKuEFpGpCGf0tSO0pmAr+ZtfjTfzb2HPjKgjVbUdI9MGVIJHhwYbpXXn6wAQBsqyA0P5VdXLO+fdabs1fWA8j+cvjgQfd+nl315x/7fl/vMMot05KOQkZpDWKEDSHrbQcfrG8/8wBJfc85edTVRHQxM6emEQlPSDx+WAGJzZQgoqKf3/Wn1l6jj1HpVoegTWgoESqU/vWLlyT//saEP01YPuKAgw94oXuR8vlk/gtDH05285/mVJ7WV1xhuRqQlrGq2d2wpi1194+e3PQ0UGoDwKkDiofeVVV6qwXVLSLJKswP4tMNbi2AEyeV67cGhCWOLy9E24Gj2hsULXp1rTwNndfIn0/ffMXJvUsemDqk4uoBefJnPUIBAdbYkiG8sqn1mIVbWpqvGNbtvV6Flvni5KHFRHQ8R6MUTyTI80E8fhgnPRYzEJ/glp502Vn24COnuNpl0kTE2pWBPBncuPCL5B/uG/HXSWsmHN/NeK0ibPuSyaw9pBxlb/7MN+P0Z+de+daG7HPLs0ZDYknr5X0enDP4j/P5tX9e0PV3Cy8rWHbtsb0HZ7Lc2LeQ+nQPwgpYygHSKqnT84EKOyLtDJSj8y1WfUoRjlhqwFvrVfP0ieXT558/cvbBA7oMOOrleVNunL1q6MeN7TNXpJF9aGHjUXPbGlovH9bl414BMrJtdnZyRfjYmuNHPECJhJpZVeVl0z1+ACc9FhOYNk2Xz109WDhuuc6mZpMZOBCR4jD5AsK/dfHG9scfGPnUiamTTuwm/l4ukzqtiKUBQzvK7l9m9R3UuTB04pPFF3+0fcMTslOPxb8bG37450N9D/QrFsPLwghmHF50xrPzayYPKr2wLE+EXcVKmsKY05B9tamx6ItThuhr/BJCgTUJU0xf45zTPZIJnNEn76YuQdVlWKF15qTexUf6CvMSJz8//8/1buaJnkFVfuGAire7B6ROOZpYwIBip0++dXBxXtG6M2d9MpejURmvq/O0iMd+axBC3WAaSWSkek98rn3MmY8YQqPstd+dYCz/5K7AlqUbs0s+OOb5idsPHd/V/Fu+TLpJlmQYJACtrSCsVS3atV0xF6h15yxZt/mowuZXJgwKnJxnZt101rG1drk8YBwPAO1KvyD8WgUMdoUU1Gy7q88+VPQsixiSJJxAwBDzmrLLzntlXmJcl8BdPtPhVocdk7PZqj6RQ3tJ/ANA8tlF21YyyULJrAGtQQQBIKu1EWRWx3X13XHlYX26IZHQsX9TjZrH/48CUlMjkKhWK869/fpM18EDUzJgtfU99LeNx1zzTEFq3dxut58+0H31wfkFBYGnOpcIOERSSkcryip/WIgFrdT8wPzkuHNq5v/jtYuGPBE7cUDPLzbWn754Q2a7GSSpDUeC0lzo14dGK0vDdS14ut0h2W7q4MpWba9pycx1gmbphpR0tzuumYYUH29tufKp0w84aGgxjco6rjahyfJbvrkbU2uWtaWrHjt24OmJk4b/7lcfrXvysRVNZ26zpeE3oFzNWpLQipXsXxooHlXgv4EAnhar8gTEYz+c9FhMIBrVxWOjA9KdB1zrsFJCZUU2w1nu1L97+7ZVJ20Gnuo2+exxW/75t4NmyQMv6xkxLu6Zr00YhLmbdeNNc63hlsh3Zl8eWDCyl+4ZMgL9x/9x6ZiMET79nEBges8wAYJEWYEV6dG505ipifkz3ROHn64Ebft0Y/3qJz9dt7qqau2Klz7qPuCYA4qKFbV3veyVVa+9eMaBiUiBId02R/n8pjFno7tw8uMrq649osshk3qGnu4S8uHJkyqNs16s+1W5X/c5r3+n34atXBnLypTTsKo++bclzfwXBgjxWq9HxKPDXNo37SFRXa2CU+95LtvvsFNUKqkgQOQLwtq2pP6E28+umD7ltmuo9yG/9TWufqzhb7OvucX6o1F13NCbQn4c+sA/02cO62Q0H97XVzukRPWwM5yxAsL/wnL8+ZRH5k/5w+TeP60eVvB4U7vz2ZzN9kNvrE2/+PcP1m3/rgpbjsXExa892fXwfpFzx5TIq7e1q4WjH5s39pHJg048riL8UpkBDc1uqxJWzcrtZ184Y9mT0ycPebNPfqByUX3mnjsWNj/90fr1m7zl4LH/ApJrLFL5R545LDPmjM+zgWJN2hYsTGUZUlrzXj4F67a8rw4/fnO6qJswpEl5resyVsuW67bcvfhB4B4FwP7HRcPmHnsgDVdNSeUymAzNWYTMN9cYF5z64Jy/Tj2y/6EPv7XsUwDOTrns6NVYVJngeDyXq4gBYnAUBESxa/tstLKib6Iuu+Xp03qcVFVmPNHZUirpOFoSSX8gKN5fn8Etn28t/nxbnr1t20YDaNkO5HrWZ9XWai8X4rF/JlY0CiQS0L2GX6UKu4DSKQ2SLP1BYaz74pP2p259IXDpfU9my/pISre5yrWpOdTVl1/U+a7Ks5Y21z2JxwBg5eb2aK0v8F+98syfdy8hQ2UcHQnbiJh0EsfwGMWXfUgEvHt4lTGhttYFgD31j8cBjQSA3H/AAM2KVcmJ8doVACC5dHLnoghUm6JQKGhubUljQX3bc29tbLvvzTqpgbr2HYIxvrZWUe5atK+NU7sK7e4CvTt70wcfi0EMrovu3LgWJRK8J6H9YeYJCUS/+ZVXJnhaHIjnNPh+R/YYoEQUorS+inY9ugkAZs0CtpWVcXTfuzopFgONn1UlvjYmgG11+zXm99M0pZWVnXzX1KTo9g813VKrcev7ru/WDzlYfeVRgSNO72JN+4cr7vxUiVs/1OK2j1x57+dcfPWTnwAx8djUUee+f+0hb10aHdoLAC6YMGjwO5cPeWjT7YPS710x5I3y8vIQx2IiVlVl4HuU4UejkDVRyCIg751zhs1f98uRbbPOPvCOH3Xp0h9A/ozTRl3z6Tlj11x/8PBByJ299W9zyP+3nj1EyHWFxmL79qxigOB9EGSORiXvxWOqiUbl3h4Ltbdjfr93FosZiMdd//m/v1INO+EuJ5MCVBrCF2Zr06I1mTvP6h28+L6HnQHjf6ZTrYoFDEiD/XYSpfPeGDd+6yfzrhzbvH5od7dkQz07ddsDf/3FM3TDss1zGqYeMazfw2+3rwNWZHe8i+/7Qnd0Bo4d0K1LUvvpi+XLW179yQFXDAr4r+qTZ+TBIDy/IvubU1+Ye+vMWJUxIeeUc6yqMtw1L398iJkUsnA7xlPuVzd+CYAJnB8I0rxmteqWmZ8tigEiDuiRI2FeUDZsfMgiv6sAZBUMn8TWVte9+r0FbzKgaec0v74Ob5nYb3TfSH65k3F0IGSKZS3+pb9554Nlu3Y7Ht23r++EXoGJYZ/PgKuAPZw7sWPuuXlatLw5u+namQvm7DrOzROGHN47RPkZBTY511GjALiQSLtpXYrQupcaG1uf+nxNPYD0jsW5N5qQo1G588SafBTeM6LfkH6B8EjTEF0soQsJ4LTm9qxWK1anjblXfPb5UrSi6bvWK3/Z0CZvOnTYAUPKzFGFwu0TNK0SSwCN7TbaSa9obKa5589rmIPWDU05PxWC4vtuPu+diVU3mAHAn2613cZ1n/lUups2g2E2rbBoWf/H4rHnR9Il/aYgEAKIpFYuhK8Avo1vv7225vZ/HnXp2F8NLdNF2e1OqnNQ+ioK1YWvXsrVH20Yed15D855iBlEhB+szIMAjlVVGfHa2k33Rw859sdH5z/bK2CE2HaRtDPpgPIbPQN8IoBbx0+rVTV1UVGdSKi+RcFBx5fJV/1ggIM7p8O8y1bSMUOXNcIBH1y3+WkAZ0ajlUY8UWd3SXXrP7Es+GafIGC7X36QKwTygkMuoRkLHphZ9aX5uFPoiFgxY1R+8MlJFf5+LUkL+SGJ51PtrwE4DjVREVuUM5NKgrrfj7uGX+/uE7AVAGLQjqe321N0mREKmPinJV8GMBmxKsnTahUR+PiuoYcOzDcGpbIKknY0phEAgosA0q7CQZ1LM9cNLKnflMHrTy1reKg6kfiio29Gf+MijsWI4nF1Uf9eQ6ODin7ZNcTHlfn9ZQU+AxDul/MjAWhGUwY4qtPo+oaM+/57m9tuuf6j5V/EANrVtOTcXzMR8Ocj+/10RFH+1Z395uDOQQGQb8eVgUIJMCNZLHBohVm/NlXy+NlvLb+L4sn6vRXufRUQQqJaYcixhTJSOj7UsPQTo7X+BcO2V7c6be62T+e9ntzwTzc4qP9vjOamAzgSKrKkMUAYm0r9Davv7FH1U3/34JIbYErhE0YQRIBKoX/nYNGHa5zesRjEI1NHSmCO80OaBYPLapkBui3V6vYMRUJQLsgghIQvAMkoDVgHH9uvoivRho0zq+oJAKTKMFypDIAd0rkVw8wE2vVFgQCYgAvlGJZwU1+5sNJSKEeTyn1SgqEZHJQGHVrqi1eN7F8zfvz4plht7R6LIwOkU3BZ+eHYULBCflW/q+MFADprk3RdJUyAWUCAAU3MxHrn4uOd2s6FhhEUum33axVI3QZWSkDlTlTSGkxCgQGDCBEBo9Av/VKie2WhcWG/cOkFY4tD11E8fntNdI9HJu0QDv3UUcOvP7TUurF7nmnC1bAV63TWdlm4WkAAzCAACoICQpuDwrIMBaFTvqjPPg1gHqqqJGpr9Q7hAANMCM+YPOyZCeXhYy3SsF0XmazjAEIREbQASDPAIANs9g/Lsv4Fvl/NOLb/mTVLG0+vTiQ+/IZ5fw8BieYSg6G+fQ5q7Tf2lO1WAEamBRIi7d+w8BVseOj5govv/IkvWLDZmjfjrdAnf1sdaYNZD2TWAtsBYEW/Iee1Z40BUhgVfr/ZpdQf6LV6A7Wc/+eSGxjzmTDH/aHt5uqO83n5tUXvjige+XmPIHVSWm+ws5w2mTctaLa3wy9SAGgWagEApmNCayFdoVlzTpH7TQkhxe6WEKDZgt+E0BT8imnjOqyZhYIAM6AhoImRtl13cMRXcklJ8DaKx3/G0aiMJxJfN000CRCkAgRAslMwsDnnZdfv1A0ObChm6cIAs4ZmgmEAprGH16nYgmWCofK+9isFAU0y120mpZQMn2nInQLGGhlXq3RWkCBb9whKccaAvNuSesC26sTSx3bbkYmjUUHxuHr+6EFPndQzcobmNGfTWTdLJCypOGD4LLDvSyO443FmXA1IdmZvSa76xfuLXu1oQdg5biIaFdW0SL5/kvmPcV3DVXbaddq1liQ0h0zThBQmtAJYdqxohYzNus0FSzerhhUHKyKV5jvCxcTqxLqP9kVIvltAKksJAFRhnxFKSMXpNtcBCSevMAAj0MwABfK6P5TsOyosOg0Cjf9JyiS93Vr5xR/QLXNXad3msedmDpqDv0x5fk8m1L/QceWOizmTnmgYC6wVAFJ71jZfzktQzsrQzBwwJM1rcuo3t6XnW4YUgoQWUkCA4ChXS5kSW7J4DgA+XBXgXe+KdvGISIMBMmzlqkM6+c67bFjFQyKR+GxPL2r35+E42vg2B1KBOCSJVreptiWNbZ+YhiAIwQRASglbuzoghVjVmnkXABJ1ZRzd/VoMGFJja5r1nLUtHwZNZAuCAQpL3atbxOwdMICsJtHmaB2xhB7XKfz7vkV4PlqTaOu4Va6JRgUlEurJSUN/e3LvvDOydsZxtTCYSEZMUNax8Glzav62ducjJcXqAHQ2A6dPqd/Xr4tlje5eHCxa3ZZ+CIA9a/x4Y4cbxR3j1hw75E/juhRUZdMp24WwJEEHLJ+sa842bEpmXkw69uIWG1xoBTt3itDhQwt8YwLMOquFkcxm3D6FPt+PBxbVvLJh3ZBoDW8H0V6Z9Hsd5tV5+X1IWhJuljURjEwSZnvT25Fh40p0qDDgtDW7IJMQKvG7keIu1tY1hYhfq+2r//5kqNvAHoEBr7RIld7qU84KSta/f+76j++O1yQc/FtOEFmbIQCaQZgWI2CWmAVgh3O+m4MPYoZg4UpLmpuz6b8cN6Puuu+6wqY5cxQ6kjdMDAKBwBDChCFAtuNCOUBF0KCTe5Xcet+8DUdGEd0Zpt656Hf1JXa6pd+MAJQwhdGm9czj3qw78bs1a0LtHtVhkDaFIVvc7JrJby46fJdfWfccPuCsk7qHH+4SMKTSJByXVf98q+z8gX3HEK14syYKmUgApyUS6pqhfYcfXu7/DRzXVYpMJnDYErS0xd3++qb6y66sXfb0LvGDnZzUvaTzxJ7dj1+wJf0CAEyozVUyxABBiYT65fBOg0YV+6cqJ61cJovA2m+Z4t1NrTMu/mDTz5Y2Nn4tyfv4EYMuOqZrwQMFFqssSyObVs7Y8kDXS0f0+iURTduTH7h/AjJtvEIckIYx2IVChz4nw8ki2LJxdXrQhEo7VCChlRJgyYAjkk3kplvmRAH5Wrgwkjb9nMnvni9I5KtguH9k45KjPnj96T+D0Jjbr+lfLSTE2BH9iDP2KhmYi/WU+E2ba6IS77cZ2BL58oFWVjIG19G0RV/PL+TUF8MnBJan7PTWlJOpKgkWJl0lsrZSo0uDP3pw4sDJlEi8uPuL0kp91dHem7gLAyFLaK6JSiQgEd1FKyWQS3UsquRvcawB0vBJtpmZgGmE6jpCTaVLFH+0z/EHjOmRZ/3cySpXsUDE0Ny30NcJAErrq6gmWsaUSODw7sHfdMvzIZ1Og8nggBS8rD3T9vs57ZMeX7bsM2YmjB9vzOq45HgAGD9eUzy++cV1DY/stk9hWlWViNfW6iMryi/oGbIonXUYEDpoEX2+LbvyRy8vOJEAe/aUkWbb0vDONTT+kjKm6sSDjx45cOh5fYsudG2tXIL0aeZRpfk/BfD78bNqs9iLwNB3C0iHukYgEtHQEEQAGYKyrch+/tJWcfz1w2AFQHaaiQkEIYR22XIymxdFLy7VoWAetMtEkiAJkgjCTjoNSz5T/8bswF4LIO0mIEREWFTJKKpjFFXybtm3PQrHDp9SCkGSnNanl2y5bvDB3f6SLy22tUMhU/LBpcE7BxQXvz1+/PgkamvFDlFQOSdzHyJ2OXVjdcwHhZsZizp/OUIlgEVAx4EU3/qIcqY/MRGYGVQzuNKcPWUkL1yVXMlsQLICUy6elM1mCwEg0t5OVFvrVuXnF/QM+SZp14UGSYOgbQE5fV322seXLfvs9aP7+ogo+zUNUltLO0/4r61VuyT2CLNqFQhGV59xPKChAGEQawVpzGtuuYMA+7MpI82DHvlqgCdWC8GxmJj00J2xCWXh07oHjYKU0rAVcfegr+e1Q0pGETW8vze+iPHdz5/5YCDwhevmgWXOCshVrqf7L1/etNhHJVqSSyxdCAgYUgrDQMA10NhqF1tm0ICdhmxvaYLtrCCnbZlv64qPvgBa/03aY/9UDimAJJpsFx07r703nzN3UVcOK4RgFj28eGvNqX1KjjqihxW101BpJ8vDS0K94yO6/JLi8VtmVlUZR7z33n6WuOSCbW0u7Qi97vc4BALXRCWiAMbXEy4pU1SdUP84bkR/AsMlAYMcKMdHaSU2A8CHpS0CAM4Y0ntk95CR5zpKExN8lpCfN2U3Xv7eor90hIXtXDSKv2kDUx3mHhGBYwARQZ82oEdFgY96sKsAEJlSGOtaM/b0NQ3TGaBXH5mzxyqLaYPr5Ftbk/WbU9nanvm+yUJpl7VGkU+IgzqVD8GChvdzX8xU+/19kA1AgFlFiLUCKc2GAS1YfwKk89raKkWk2NBcb5h2BtTalJbptpV2e0Pz1obPVxR88tRkXrVyUeqfr67YYVq3/4fnlpkA1jBcR6GrX0x9+5Qhh5kkibRiEMAkOCCJNqRU88mzG87B5s2puihopztBO80jbQg2Lzuod48X5m/7db9C68QegYBsd12Ca6sxZcY15w4qeXb8rNoVLmKCKK73NevLIOk4GgFDT5h58pB3TBLQ0NA5/wRCCGRcqd9e3zb197OXr+rIhu9xldoMoupd8gS1oAfG9Tt9ZJFxlusozayFaRi8si2bea1efQwAnSMWA0DXfD0y7DOQySpNxARBqG/Pvk+AjcF1EjsSpLR3tzc4GiUkEji4zNe72C8tV7MGACmJWpWzOLGqeQPnEmh7vJdZ99cTANqS1gvAmExE0MwgaaAsJLvnrDt8l3x8p4AwiJDH3N5oBh0RKpKUYSnAkNnW5IiRI82VrY0vGHNnNBuNaxbmN2xYZsyftalo/YrGL4A2AMroOamp7PBTj0uPrz6QrWCZa4YrpNNO4pMXjmp44++b/9O0CDNATAAROa7GkIjZCYav09eWlClQ0Jh2K6T0bwBSX3e3AbAAC4UQq9Jb19XPHLet6A89eoV+JbRWaUegR4E/HO3T+RaihtN45iwJQEsid19ERIDJVYyePkT6RCITc4k+/tKPIYbjGvi82S0FsCpX55XgHXk6gEGAcBUjbMieLx4/7AUf2A5JyLBlVPYOGZVhE0i7zAEiRximNbup9d6XF61cz9GoRGW9zvlObi8Q5x4TEQOMdqlnM0DTH/3cAKDiY/sdNrFL/t1wFbtgQQCIBJg1BAkV8plyQWvyz+e+vvDhSiySANSAMGAIgtYagokBgZSDegAa06aJ79CYnLHdTawZBO74QwaE7tERvvwholiMOkAVNKx+zdq+vmu+Tq/U6eRqalm7bs6cOSpY3vtTX35xf1nWa3iqR+Xx7uhTurf4w12L1sx+tOnBK36THjD85fYDxhWqdAqSJWxlwwyHUNC2+Sy88fc7EJslEYf7H6hHAALSWilhq5z65x1FIsR+rYnA20Wb+MaHrIlhEiHf73MYoD7vr7+rf8T82UFF4cKk0lAZqINLItXx0X0eEhNrZwJAmV+uBTDs26N71tf8JkdBu1nl7p70N4m5XYFcst0vvfbdTCtiOBro7DOtyRWBk0AdwT1mZF0XWddA2CAiU1qvr2t/88wZqetqcqUkmmO5Pv4CX4h3XFMA0Foga4t2ALw17RAARAwMGlfuPwguvl4BpwkIAKYQ7wOA1ckmAPAbgEBH7L0jn552xF5HXwuCvo0ud9i8HfadSTL4wyUKT80dQh1MbVlr9xhxUNLyd07DmGyKgwsqRGRxSygYyQ454g5bSLAGWDvgYB78ya3jADAr9YaTzZ6CZJujDMMkn2lS42Y4WvhAAti8jP4jhSP3miHIkIpICnxZQaVYA0Kg1aV8oOWbC/yQE5DiYIAJYCST9e9tdq49oEA+YgilsqxQHDRRVRG5mz/FqJyPzryvFTdMgCASSghrp/2UKwKAIkZaE9r0Dun+Utex3mEJEogIWbiMrLIhmB0mwSwMgiRTgrelVePM9W2PnD594U2CYEcTa78SAcqojMx5YLmHJIhhyq/WKboKGduGLdl2HQWDmKGZZG7tswpKQ0rO1Xx9paiMOwxGylWKWeTuvZ/FwidAUDu0KgFp5fyAmfSORGFLSWWvdM/RQ3Vbrp7MNE0YPfr0Nh/9w8xs//EZFSk1SetcKEQpIXz5w/v27evb1rrqWcWjTnfySk2zdSvE+oVvWPPfu67ptQdzhXOPTHV+qCLFH6iOK7dZaaX8lik/aMy8uqQl+0iBaQnbyZWcOGSzyYI2p7l1XUtLKwAsSuwyf951NAGjQ0FyrMqgeO1fR5UMu+iwLv7h7RnWmayjDikLDrt/Yu9LLnl31b1ZnVtl9K12lr1Lopx0yCSxoNWp+6Q+fU2hJZHqeP1aa4YEmm3X+XBNZmFHHkR/OVG9MxImNCDJIJjwgQl+wcg4ihmkLZPkvK3pmadPX3g9c0wQxb/8moiOmG1au9uxM25KuZg6ZysAUE/0BLAWtmYDEpbWwiIWIAKEVtA5pcwASUU6p1uW58ZdnQaN3hGl61jhBX5rrzVIS8bpJQXBUchtPAwYQq7fpTrhh0kUuqmmj6mt8Ry4GZfABCvfyMjwqGTTipetdOsmKunemzNJLUgI1q5yi7sGG4+48OyWB6/6a6ig3woZyF+NJTOvTT31+zmdo1O6m9c+8USJP39Ynw8TJ69888kVu35dwvdZ2z+IhIAgAE2SJIE+mvLmon/suwb6+rNP1G0TBLjvr2/+rwEF5e8WWMS2Cwoz68NLC24A8Nesq1Jf+ex3FJgL0pqkKRwbW6e8s1fz3Dm5nakWZliGgZWtmezL65qvNUy5vX8kcMZxFXlHJrM22Tbp0SWh6ti4iheJ4s/sWmIya2eJjLFMa5UrtesYv8AwDyCAx4+Hi1pgSbLtH/cuyp7nMwyRzmgO+82K6p5FN+VJAa2/6ofaHc7/Z9uNzUdmWVf4IBxFGooRMKhfjx49/CIez3zTe9/hgJeEqBKCoRm5FAUDTY7YBOR6Ub6/gNQ9wACgNi5eQj0OFGQFDYJmsCSy8n4E4Hq5vblW9xC9XSFyFgJB6bxyqfK7XIHYzMeTL1w2mhYsaB5w0uUjtk2reX5Lftfj7MJOFowQlOu826m+YeSW58/YhthMA/Hxap+c9lju6FOcdprCjTcKfFsy7DtwOnY/wRq6w8SSjGBNNCqHdWoz5u2aKNwlM737GF9fjzt+Wqd0znafObQ89PxxPQtPcVVGpVzCASWB4vvH9fpVQ5tqBQnwXsr6jr8qDFJLTTQqKwFZt4f69z1XsYqOPUFoQ0Ay9IZrPlp9DwDkI/+lj07vs7Qyz1/c7rhc4CM+uaLsT7NKs7OilZX1O8r7x4+v1agFFm1uWjCuk4mIYUpozaw1OoWskQyYwHgF1NKT87fWA3h8x9XPHN6zx4kubpISULu98kxhgAnAc/Pq1l/cf2hj92CwFJphK1eVBX1dLqoITrhmDWbMGl8l95ARp0RdGQPwFQd8E8EazBBCEKdshZVb2xbmhLt2L4Ig30UioQFC6IvX5sv2+gayfALMpNwMO8HIweVHntVLNay/HdubmITJCOQJ0x+wrJUffu6unncl4hNcLFjYXHDZn+7beNyUOS09Dzo5FSm2VNrOCDsFN9s2b8u8GdsrtbIQn+DuFI5YTCAWE7ttxTkdm/t5R9A7rlFdraqYDcTj+iu/+95+CH/rE4oi1wH49UTIN2vuaYkEMzPVrGm+ckWzmwoKH2lWwnXBh3XNuyJLeqLWCppJ5l6Q+FYnfadDToIW1dfTurY22qt57uF+g4bMMjMt+8XRvha0NL+xruU3Nlj4SCBpKz20KFD86zHd76J4XI+vyp38QvGcRXr/FxsWbmmnzZaRu/uMCzWg0Ox2/4QDLqR4XC/7xdFWTTQqHx450rz36L6+WGWl1d2SJfQNindk5zDrmqhsBNq22fwepGDBrF0NREzCiELjKiLw+PHjEauqMmKAiAEiFoNYdvTRVnUioW4f1eOMQRGru22zYiKyBIk1SdX++NrkZx1hbP1DmFiMGi1bqmm7z85ONwzjLNeWGtoBFXQ33MrDT7XvnXKHr8eAxUblhEpa/fnCwOpPYgWPxz9IX/bHMwJXPXhG450XnWe3tr+qksmLdV7AFQowwhG///Pp01vv/vkJpWdcOW7T0ImPFbdsnS5Wvve7bZU96/eoCYgYzMCOrHA0Kns2qIqWwYdfPs9XfGzJ4ukXNMTj7+1o8Pr+qXcTip1Ux+67V+af5m8P0sYBPa26Wv6tbvO6oypK7upbkH+D1OQ6rmv0z/OHe0cC4aytIIhp7+dJEEra8dxO6u77veau1WarPCLyE5DuaCT76+Ci8HmTuofGOhlSWcdxDy/3n3n7uL7TJ9TWPrnD1NJVVQbV1qZWpO1XDzB8U8i2tdYsfa6pj6ywbrtsWK8l/f84460dbtOO6543pKxZo+gbax0SHdXOH21NP35wcegUwyDSmmTWtdXYzvkT/3LEsKsoHr9z9wccx4zs5H6dBh3fp/x3fkm63WUhAQVpGivb21+Yv3VrPddE5VdyPt/LB+mYqFy37Cmnc/+zSRgEZZNiclOlXa4uO/2yJ5JbFl/u27ZxUOT1P73Zdvb1p2y7fda9dnn3CjJN5F2S2tp6/39dExGxX9OY0+5wI4Xwz5/xXOvdP4+W/fymE5KDxj2TLewVEN0P+kXQtUYjfvaYkhPOHu73cVt54slNc3LdbBxjFrNKEVx/4Mmd7UK5IfTuu8bGn979UbbPyC7aZQR8vn8U29mJjfH47B2HTOy7iZXbxjRBsFIgIQ5+5ZQJkwKmFmnH0QZyJdXEQgtDmrO2NK299d15dYM7EoXCFE6H9/tlCsvYXf8nNMdigh6K3zYwb8TPRpb4OidtrVnnjKtddZD+DicdLARrjTTcAfdPGn5aHglRHA427ryWFNoBwuvaU2suff2zed+QiCQwkHRVHoAQA+lZs2pBBH5+eduF/Qv9n1cEBVKOFnkm62O7Ft73Tvfu70RrarbEiMS02lpNAN7alLzjwALfuT0ilkxnGRlXUd+gP/DLIcWvHNmt+A9z6+2Xnm1rWl5QEHIq29MlI0ryJwYNAQUwdVQEfNUshOrIwr9+aEne7IndrYOSae0qLQxLOPrU7sE7uh0/bMyC1szjH6xrXdbWZuPgviXhYRHjqMGlvqsGRkRRm6uZoBEwTaxrcZw3lzXeygBNq07slQ27lwJSrcFMRUS1jf2Grc12GVAhHFOQZQhpO4789B++5KpVbxnVv6rY/qvEp8mi0ohSDGRSLlw/8wGTfpV33s3zWh+94U5/fjFbCI1ru+dn0fwLbzs/OWj8X9ORInAmZQvHtii5/fEqwJh7wNEfJov7iLah5zR1WvnepVsev+WlP/7igTmZsh6dyQqUBtbOu2lDY81NpvnsSqV0GadaVLq4b4RHnfpShSgYvyHx1xWIxfbZJyEGWDCIhcy4NkblW5OZ3MnUkfjb8UdKOwgECc3t/BSAn/QuHCmAOapfYemWoCFaCFxItGN9m3tILtUJbEXyvS1Nvx5Y2PkJQ7DWTOIrPid/hw3MAASLjK3RLyCG9usZfoagwfSlB+NqB8GghU+3iZcAnIRYlQRqdyuxJw2CLAyYWwA0EoB4LVRHIeWCcT0Kf3dWb/8NJtkq6SpUFvsKLz4w8lciOmZmVc4H6NAmKw4sCd5wfl7BbQGZdtJKyKSj0NNv+Ht3M349qtj49Vmu1WgQHM2R4kK/ZQa1hsuKmJi0ZmbWX1m41XVxIoJ6fl3bzzuHCz4ZlG9YSdt1HUWGX9g8qVvolEOywVNO6BzUioFCnynKQwLQQLsDFqw4IC1lE5szNjbe+Kdlm5ccnuvF2avNU+y1Fp42S24A0rx5+X2maUizbdOa8JxX7ggv/vCW7EnXXx+uOq7EtSJrU0JHlKOzlGnRDGGwkzKcQES5w3/8l6JL7zg5c89ldyXv+dlJ+efdfIl76Ol/zUQ62ZzO2BSwTHPz6g3ND/7ioc8vvP26TO8xgUwgj9Kde3d2pFE6EpDp8n7DMkU9y1ORCpHNqzgFIPY1bp8htTZAknS2PZuuGNG1ZdC4TyMDRxVj2jTuCNp+B7kOCVsQM0MxoJhZsZZKuY6r3Yyj3IyjXNtRbtZRru2QctKwHduEkwYAf3OaAGBlfUN52uWQZrhaQzOzkntI+lEioTgalVd+sOZvH29Lf+Kz/EKxtpmVYtZKA0pDKyL6moD7fBYrkfs9WCsmrVztulplbKVsWzlZR3f8Ex3z9DO3fz1/IpQGK2ZosFZp2wl1aBAAubJzjsXEOW/O+e2nDak1AcskzayzGdv+Uaf8H99eNeisXYRD1USjcupbC26vWdn4UEZaZsgnhElapZTrJrNZu0Bq3TNgFFcEjE5d/IZpsVI2uYoBV4CUsAQR7eif3Wm8qGdPhXzgi+Xz/rJ401nLWt1kyO8zpCCttFDJrGsb5Li9wpbol2eKQpN12mY76SjHJKVCfinSROZzy9rumVq74uaOue71prn3x/7EJygAlNnw7l9KPs70NoXMZrsOGLJ9wJiruLg7GXa7kfzjZeeHgsbN4pBTb8gaIRtsWyCT2M24btcewfTavFMBvAAAbka8w0vnvmV063mkGymAYIK7bdkN5eVDQ63dhl2t3SyzzhKlM2yKwJKFR03tCtOntJMm4jY4+Z0OCB1/8WC9Yd506jvotyJQaEllQ6xfsMZp2vSnTHkwua/1XiwMMxKwpEG7lmuIPY+hyUTAAoQMf2UMg/wRn7RMH2AqjQBZkJZp7p6ky+W0EyAC3l7feNWwQv/7JUG/Ba1yBpZmiYAFl1JfZn1jORtbkjQKfD5p+gBTf3NYOTchZcJvgKEiX3fpRL7wSxmGI2EaUCS7AgjuUi7Hibo6QUD2rbXJiwYWBKfn+00BDfhMwhndCx9vGzdkcTSRmBuLQVTHc0JPicRFf6qq/ORHnazr+hWE+/pk7jhkMEF1tNpaggAhJKQEwEi7ZGxqsdN1ze7q3UOw1QmojoWd2OYYCy8aWHJHv3x5bInfyLVtKgMaCgyCZZAAYEGasJXCgm3ZNbM2td5w2Ucrnuww137wnvQvtUjO+W0Vx3d6ufXHV76ZMfJA6SZWbQ029Rt7XuFp173R/Mi1N/oDJYcYB/34CJ1yHBYSRijiMz9766XwXVN/bt347NMAB8r/fMUFy57ePCly3k3HYcDoq43W5p7JP1329/ZrnnrQ6VYZQmtzVpCPWGeU29bWavYZVOEE85lc1wWb7BaV+M1eB17Udt/US61BY1ZZgWYtNyx+TDxx/0OtyJ1ksbeFcYsSOXu0sTW75a3N+g2T3CDAlDvHgL4mZrlQNiufIeVW230NALbV1+WWasa/+pNtqZcLTRSzJu1Aqw1N2U27XmfXFx+LQcTj6z/oUxj69cB88zjlktY5qVQ+S8glDfacXA6lluMdycjU9tSW9zZtf73EL/IcTbnk7C61ZF/xeIlUyMrKJc2ZT3eMs6OjcH5z8o0tSdGQVo4bkNLYlMwuR640gHYND+dOBFk2o2eh7/q+EZqUdDWYmYOmYYWkM4KAOTV1UQEkcpoxtxAfB/Dcw0cMPr0ybB0VsnhwgWWFldZ5AYPaskpzm63sLMt1SeUs2tqW/fjVFdkPn1qzZi0A2j10m9NQkNWJtYv/tmjtcfHRvQ47qDTv9FIfDQ9ZoiIghd/VOmAI3dyaRWuT6y5Y0ZadPuWd5S8CaONoVO6rcOxfGq2mRqKyKhy86r8/sR5aqum+ua68b642HlmmQre91VZ60tQDAUgr9tS71t82sfnURvZd90xNJWBFpr36rlmzgc2nN3LwjlmN+Vc8cuvI3I6F/O5DCgEgfPUTb/nv+lD5Hp7P1qOrOO/hRdx1wrEHFv7yoav9T25l44FF7LtvHvvu+MgJX3z3MwAQmnh6eV/gS9Ucrflf9T0f/L/gyKx9nWNNNCrp6ylY37BO4dIePXr4kXtfxh7ztN+W9kKu12N3q7N3YWH+yGCwM3ZdBx3j7eshe/synz0n5uI3aWvS6QPFhAtm20VdA5RtJyaTESoU/i2LNgbfeXhiwzsvLbNufO5tIt2e9/glFyYvTjzn9hx0qJNqdaAg2PRLkwDZtH67b+3C+1vumXJ9uG/f0vYVK7Z1BkrS519XmfaVHuB33e6R6X+INx1+XqVZVB7NZNJrzNTWzXnLP1sriitM7RerNr30t0YQATfeaCC3S+xvRp04FtvHZxLHbuctfX2MeJy/64S/mmhURmsqGdN2TZoAmPa18fdznsDuHYVfW2h1dUTf4rzmqnd3axqbFu843mLPl5xZVSXHl5WxfC6hNO9eBQCoG2MCmCVmzQL25ejXmihktLKKMG2WEvTVvmRBBPXsqXLW/fXU0b7L/z4BAXYeYp139u/PzI4+5u+2NBwo1wRpJUP50tq0aH2oYf3x2+656ItyIJS8MbEqO+LIMndbfQaC/cwAaWYm2DKv2Gd99tpd5uL3a1TVT2boTHaxSDUto0zzcp+dWevfuKp548sPzOhUfc04u6RsqJMXKWUd6u0GIgeKvNLK4JrZdzfcd+k1mPqIgVxdl8d/Jl8pb6GvFwN8r7H/RePu53cUVlcrxGYarfEJTwWKCgcaQ6tuUGlyGGSqTCqr+x/Sza7fdEFf4KoVQDLc1BAXaxbGzbJ+JU6mjaGUBoiEYVly3eL29J3n3qRufOUl1XVwIWeTYwXEWMEObNOCWrdIj3n5gfDiviMesAeMHeymkrniNjsNSBMc7nZilOjaBLOLR6Z63zH4H22l/ctsSf5X2aj7X5YRn+AiNtNI3zv1Rmve208Y/qDJlpE1whGfnPv2E8FNi+bX3/vx4sJfPnxr+58ueqD0zikD5Kr3nrWyrSTChZINSwvLT3LTqgeCx1wxFt0qJ+i2epfTbUqnW1w33WY7maybYXPdZsCX8oVDdnurq5Mtjk62KLbTmrNJxZGi/jMnXzEORIxojffFNx7/IQKyI/RbwzL5x0t/anw+64GADPrMhe+/Elo5d37Lj86/r72wa6/ksPG/jtz84qfN4yYNS18fPV3OfHpkYOEHM3yp7YaxZan2v37Xkzj42DuVZTic64YgaJbQkCAYpOwmFQiEiGQ5lGswQeZOnBUMTY4bKVbtPXuem3POo9//iUSjErGZRu7fPtd1EWIxA7GYURWLGfu9scViYucc9tPBrMrNY8f8KTeffdzAo1FZFZuZu5fv4ej+r7cLv/cYuROFOS96bbURCZ6YHXf2mSmVdcnJCC0tloGQlG31kFtXJiLLPrul/pk750dOuHCAKinta7ans85hZ77lRIpzvTFKgVwbcDLM4QIE1sx7S7z62FXZM66dr6wgE2tikoAwQKwgJcNY+t7n6T9cPBJC8s4uoP1amCwQJ/0veMb7Vp28e/b/XzOv/TBkmEDEnoDs3+IyECc3NPXOM3SfEX+wy/qWabtdkXaJmcCmD9IfEub2rTCb1850N6+7N/3AL18GAIw8ontw/PkTlMnHaH/kABjBrmT5fBQp9MsVcxPii5n366OmznKdJODYbVo5W4WTXEHJ9Ke+9cs/KHzx1s86jjndXx+EdhRC9o9eMLG99yHj2IEd2LTk7VXP3DF7LxYGAeBxxx5buKFsyNnpYNdAfqal0Vr4zKsLP1m4dR/mRQB4yIQTBrQPO/lkjrBRsPTTd+Y9++BHe9m7TwC4srIqbI857Gdu+7ZZa2oe/qL7UT/pHO5ScWY6nX5y9TP3bf3OsTqEdMRZl09sK6wY4bLB+c1b3pv3999/hv+g5rb/fBPrK+YWuZjysJl8+Kqn/TWxg/wL359usJbw5wsIYuGkwe2NyvaF3cyQH02QgdClBefcEgv/7o038w6PHhdc8u7CA37/k/PcaScM7nf9EWW+Xx1WQX/5dQ9z9pwp7W8/Vms8fmXfwofO610W+3G5e9MJB4Yev3hqeOvSmbpbxfCG+PRnCy646zYAvF85kFiMwCyLptzx0Nah0Xe2O8Fz282Cq9tDoV8AABIJ8R2miACAFrOkd1ufSfdmfHm/31bS78/1h102d9gRJ/cDGN9prnXMu0/0khM2HnrewmbLvKI9aVywYfCPP+x7/rRfAvTd99YR+s0WFxQ29z7sD+2+igsAINu590H1lcffaQfKRuSu9R33M3gaEYD6LqN+09BlzB1tVv41G/of/mmPC2IX7vcz/l+K8YOO9shUB9Ea2ZyoXo/Z7x8TOvumM3WfodNUxaB+rj8IZFIKzIz1K9vkio+fzY7/+d3Z8p4RUd7rSLvPGCw67MykX2WWrnNVPSVb0+G8kpX2F7WJovNvLnBK+/5sO9gSgVDQ71LvtGX1QbiYHCnBvgg41X7g0cCNM2qiNvblqxSiUYl4XJUdd9Uh6V6jp6qNS6el/jQlDuSOZdkZtfs2OnIDTSWDtmbdrFs8/83D1JIF7cnLH13Q3K91MN6m5aj7jgBCTTR3CkTX0TcrW2+9/Paf9L4ZsMPXPPNEY+ngu08YMPbRVxKntX3rDh6fxkAc4SK0bc5mXQtGEgBsDTdtu65IZ/epFN6RBlPDmo+b7j5vbN6vn6lr6zTiHAIe4mh0D0e4eAKydySq1Y7jP5JETwF4KTD1D+dSz8qpurDLUJR2ktYnL79r9x5zeLa4PMSN9RmX2FACggrKQyR8IwgCBBeZcAGsjXVptsKV6aE/OkVv3wawAGkF7aQA11awoSltKze/U9GnZ998GIje3qf23cqLCUggW9H7YM5mVcXzV97feP4dN2W69KkMr18wu/6/Y7/nvbS9w06z0ayU2D50YlyOmqxF/ZKNYvOSOoAJldO+/fNCsAZEXjBSZqSaZ8SZHSQg/S9Om5cadOhZ8weM6oKlHy1FLEb4plMSO0qyAmlLSNYSwgViMcGrIA3t7PO7ZpaOGw50H/CLe+/eFiweZDase5gBYNEs+r+iQf41YVEi7gi7ShCl0g9f/kD22kkjjTmvnmoumvlUYMOKD0WvoWcTDMGBoB9SGqSZYdsOp1psJLfbOplMcWuTLV23XgWLDN3a6OhUa4ZT222dabWhlAsIgmmZMKQfhZ1MJ5h3UW7Rl+7DC5yVWwxONsuGKdoKBwSFa2wmwzwyXdL/SupYvHvjr2VyAXkmrXq54ZKj5eZVD65+6S/LEJsm97LsnkGsidxCEDGqSSm/JIDJl92e3VuPUimHtBAktJtCPK79sNtYGKx57zfE3A27GWHkdW0wSo406pfdn//xHdcBTB2Fq54G+UG0Sa5+S+C009z0n699HsDzqSPPCgWXf7bRyCs+xgwUD2fT6qXySiUH/BIgQLmA0pY0/XCaGjrproMGkRU0hd81SRiA1hCuDWSS4NatSSOVWS4zbZ/qLeueBkA7DtzeSzQAGGvnzkK3/pQ6+tIHrc+fvcyMBM5QwaKB+3K7Mr9Qmz6f7Lr6o3M3tDeNUb2G3z74tF88syg+bRVi+PbelGe1pGpSxU2b3kT5wHN7n/u7Y/JVa/Pabgde5Nu+ceOVb/z3xqnfqclyp4nIpbNTckQ0zWUDThhy5n+9tq24z0WWylKgfvm63AayiPdK1gwjz2rbsLzhnrOGaABbfuC4jicgOzaj6g5BidYIRKNANSVTbz35KIBHKwFr85Hn98/0HdJX+/JGC3+gF9joDOnPY50poFTLP/XW1eOtjO1Xyt4AJ5MUQq00nOwcbN+6RM1/f3X6i3c37qbB9iG4kOtjb4rHF0cq+p+rygfczcN/skwH8tnctnI6A4DWtDdjmltXi6CvS6a907CClocvv7vk8scuS4fK7ifQ0bm21m+R2upc70p57ehrtxxxQefm0t6vtUNoclILilbNOnMq2MW0aYTvOEkQN94o/hmPp7tsW3Jae5chj2zsfvDHDHLFmn/+ev3MZxbtSxOZ1bIpq01j0w0xFnEsMhA/wIFXqfBvCi/HYgZqWH7HjmTsYgpa3zyawH4m9nZdWwQA5UCo85Q/dO9y2KRuyH1f575sm2J01dEVPaqq/CDCWCAy4MSf9tyf2XQ74pIug0+7uRvtX0ieAGAoEOo85eHuB+bnF+x6j3vLqFGjiquqqkq85fo/LywCNTW5DHYNSzALkOj42kbO7d65kyMJzLtkmWskEPvh/KivhS/pf+Z58C4LmQj7Jfi738v/odDs/y3h+fL/9G8V2K8fObR3fHUx0/crN9nPOex+L/tfy0f4v+Z0eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHjsK/8P0moP3XttNogAAAAASUVORK5CYII=" alt="ENERGO GROUP" style={{ height: 38, width: "auto", objectFit: "contain" }} /></div>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.white, letterSpacing: "-0.5px" }}>Kalkulátor pro firemní instalace FVE + Baterie</h1>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>ENERGO GROUP · Komplexní finanční model návratnosti pro průmyslové instalace</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { l: "FVE", v: `${I.pvKwp} kWp`, c: C.accentBright },
              { l: "Baterie", v: `${I.bessKwh} kWh`, c: C.purple },
              { l: "Odběr", v: `${I.annualMwh} MWh`, c: C.blue },
            ].map(b => (
              <div key={b.l} style={{ padding: "4px 10px", borderRadius: 4, border: `1px solid ${b.c}33`, background: `${b.c}08`, fontSize: 10, fontFamily: font }}>
                <span style={{ color: C.muted }}>{b.l} </span><span style={{ color: b.c, fontWeight: 600 }}>{b.v}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "14px 14px 40px" }}>
        {/* ═══ KPI ROW ═══ */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <KPI label="Čistý CAPEX" value={fmt(R.netCapex)} unit="Kč" color={C.accentBright} sub={`Dotace ${fmt(I.subsidy)} Kč`} />
          <KPI label="Návratnost" value={R.pbpPre || ">25"} unit="let" color={R.pbpPre && R.pbpPre <= 8 ? C.green : R.pbpPre ? C.accentBright : C.red} sub="prostá doba návratnosti" />
          <KPI label="LCOE" value={R.lcoe} unit="Kč/MWh" color={C.cyan} sub={`vs. nákup ${I.elPrice} Kč/MWh`} />
          <KPI label="Peak Shaving" value={fmt(R.y1?.peak)} unit="Kč/r" color={C.purple} sub={`ořez špičky ${R.y1?.peakKw} kW`} />
          <KPI label="Roční Cash Flow" value={fmt(R.y1?.cfPre)} unit="Kč" color={R.y1?.cfPre > 0 ? C.green : C.red} sub="hrubý, rok 1" />
          <KPI label="25-letý Cash Flow" value={fmt(R.totalCFpre25)} unit="Kč" color={R.totalCFpre25 > 0 ? C.green : C.red} sub="kumulativní hrubý" />
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {/* ═══ LEFT PANEL ═══ */}
          <div style={{ flex: "0 0 310px", minWidth: 280, maxWidth: 340 }}>
            <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>
              {/* Tab bar */}
              <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
                {inputTabs.map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)} style={{
                    flex: "1 0 auto", padding: "9px 6px 7px", background: tab === t.id ? C.cardHover : "transparent",
                    border: "none", borderBottom: `2px solid ${tab === t.id ? C.accent : "transparent"}`,
                    color: tab === t.id ? C.accentBright : C.muted, cursor: "pointer",
                    fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.3px",
                    fontFamily: fontSans, transition: "all .12s", whiteSpace: "nowrap",
                  }}>
                    <div style={{ fontSize: 13, marginBottom: 1 }}>{t.ico}</div>{t.label}
                  </button>
                ))}
              </div>

              <div style={{ padding: "14px 14px 8px" }}>
                {tab === "invest" && <>
                  <Inp label="Celkový CAPEX" value={I.capex} onChange={v => s("capex",v)} unit="Kč" step={100000} hint="FVE + Baterie + montáž + projektová dokumentace" />
                  <Inp label="Dotace" value={I.subsidy} onChange={v => s("subsidy",v)} unit="Kč" step={100000} hint="Modernizační fond, OPTAK, MPO" />
                  <Inp label="Úprava trafostanice" value={I.trafo} onChange={v => s("trafo",v)} unit="Kč" step={50000} hint="Rozvodny, přípojky, fázové měření" />
                  <div style={{ background: C.bg, borderRadius: 6, padding: 10, marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: C.muted, fontFamily: fontSans }}>Čistý CAPEX</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: C.accentBright, fontFamily: font }}>{fmtCZK(R.netCapex)}</div>
                    <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>
                      Specifický náklad: {fmt(Math.round(R.netCapex / I.pvKwp))} Kč/kWp
                    </div>
                  </div>
                </>}

                {tab === "tech" && <>
                  <Inp label="Výkon FVE" value={I.pvKwp} onChange={v => s("pvKwp",v)} unit="kWp" step={10} />
                  <Inp label="Kapacita baterie" value={I.bessKwh} onChange={v => s("bessKwh",v)} unit="kWh" step={10} hint="0 = bez baterie" />
                  <Sel label="Orientace panelů" value={I.orient} onChange={v => s("orient",v)} options={[
                    {v:"eastwest",l:"Východ-Západ – plošší profil, 985 kWh/kWp"},
                    {v:"south",l:"Jih – vyšší špička, 1 060 kWh/kWp"},
                  ]} />
                  <div style={{ background: C.bg, borderRadius: 6, padding: 10, marginTop: 4, fontSize: 11, color: C.muted, fontFamily: font }}>
                    <div>Rok 1: <b style={{color: C.accentBright}}>{fmt(R.y1?.prod)} kWh</b></div>
                    <div>Vlastní spotřeba: <b style={{color: C.green}}>{R.y1?.scRate}%</b></div>
                    <div>Baterie/FVE ratio: <b style={{color: C.purple}}>{I.bessKwh > 0 ? (I.bessKwh/I.pvKwp).toFixed(1) : "—"} kWh/kWp</b></div>
                    <div>Pokrytí spotřeby: <b style={{color: C.blue}}>{Math.round(R.y1?.prod / (I.annualMwh*10))}%</b></div>
                  </div>
                  {I.bessKwh > 0 && (
                    <div style={{ background: C.bg, borderRadius: 6, padding: 10, marginTop: 8 }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 6, fontFamily: fontSans, fontWeight: 600 }}>BATERIE – AUTO PARAMETRY</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 10, fontFamily: font }}>
                        <div><span style={{color: C.dim}}>Efektivita:</span> <b style={{color: C.cyan}}>{(batteryParams.bessEff*100).toFixed(0)}%</b></div>
                        <div><span style={{color: C.dim}}>Cykly (LFP):</span> <b style={{color: C.cyan}}>{fmt(batteryParams.bessCycles)}</b></div>
                        <div><span style={{color: C.dim}}>Výměna:</span> <b style={{color: C.purple}}>rok {batteryParams.bessReplYear}</b></div>
                        <div><span style={{color: C.dim}}>Cena dnes:</span> <b style={{color: C.muted}}>{fmt(batteryParams.pricePerKwhToday)} Kč/kWh</b></div>
                        <div><span style={{color: C.dim}}>Cena v r. {batteryParams.bessReplYear}:</span> <b style={{color: C.green}}>{fmt(batteryParams.pricePerKwhAtRepl)} Kč/kWh</b></div>
                        <div><span style={{color: C.dim}}>Náklady výměny:</span> <b style={{color: C.purple}}>{fmtCZK(batteryParams.bessReplCost)}</b></div>
                        <div><span style={{color: C.dim}}>Denní cykly:</span> <b style={{color: C.purple}}>{R.dailyCyc}</b></div>
                        <div><span style={{color: C.dim}}>Životnost:</span> <b style={{color: R.bessLife >= batteryParams.bessReplYear ? C.green : C.red}}>{R.bessLife} let</b></div>
                      </div>
                      <div style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>
                        LFP baterie. Pokles ceny baterií −10 %/rok → v roce {batteryParams.bessReplYear} cena {fmt(batteryParams.pricePerKwhAtRepl)} Kč/kWh místo {fmt(batteryParams.pricePerKwhToday)} Kč/kWh.
                      </div>
                    </div>
                  )}
                </>}

                {tab === "load" && <>
                  <Inp label="Roční odběr" value={I.annualMwh} onChange={v => s("annualMwh",v)} unit="MWh" step={50} />
                  <Sel label="Provozní režim" value={I.wdRatio} onChange={v => s("wdRatio", parseFloat(v))} options={[
                    {v: "0.60", l: "Jednosměnný (Po–Pá, víkendy minimálně)"},
                    {v: "0.70", l: "Jednosměnný + částečné víkendy"},
                    {v: "0.75", l: "Dvousměnný provoz"},
                    {v: "0.85", l: "Třísměnný provoz"},
                    {v: "0.95", l: "Nepřetržitý provoz (24/7)"},
                  ]} />
                  <Inp label="Rezervovaný příkon" value={I.resCapFee} onChange={v => s("resCapFee",v)} unit="Kč/MW/měs." step={10000} hint="Měsíční poplatek za sjednaný příkon" />
                  <div style={{ background: C.bg, borderRadius: 6, padding: 10, marginTop: 4, fontSize: 10, color: C.dim }}>
                    <b style={{ color: C.purple }}>Asymetrie & fázové měření:</b> Model počítá se sumačním měřením (3f celkem). U C&I instalací se symetrickými střídači je to standardní přístup. Pro fázovou asymetrii kontaktujte ENERGO GROUP.
                  </div>
                </>}

                {tab === "fin" && <>
                  <Inp label="Cena silové složky" value={I.elPrice} onChange={v => s("elPrice",v)} unit="Kč/MWh" step={100} />
                  <Inp label="Variabilní distribuce" value={I.distrib} onChange={v => s("distrib",v)} unit="Kč/MWh" step={50} />
                  <Inp label="Výkupní cena přetoků" value={I.feedIn} onChange={v => s("feedIn",v)} unit="Kč/MWh" step={50} />
                  <Inp label="Spot spread (Baterie)" value={I.spotSpread} onChange={v => s("spotSpread",v)} unit="Kč/MWh" step={100} hint="Průměrný cenový diferenciál pro arbitráž" />
                  <Inp label="OPEX" value={I.opex} onChange={v => s("opex",v)} unit="% CAPEX/r" step={0.1} />
                  <Inp label="Pojištění" value={I.insurance} onChange={v => s("insurance",v)} unit="% CAPEX/r" step={0.1} />
                </>}

              </div>
            </div>
          </div>

          {/* ═══ RIGHT PANEL ═══ */}
          <div style={{ flex: 1, minWidth: 320 }}>
            {/* Chart tabs */}
            <div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap" }}>
              {chartTabs.map(t => (
                <button key={t.id} onClick={() => setChart(t.id)} style={{
                  padding: "7px 14px", borderRadius: 5,
                  border: `1px solid ${chart === t.id ? C.accent : C.border}`,
                  background: chart === t.id ? `${C.accent}15` : C.card,
                  color: chart === t.id ? C.accentBright : C.muted,
                  cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: fontSans, transition: "all .12s",
                }}>{t.label}</button>
              ))}
            </div>

            {/* ── CASH FLOW ── */}
            {chart === "cashflow" && (
              <ChartCard title="Kumulativní Cash Flow" icon="📈">
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={R.yearly} margin={{top:10,right:10,left:5,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="year" stroke={C.dim} fontSize={10} tickLine={false} />
                    <YAxis stroke={C.dim} fontSize={9} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v=>[fmtCZK(v)]} labelFormatter={l=>`Rok ${l}`} />
                    <Legend wrapperStyle={{fontSize:10}} />
                    <ReferenceLine y={0} stroke={C.dim} strokeWidth={2} />
                    {R.pbpPre && <ReferenceLine x={R.pbpPre} stroke={C.green} strokeDasharray="5 5" label={{value:`Návratnost: ${R.pbpPre} let`,fill:C.green,fontSize:10,position:"top"}} />}
                    {I.bessKwh > 0 && <ReferenceLine x={batteryParams.bessReplYear} stroke={C.red} strokeDasharray="3 3" label={{value:"Výměna baterie",fill:C.red,fontSize:9,position:"bottom"}} />}
                    <Bar dataKey="cfPre" name="Roční Cash Flow" fill={C.blue} opacity={0.35} radius={[2,2,0,0]} />
                    <Line dataKey="cumCFpre" name="Kumulativní CF" stroke={C.accentBright} strokeWidth={2.5} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartCard>
            )}

            {/* ── DAILY PROFILE ── */}
            {chart === "profile" && (
              <ChartCard title="Denní profil: Výroba vs. Spotřeba (průměrný den)" icon="🌤️">
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={R.heatmap} margin={{top:10,right:10,left:5,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="hour" stroke={C.dim} fontSize={9} interval={1} tickLine={false} />
                    <YAxis stroke={C.dim} fontSize={9} label={{value:"kWh",angle:-90,position:"insideLeft",fill:C.dim,fontSize:9}} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{fontSize:10}} />
                    <Area dataKey="prod" name="Výroba FVE" fill={`${C.accentBright}40`} stroke={C.accentBright} strokeWidth={2} />
                    <Area dataKey="surplus" name="Přebytek → Baterie/přetok" fill={`${C.green}30`} stroke={C.green} strokeWidth={1} />
                    <Area dataKey="deficit" name="Odběr ze sítě" fill={`${C.red}25`} stroke={C.red} strokeWidth={1} />
                    <Line dataKey="load" name="Spotřeba" stroke={C.blue} strokeWidth={2} strokeDasharray="6 3" dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{ display:"flex", gap:16, justifyContent:"center", marginTop:8, fontSize:10, color:C.muted, flexWrap:"wrap" }}>
                  <span>Vlastní spotřeba: <b style={{color:C.green}}>{R.y1?.scRate}%</b></span>
                  <span>Peak shaving: <b style={{color:C.purple}}>−{R.y1?.peakKw} kW</b></span>
                  <span>Orientace: <b style={{color:C.cyan}}>{I.orient === "south" ? "Jih" : "Východ-Západ"}</b></span>
                </div>
              </ChartCard>
            )}

            {/* ── SENSITIVITY ── */}
            {chart === "sensitivity" && (
              <ChartCard title="Citlivostní analýza: Vliv ceny elektřiny na návratnost" icon="🎯">
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={R.sensitivity} margin={{top:10,right:40,left:5,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="label" stroke={C.dim} fontSize={10} tickLine={false} />
                    <YAxis yAxisId="cf" stroke={C.dim} fontSize={9} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`} tickLine={false} />
                    <YAxis yAxisId="pbp" orientation="right" stroke={C.dim} fontSize={9} label={{value:"Návratnost (let)",angle:90,position:"insideRight",fill:C.dim,fontSize:9}} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v,name) => [name==="25-letý Cash Flow" ? fmtCZK(v) : `${v} let`, name]} labelFormatter={l=>`Cena elektřiny ${l}`} />
                    <Legend wrapperStyle={{fontSize:10}} />
                    <ReferenceLine yAxisId="cf" y={0} stroke={C.dim} strokeWidth={2} />
                    <Bar yAxisId="cf" dataKey="cumCF" name="25-letý Cash Flow">
                      {R.sensitivity.map((e,i) => <Cell key={i} fill={e.cumCF>=0?C.green:C.red} opacity={0.6} radius={[3,3,0,0]} />)}
                    </Bar>
                    <Line yAxisId="pbp" dataKey="pbp" name="Návratnost" stroke={C.purple} strokeWidth={2} dot={{r:3,fill:C.purple}} />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{ display:"flex", gap:6, justifyContent:"center", marginTop:10, flexWrap:"wrap" }}>
                  {R.sensitivity.filter((_,i)=>i%2===0).map(s=>(
                    <div key={s.delta} style={{ padding:"4px 8px", borderRadius:4, border:`1px solid ${s.cumCF>=0?C.green:C.red}33`, background:`${s.cumCF>=0?C.green:C.red}08`, fontSize:9, fontFamily:font }}>
                      {s.label}: <span style={{color:s.cumCF>=0?C.green:C.red,fontWeight:600}}>návratnost {s.pbp} let</span>
                    </div>
                  ))}
                </div>
              </ChartCard>
            )}

            {/* ── REVENUE BREAKDOWN ── */}
            {chart === "revenue" && (
              <ChartCard title="Struktura ročních výnosů" icon="💶">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={R.yearly} margin={{top:10,right:10,left:5,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="year" stroke={C.dim} fontSize={10} tickLine={false} />
                    <YAxis stroke={C.dim} fontSize={9} tickFormatter={v=>`${(v/1000).toFixed(0)}k`} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v=>[fmtCZK(v)]} labelFormatter={l=>`Rok ${l}`} />
                    <Legend wrapperStyle={{fontSize:10}} />
                    <Bar dataKey="scRev" name="Vlastní spotřeba" stackId="a" fill={C.accentBright} />
                    <Bar dataKey="fiRev" name="Přetoky" stackId="a" fill={C.cyan} />
                    <Bar dataKey="peak" name="Peak Shaving" stackId="a" fill={C.purple} />
                    <Bar dataKey="spot" name="Spot arbitráž" stackId="a" fill={C.blue} radius={[2,2,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ display:"flex", gap:12, justifyContent:"center", marginTop:8, fontSize:10, flexWrap:"wrap" }}>
                  {[
                    {l:"Vl. spotřeba",v:R.y1?.scRev,c:C.accentBright},
                    {l:"Přetoky",v:R.y1?.fiRev,c:C.cyan},
                    {l:"Peak Shaving",v:R.y1?.peak,c:C.purple},
                    {l:"Spot",v:R.y1?.spot,c:C.blue},
                  ].map(x=>(
                    <span key={x.l} style={{color:x.c}}>■ {x.l}: {fmt(x.v)} Kč/r</span>
                  ))}
                </div>
              </ChartCard>
            )}

            {/* ── MONTHLY ── */}
            {chart === "monthly" && (
              <ChartCard title="Měsíční výroba FVE (rok 1)" icon="📅">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={R.monthlyProd} margin={{top:10,right:10,left:5,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="month" stroke={C.dim} fontSize={10} tickLine={false} />
                    <YAxis stroke={C.dim} fontSize={9} label={{value:"kWh",angle:-90,position:"insideLeft",fill:C.dim,fontSize:9}} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v=>[`${fmt(v)} kWh`]} />
                    <Bar dataKey="prod" name="Výroba" radius={[4,4,0,0]}>
                      {R.monthlyProd.map((_,i) => <Cell key={i} fill={i>=3&&i<=8?C.accentBright:`${C.accentBright}60`} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ textAlign:"center", fontSize:10, color:C.muted, marginTop:6 }}>
                  Celkem rok 1: <b style={{color:C.accentBright, fontFamily:font}}>{fmt(R.y1?.prod)} kWh</b> · Specifický výnos: {SY[I.orient]} kWh/kWp
                </div>
              </ChartCard>
            )}

            {/* ═══ DETAIL TABLE ═══ */}
            <ChartCard title="Cash Flow rok 1 – hrubý detail" icon="📋">
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <tbody>
                    {[
                      { s: "Výroba & Spotřeba", items: [
                        ["Výroba FVE", `${fmt(R.y1?.prod)} kWh`, C.accentBright],
                        ["Vlastní spotřeba", `${fmt(R.y1?.sc)} kWh (${R.y1?.scRate}%)`, C.green],
                        ["Přetoky do sítě", `${fmt(R.y1?.fi)} kWh`, C.cyan],
                      ]},
                      { s: "Výnosy", items: [
                        ["Úspora vlastní spotřebou", fmtCZK(R.y1?.scRev), C.green],
                        ["Výnos z přetoků", fmtCZK(R.y1?.fiRev), C.cyan],
                        ["Úspora Peak Shaving", fmtCZK(R.y1?.peak), C.purple],
                        ["Spot arbitráž (Baterie)", fmtCZK(R.y1?.spot), C.blue],
                        ["Celkový výnos", fmtCZK(R.y1?.rev), C.accentBright],
                      ]},
                      { s: "Náklady", items: [
                        ["OPEX + pojištění", `− ${fmtCZK(R.y1?.cost)}`, C.red],
                      ]},
                      { s: "Výsledek", items: [
                        ["Cash Flow rok 1 (hrubý)", fmtCZK(R.y1?.cfPre), R.y1?.cfPre > 0 ? C.green : C.red],
                      ]},
                    ].map((section, si) => (
                      [
                        <tr key={`s${si}`}><td colSpan={2} style={{ padding: "8px 8px 4px", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `1px solid ${C.border}` }}>{section.s}</td></tr>,
                        ...section.items.map(([label, val, color], ri) => (
                          <tr key={`${si}-${ri}`} style={{ borderBottom: `1px solid ${C.border}08` }}>
                            <td style={{ padding: "5px 8px", color: C.muted, fontFamily: fontSans }}>{label}</td>
                            <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 600, color, fontFamily: font, fontSize: 11 }}>{val}</td>
                          </tr>
                        ))
                      ]
                    )).flat()}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            {/* ═══ BATERIE LIFECYCLE BOX ═══ */}
            {I.bessKwh > 0 && (
              <ChartCard title="Baterie – Lifecycle & Peak Shaving Detail" icon="🔋">
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:10 }}>
                  {[
                    { t: "CYKLIČNOST", items: [`${R.dailyCyc} cyklů/den`, `${R.annCyc} cyklů/rok`, `Životnost: ${R.bessLife} let`], c: C.purple },
                    { t: "PEAK SHAVING", items: [`Ořez špičky: −${R.y1?.peakKw} kW`, `Roční úspora: ${fmtCZK(R.y1?.peak)}`, `Baterie vybíjení ve špičkách 7–18h`], c: C.purple },
                    { t: "DEGRADACE", items: [`Rok 1: ${R.y1?.bessDeg}% kapacity`, `Rok 10: ~${Math.max(70, 100-20)}%`, `Lineární 2%/rok`], c: C.cyan },
                    { t: "VÝMĚNA", items: [`Rok ${batteryParams.bessReplYear}: ${fmtCZK(batteryParams.bessReplCost)}`, `Cena −10%/rok → ${fmt(batteryParams.pricePerKwhAtRepl)} Kč/kWh`, `Nová baterie → reset degradace`], c: C.accentBright },
                  ].map(box => (
                    <div key={box.t} style={{ background: C.bg, borderRadius: 6, padding: 10, borderLeft: `3px solid ${box.c}` }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: box.c, textTransform: "uppercase", marginBottom: 6, letterSpacing: "0.5px" }}>{box.t}</div>
                      {box.items.map((item, i) => (
                        <div key={i} style={{ fontSize: 10, color: C.text, marginBottom: 2, fontFamily: font }}>{item}</div>
                      ))}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, padding: "8px 10px", background: `${C.purple}10`, borderRadius: 6, border: `1px solid ${C.purple}25`, fontSize: 10, color: C.muted }}>
                  <b style={{ color: C.purple }}>Fázové měření v C&I:</b> U průmyslových instalací se symetrickými střídači se standardně používá sumační (celkové 3f) měření.
                  Fázová asymetrie se projevuje primárně u 1f střídačů v RD. Pro specifické scénáře s asymetrií kontaktujte ENERGO GROUP pro detailní analýzu.
                </div>
              </ChartCard>
            )}
          </div>
        </div>

        <div style={{ textAlign:"center", marginTop:20, fontSize:9, color:C.dim, fontFamily:font }}>
          ENERGO GROUP · Kalkulátor pro firemní instalace FVE + Baterie v3.0 · Orientační výpočet · Skutečné hodnoty závisí na konkrétních podmínkách projektu · www.energogroup.cz
        </div>
      </div>
    </div>
  );
}
