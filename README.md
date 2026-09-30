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

---

## Sdílený archiv nabídek (Supabase)

Rozpracovaná nabídka se ukládá automaticky v prohlížeči. **Uložené nabídky** jdou do sdíleného archivu v Supabase, takže je vidí celý tým z jakéhokoli počítače.

### 1. Databáze
V Supabase otevřete **SQL Editor → New query**, vložte obsah `supabase/schema.sql` a spusťte. Vytvoří tabulku `public.offers` s RLS (přístup jen pro přihlášené).

### 2. Proměnné prostředí
Ve Vercelu (**Settings → Environment Variables**) nastavte a poté spusťte **Redeploy**:

| Proměnná | Kde ji najít |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` key |

Lokálně stejné hodnoty do `.env.local` (viz `.env.example`). Nikdy nepoužívejte `service_role` key v aplikaci.

### 3. Uživatelské účty
Obchodníkům zakládá účty správce: Supabase → **Authentication → Users → Add user → Create new user** (e-mail + heslo, zaškrtnout *Auto Confirm User*). V aplikaci se přihlásí tlačítkem **Archiv**.
