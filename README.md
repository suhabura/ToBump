# ToBump Mobile

Mobilna aplikacija za organizacijo dogodkov — Expo SDK 57 + Supabase.

## Lokalni zagon

1. Ustvari projekt na [supabase.com](https://supabase.com).
2. V SQL Editorju po vrsti zaženi migracije iz `supabase/` (najprej `schema.sql`, nato ostale `.sql` datoteke po potrebi: recurrence, categories, shop, …).
3. Kopiraj `.env.example` → `.env` in vnesi:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
4. V Supabase Auth omogoči Email provider.
5. Namesti in zaženi:

```bash
npm install
npx expo start
```

## Objava online

### 1) Koda na GitHub

```bash
git remote add origin https://github.com/<tvoj-user>/tobump-mobile.git
git push -u origin master
```

`.env` se **ne** committa (samo `.env.example`).

### 2) Web demo (hitro)

```bash
npx expo export -p web
```

Mapo `dist/` naloži na [Vercel](https://vercel.com), Netlify ali Cloudflare Pages.  
Na hostingu nastavi iste `EXPO_PUBLIC_*` spremenljivke kot v `.env`.

### 3) Mobilna app (Expo Go / store)

```bash
npm i -g eas-cli
eas login
eas init
eas build --platform android
# ali
eas build --platform ios
```

Za testiranje brez store: `eas update` + Expo Go (zahteva EAS project).

## Funkcije

- Prijava / registracija / pozabljeno geslo
- Dogodki: ustvari, uredi, pridruži se, vabila, zasebnost, kapaciteta, ponavljanje (z zaključnim datumom)
- Planner + realtime klepet
- Prijatelji, skupine, obvestila, jezik (EN/SL)
- Prizorišča, kategorije / podkategorije, komercialni filtri
- Trgovina (merchandise) v headerju
- Push token registracija

## Opombe

Fotografije / Bump feed **niso** del te aplikacije.
