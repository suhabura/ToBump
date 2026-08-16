# ToBump Mobile

Mobilna aplikacija za organizacijo dogodkov — Expo SDK 57 + Supabase.

## Lokalni zagon

1. Ustvari projekt na [supabase.com](https://supabase.com).
2. V SQL Editorju po vrsti zaženi migracije iz `supabase/` (najprej `schema.sql`, nato ostale `.sql` po potrebi).
3. Kopiraj `.env.example` → `.env` in vnesi:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
4. V Supabase Auth omogoči Email provider.
5. Namesti in zaženi:

```bash
npm install
npx expo start
```

## Web online (EAS Hosting)

Enkratna priprava (Expo račun):

```bash
npm i -g eas-cli
eas login
eas init
```

`eas init` poveže projekt z Expo in v `app.json` doda `extra.eas.projectId`.

Deploy (`.env` mora obstajati — `EXPO_PUBLIC_*` se vgradijo ob exportu):

```bash
# predogled URL
npm run deploy:web

# produkcija
npm run deploy:web:prod
```

Enako ročno:

```bash
npx expo export --platform web
eas deploy --prod
```

Ob prvem `eas deploy` izberi subdomain (npr. `tobump` → `https://tobump.expo.app`).

### Avtomatski deploy z GitHub

Po `eas init` lahko workflow v `.eas/workflows/deploy-web.yml` ob pushu na `master` objavi web (glej [EAS Workflows](https://docs.expo.dev/eas/workflows/get-started/)).

## Mobilna app (kasneje)

```bash
eas build --platform android
eas build --platform ios
```

## Funkcije

- Prijava / registracija / pozabljeno geslo
- Dogodki: ustvari, uredi, pridruži se, vabila, zasebnost, kapaciteta, ponavljanje
- Planner + realtime klepet
- Prijatelji, skupine, obvestila, jezik (EN/SL)
- Prizorišča, kategorije, komercialni filtri
- Trgovina (merchandise) v headerju

## Opombe

- `.env` se ne committa — na EAS se vrednosti berejo iz lokalnega `.env` ob `expo export`.
- Fotografije / Bump feed niso del te aplikacije.
