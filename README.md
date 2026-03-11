# ENERGO GROUP – Kalkulátor pro firemní instalace FVE + Baterie

Interaktivní finanční kalkulátor návratnosti fotovoltaiky a bateriového úložiště pro firemní segment (C&I).

## Lokální spuštění

```bash
npm install
npm run dev
```

Otevřete http://localhost:5173

## Build pro produkci

```bash
npm run build
```

Výstup je ve složce `dist/`.

---

## Nasazení na Vercel (doporučeno, zdarma)

### Varianta A: Přes GitHub (doporučená)

1. Vytvořte nový repozitář na GitHub.com
2. Nahrajte do něj celou tuto složku:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/VAS-UCET/energo-kalkulator.git
   git push -u origin main
   ```
3. Jděte na [vercel.com](https://vercel.com) a přihlaste se přes GitHub
4. Klikněte **"Add New Project"**
5. Vyberte repozitář `energo-kalkulator`
6. Vercel automaticky detekuje Vite – klikněte **Deploy**
7. Za ~60 sekund máte živou URL (např. `energo-kalkulator.vercel.app`)

### Varianta B: Přes Vercel CLI (bez GitHubu)

```bash
npm install -g vercel
vercel
```

Odpovězte na otázky a za minutu máte URL.

---

## Vložení na web energogroup.cz (iframe)

Po nasazení na Vercel vložte na libovolnou stránku webu:

```html
<iframe
  src="https://energo-kalkulator.vercel.app"
  width="100%"
  height="900"
  frameborder="0"
  style="border: none; border-radius: 12px;"
></iframe>
```

Nebo vytvořte dedikovanou stránku `energogroup.cz/kalkulator` a vložte iframe tam.

---

## Vlastní doména (volitelné)

V nastavení Vercel projektu (Settings → Domains) můžete přidat vlastní subdoménu:
- `kalkulator.energogroup.cz`

Stačí přidat CNAME záznam v DNS vašeho hostingu.

---

## Technologie

- React 18
- Vite 5
- Recharts (grafy)
- Žádný backend – vše běží v prohlížeči klienta
