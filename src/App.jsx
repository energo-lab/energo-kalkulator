import { useState, useMemo, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, ComposedChart, Area, ReferenceLine, Cell,
} from "recharts";

/* ══════════════════════════════════════════════════
   CONSTANTS & HELPERS
   ══════════════════════════════════════════════════ */
const LIFETIME = 30;
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

/* Daňové odpisy: rovnoměrné (§31 ZDP) nebo zrychlené (§32 ZDP).
   Zrychlené používá koeficienty k1 = doba odpisování, k2 = doba + 1
   (platí pro standardní odpisové skupiny dle přílohy č. 1 ZDP). */
function buildDeprSchedule(base, years, method) {
  const sched = Array(LIFETIME).fill(0);
  if (base <= 0 || years <= 0) return sched;
  const n = Math.min(years, LIFETIME);
  if (method === "accelerated") {
    const k2 = years + 1; // koeficient pro další roky
    let resid = base;
    sched[0] = base / years;        // 1. rok: vstupní cena / k1 (k1 = doba)
    resid -= sched[0];
    for (let y = 2; y <= n; y++) {
      const d = (2 * resid) / (k2 - (y - 1)); // 2 × zůstatková cena / (k2 − počet let)
      sched[y - 1] = d;
      resid -= d;
    }
  } else {
    for (let y = 1; y <= n; y++) sched[y - 1] = base / years; // rovnoměrně
  }
  return sched;
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
  const deprSched = buildDeprSchedule(netCapex, I.deprYears, I.deprMethod);
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
    const ySinceRepl = I.bessReplYear > 0 ? (y - 1) % I.bessReplYear : (y - 1);
    const bessDeg = I.bessKwh > 0 ? Math.max(0.7, 1 - 0.02 * ySinceRepl) : 0;
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
    if (I.bessKwh > 0 && I.bessReplYear > 0 && y % I.bessReplYear === 0 && y < LIFETIME) {
      replacement = Math.round(I.bessKwh * I.bessPriceToday * Math.pow(1 - I.bessDecline, y));
    }
    const totalCost = opex + ins + replacement;

    // Tax & depreciation
    const depr = deprSched[y - 1];
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
    sensitivity.push({ delta: d, label: `${d >= 0 ? "+" : ""}${d}%`, cumCF: Math.round(sCum), pbp: sPbp || LIFETIME });
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
  const bessLife = I.bessKwh > 0 ? I.bessReplYear : 0;

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
    taxShieldY1: Math.round(yearly[0].depr * I.taxRate / 100),
    taxShield25: Math.round(yearly.reduce((a, y) => a + y.depr, 0) * I.taxRate / 100),
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
/* Světlý motiv. Klíč `white` drží nejtmavší text (silné nadpisy/hodnoty). */
const C = {
  bg: "#eef3f8", card: "#ffffff", cardHover: "#f3f7fb", border: "#dde6ef",
  accent: "#e8612a", accentBright: "#f47b33", green: "#13a06f", red: "#dc2626",
  blue: "#1c9ad6", purple: "#7c3aed", cyan: "#0e9bb8", text: "#33414f",
  muted: "#6b7a8a", dim: "#9aa8b6", white: "#10202e",
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

function KPI({ label, value, unit, color, sub, info }) {
  return (
    <div style={{ background: C.card, borderRadius: 8, padding: "12px 14px", border: `1px solid ${C.border}`, boxShadow: "0 1px 3px rgba(15,23,42,0.05)", flex: "1 1 150px", minWidth: 140, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, width: 3, height: "100%", background: color, borderRadius: "8px 0 0 8px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.8px", color: C.muted, fontFamily: fontSans }}>{label}</span>
        {info && <span title={info} style={{ fontSize: 9, fontWeight: 700, color: C.muted, cursor: "help", border: `1px solid ${C.border}`, borderRadius: "50%", width: 13, height: 13, lineHeight: "11px", textAlign: "center", flexShrink: 0 }}>i</span>}
      </div>
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

const tooltipStyle = { background: "#ffffff", border: "1px solid #dce3ec", borderRadius: 6, fontSize: 11, fontFamily: font, color: "#334155", boxShadow: "0 4px 14px rgba(15,23,42,0.12)" };

/* ══════════════════════════════════════════════════
   MAIN APP
   ══════════════════════════════════════════════════ */
export default function App() {
  const [I, setI] = useState({
    capex: 3000000, subsidy: 1000000, trafo: 200000,
    pvKwp: 100, bessKwh: 100, orient: "eastwest",
    annualMwh: 400, wdRatio: 0.75,
    elPrice: 2900, distrib: 500, resCapFee: 180000, feedIn: 1400,
    opex: 1.5, insurance: 0.3,
    spotSpread: 1800,
    deprMethod: "accelerated", deprYears: 10,
  });

  const [tab, setTab] = useState("tech");
  const [chart, setChart] = useState("cashflow");
  const s = useCallback((k, v) => setI(p => ({ ...p, [k]: v })), []);

  // Auto-calculated battery parameters (industry averages for LFP)
  const batteryParams = useMemo(() => {
    const bessEff = 0.92;
    const bessCycles = 8000;
    const bessReplYear = 13;
    const pricePerKwhToday = 6000;
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
    ...I, wacc: 5, taxRate: 21,
    bessEff: batteryParams.bessEff,
    bessCycles: batteryParams.bessCycles,
    bessReplCost: batteryParams.bessReplCost,
    bessReplYear: batteryParams.bessReplYear,
    bessPriceToday: batteryParams.pricePerKwhToday,
    bessDecline: 0.10,
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
        html, body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        select option { background: ${C.card}; color: ${C.white}; }
        button:hover { filter: brightness(0.97); }
        .print-only { display: none; }
        @media print {
          @page { size: A4; margin: 12mm; }
          body { background: #fff !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          .app-header { box-shadow: none !important; }
          .app-root { max-width: 100% !important; padding: 0 !important; }
          .right-panel { flex: 1 1 100% !important; min-width: 0 !important; width: 100% !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .recharts-wrapper, .recharts-surface { page-break-inside: avoid; }
        }
      `}</style>

      {/* ═══ HEADER ═══ */}
      <header className="app-header" style={{ background: "#ffffff", borderBottom: `1px solid ${C.border}`, padding: "12px 20px", boxShadow: "0 1px 3px rgba(15,23,42,0.06)" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ order: 3, marginLeft: 8, display: "flex", alignItems: "center", justifyContent: "center" }}><img src="/energo-logo.jpg" alt="ENERGO GROUP" style={{ height: 46, width: "auto", objectFit: "contain", display: "block" }} /></div>
          <div style={{ flex: 1, order: 1, minWidth: 240 }}>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.white, letterSpacing: "-0.5px" }}>Kalkulátor pro firemní instalace FVE + Baterie</h1>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>ENERGO GROUP · Komplexní finanční model návratnosti pro průmyslové instalace</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", order: 2 }}>
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
      <div className="no-print" style={{ height: 3, background: "linear-gradient(90deg, #e8612a 0%, #f47b33 38%, #1c9ad6 100%)" }} />

      <div className="app-root" style={{ maxWidth: 1400, margin: "0 auto", padding: "14px 14px 40px" }}>
        {/* ═══ HLAVIČKA JEN PRO TISK/PDF ═══ */}
        <div className="print-only" style={{ marginBottom: 16, paddingBottom: 10, borderBottom: `2px solid ${C.accent}` }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.white }}>ENERGO GROUP — Orientační návrh FVE + Baterie</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            FVE {I.pvKwp} kWp · Baterie {I.bessKwh} kWh · Roční odběr {I.annualMwh} MWh · Vygenerováno {new Date().toLocaleDateString("cs-CZ")}
          </div>
        </div>

        {/* ═══ EXPORT / TISK ═══ */}
        <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
          <button onClick={() => window.print()} title="Otevře dialog tisku" style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 14px", borderRadius:6, border:`1px solid ${C.border}`, background:C.card, color:C.text, fontSize:12, fontWeight:600, fontFamily:fontSans, cursor:"pointer", boxShadow:"0 1px 2px rgba(15,23,42,0.05)" }}>🖨️ Tisk</button>
          <button onClick={() => window.print()} title="V dialogu zvolte cíl „Uložit jako PDF“" style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 14px", borderRadius:6, border:"none", background:C.accent, color:"#fff", fontSize:12, fontWeight:600, fontFamily:fontSans, cursor:"pointer", boxShadow:"0 1px 3px rgba(194,116,10,0.4)" }}>📄 Export do PDF</button>
        </div>

        {/* ═══ KPI ROW ═══ */}
        <div className="kpi-row" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <KPI label="Čistý CAPEX" value={fmt(R.netCapex)} unit="Kč" color={C.accent} sub={`Dotace ${fmt(I.subsidy)} Kč`}
            info="CAPEX (Capital Expenditure) = celková investice. Čistý CAPEX = investice + úprava trafostanice − dotace." />
          <KPI label="Návratnost" value={R.pbp || ">30"} unit="let" color={R.pbp && R.pbp <= 8 ? C.green : R.pbp ? C.accentBright : C.red} sub="po zdanění, vč. odpisů"
            info="Doba, za kterou kumulovaný čistý peněžní tok po zdanění (včetně daňového štítu z odpisů) pokryje investici. Zrychlené odpisy ji zkracují." />
          <KPI label="IRR" value={R.irr} unit="%" color={R.irr >= 8 ? C.green : C.accentBright} sub="vnitřní výnos. procento"
            info="IRR (Internal Rate of Return) = roční výnosnost projektu po dani. Čím vyšší, tím lépe; porovnává se s cenou kapitálu (WACC 5 %)." />
          <KPI label="LCOE" value={R.lcoe} unit="Kč/MWh" color={C.cyan} sub={`vs. nákup ${I.elPrice} Kč/MWh`}
            info="LCOE (Levelized Cost of Energy) = průměrné náklady na 1 MWh vlastní elektřiny za celou životnost. Je-li pod cenou nákupu, projekt šetří." />
          <KPI label="Peak Shaving" value={fmt(R.y1?.peak)} unit="Kč/r" color={C.purple} sub={`ořez špičky ${R.y1?.peakKw} kW`}
            info="Peak shaving = snížení odebíraného špičkového výkonu z baterie/FVE, čímž klesá platba za rezervovaný příkon." />
          <KPI label="Roční Cash Flow" value={fmt(R.y1?.cf)} unit="Kč" color={R.y1?.cf > 0 ? C.green : C.red} sub="po dani, rok 1"
            info="Čistý roční peněžní tok v 1. roce po zdanění (výnosy − náklady − daň). Zrychlené odpisy daň v prvních letech snižují." />
          <KPI label="30-letý Cash Flow" value={fmt(R.totalCF25)} unit="Kč" color={R.totalCF25 > 0 ? C.green : C.red} sub="kumulativní po dani"
            info="Souhrnný čistý peněžní tok za 30 let provozu po zdanění, po odečtení investice a výměn baterie." />
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {/* ═══ LEFT PANEL ═══ */}
          <div className="no-print" style={{ flex: "0 0 310px", minWidth: 280, maxWidth: 340 }}>
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
                  <Sel label="Metoda odpisů" value={I.deprMethod} onChange={v => s("deprMethod",v)} options={[
                    {v:"linear", l:"Rovnoměrné (§31 ZDP) – stejný odpis"},
                    {v:"accelerated", l:"Zrychlené (§32 ZDP) – přední zatížení"},
                  ]} />
                  <Sel label="Odpisová skupina / doba" value={String(I.deprYears)} onChange={v => s("deprYears", parseInt(v))} options={[
                    {v:"5", l:"2. skupina – 5 let (měniče, baterie)"},
                    {v:"10", l:"3. skupina – 10 let (FV panely)"},
                    {v:"20", l:"4. skupina – 20 let (konstrukce)"},
                  ]} />
                  <div style={{ background: C.bg, borderRadius: 6, padding: 10, marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 6, fontFamily: fontSans, fontWeight: 600 }}>ODPISY & DAŇOVÝ ŠTÍT</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 10, fontFamily: font }}>
                      <div><span style={{color: C.dim}}>Odpis rok 1:</span> <b style={{color: C.cyan}}>{fmtCZK(R.yearly[0].depr)}</b></div>
                      <div><span style={{color: C.dim}}>Daň. štít rok 1:</span> <b style={{color: C.green}}>{fmtCZK(R.taxShieldY1)}</b></div>
                      <div><span style={{color: C.dim}}>NPV (po dani):</span> <b style={{color: R.npv >= 0 ? C.green : C.red}}>{fmtCZK(R.npv)}</b></div>
                      <div><span style={{color: C.dim}}>IRR:</span> <b style={{color: C.accentBright}}>{R.irr} %</b></div>
                      <div><span style={{color: C.dim}}>Návratnost po dani:</span> <b style={{color: C.purple}}>{R.pbp || ">30"} let</b></div>
                      <div><span style={{color: C.dim}}>Daň. štít 25 let:</span> <b style={{color: C.green}}>{fmtCZK(R.taxShield25)}</b></div>
                    </div>
                    <div style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>
                      {I.deprMethod === "accelerated"
                        ? "Zrychlené odpisy (§32) přesouvají daňový štít do prvních let → vyšší NPV/IRR a kratší poztaňová návratnost."
                        : "Rovnoměrné odpisy (§31): stejná výše odpisu po celou dobu odpisování."}
                    </div>
                  </div>
                </>}

              </div>
            </div>
          </div>

          {/* ═══ RIGHT PANEL ═══ */}
          <div className="right-panel" style={{ flex: 1, minWidth: 320 }}>
            {/* Chart tabs */}
            <div className="no-print" style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap" }}>
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
              <ChartCard title="Kumulativní Cash Flow (po dani, vč. odpisů)" icon="📈">
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={R.yearly} margin={{top:28,right:16,left:5,bottom:8}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="year" stroke={C.dim} fontSize={10} tickLine={false} />
                    <YAxis stroke={C.dim} fontSize={9} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v=>[fmtCZK(v)]} labelFormatter={l=>`Rok ${l}`} />
                    <Legend wrapperStyle={{fontSize:10}} />
                    <ReferenceLine y={0} stroke={C.dim} strokeWidth={2} />
                    {R.pbp && <ReferenceLine x={R.pbp} stroke={C.green} strokeDasharray="5 5" label={{value:`Návratnost: ${R.pbp} let`,fill:C.green,fontSize:10,position:"top"}} />}
                    {I.bessKwh > 0 && Array.from({length: Math.max(0, Math.ceil(LIFETIME / batteryParams.bessReplYear) - 1)}, (_, i) => (i + 1) * batteryParams.bessReplYear).filter(yr => yr < LIFETIME).map(yr => (
                      <ReferenceLine key={yr} x={yr} stroke={C.red} strokeDasharray="3 3" label={{value:"Výměna baterie",fill:C.red,fontSize:9,position:"insideBottom",offset:12}} />
                    ))}
                    <Bar dataKey="cf" name="Roční Cash Flow (po dani)" fill={C.blue} opacity={0.35} radius={[2,2,0,0]} />
                    <Line dataKey="cumCF" name="Kumulativní CF (po dani)" stroke={C.accentBright} strokeWidth={2.5} dot={false} />
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
                    <Tooltip contentStyle={tooltipStyle} formatter={(v,name) => [name==="30-letý Cash Flow" ? fmtCZK(v) : `${v} let`, name]} labelFormatter={l=>`Cena elektřiny ${l}`} />
                    <Legend wrapperStyle={{fontSize:10}} />
                    <ReferenceLine yAxisId="cf" y={0} stroke={C.dim} strokeWidth={2} />
                    <Bar yAxisId="cf" dataKey="cumCF" name="30-letý Cash Flow">
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
            <ChartCard title="Cash Flow rok 1 – detail (vč. daní a odpisů)" icon="📋">
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
                      { s: "Daně & odpisy (rok 1)", items: [
                        ["Daňový odpis", fmtCZK(R.y1?.depr), C.cyan],
                        ["Daň z příjmu (21 %)", `− ${fmtCZK(R.y1?.tax)}`, C.red],
                        ["Daňový štít z odpisů", fmtCZK(R.taxShieldY1), C.green],
                      ]},
                      { s: "Výsledek", items: [
                        ["Cash Flow rok 1 (hrubý)", fmtCZK(R.y1?.cfPre), C.muted],
                        ["Cash Flow rok 1 (po dani)", fmtCZK(R.y1?.cf), R.y1?.cf > 0 ? C.green : C.red],
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
                    { t: "DEGRADACE", items: [`Rok 1: ${R.y1?.bessDeg}% kapacity`, `Před výměnou: ~${Math.round(Math.max(0.7, 1 - 0.02*(batteryParams.bessReplYear-1))*100)}%`, `Lineární 2%/rok, reset po výměně`], c: C.cyan },
                    { t: "VÝMĚNA", items: [`Každých ${batteryParams.bessReplYear} let (1. ${fmtCZK(batteryParams.bessReplCost)})`, `Cena −10%/rok → ${fmt(batteryParams.pricePerKwhAtRepl)} Kč/kWh v r. ${batteryParams.bessReplYear}`, `Nová baterie → reset degradace`], c: C.accentBright },
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

            {/* ═══ VYSVĚTLIVKY POJMŮ ═══ */}
            <ChartCard title="Vysvětlivky pojmů" icon="📖">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
                {[
                  ["CAPEX", "Celková investiční částka (Capital Expenditure) – FVE, baterie, montáž, projekt. Čistý CAPEX = CAPEX + trafostanice − dotace."],
                  ["OPEX", "Provozní náklady (Operating Expenditure) – servis, údržba, monitoring; zde jako % z CAPEX ročně."],
                  ["LCOE", "Levelized Cost of Energy – průměrné náklady na 1 MWh vlastní elektřiny za celou životnost. Pod cenou nákupu = úspora."],
                  ["NPV", "Čistá současná hodnota – součet budoucích peněžních toků diskontovaných na dnešek (WACC 5 %). Kladná = projekt vydělává."],
                  ["IRR", "Vnitřní výnosové procento – roční výnosnost projektu po dani. Vyšší než cena kapitálu (WACC) = výhodné."],
                  ["WACC", "Vážené náklady kapitálu – diskontní sazba (zde 5 %), kterou se peníze v čase přepočítávají na dnešní hodnotu."],
                  ["Návratnost", "Doba, za kterou kumulovaný čistý peněžní tok (po dani, vč. daňového štítu z odpisů) pokryje investici."],
                  ["Vlastní spotřeba", "Podíl vyrobené elektřiny spotřebované přímo na místě (přímo + z baterie) místo prodeje do sítě."],
                  ["Peak shaving", "Ořezání odebíraného špičkového výkonu z baterie/FVE → nižší platba za rezervovaný příkon."],
                  ["Spot spread / arbitráž", "Rozdíl mezi nízkou a vysokou hodinovou cenou na spotovém trhu, který baterie využívá k zisku."],
                  ["BESS", "Battery Energy Storage System – bateriové úložiště (zde LFP technologie)."],
                  ["Odpisy §31 / §32", "Daňové odpisy: §31 rovnoměrné (stejná částka), §32 zrychlené (vyšší v prvních letech → dřívější daňový štít)."],
                  ["Daňový štít", "Úspora na dani díky odpisům (odpis × sazba daně 21 %). Zrychlené odpisy ho přesouvají do prvních let."],
                ].map(([t, d]) => (
                  <div key={t} style={{ background: C.bg, borderRadius: 6, padding: "8px 10px", borderLeft: `3px solid ${C.accent}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.white, marginBottom: 2 }}>{t}</div>
                    <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.4 }}>{d}</div>
                  </div>
                ))}
              </div>
            </ChartCard>
          </div>
        </div>

        <div style={{ textAlign:"center", marginTop:20, fontSize:9, color:C.dim, fontFamily:font }}>
          ENERGO GROUP · Kalkulátor pro firemní instalace FVE + Baterie v3.3 · Orientační výpočet · Skutečné hodnoty závisí na konkrétních podmínkách projektu · www.energogroup.cz
        </div>
      </div>
    </div>
  );
}
