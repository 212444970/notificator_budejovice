# Notifikátor dostupnosti bytů – Rezidence u Sv. Eliáše

Jednou denně navštíví https://rezidencehury.cz/cenik/, přečte aktuální
dostupnost bytů (1KK / 2KK / 3KK...), porovná ji s předchozím stavem
a pokud se něco změnilo (byt byl rezervován, prodán, uvolněn nebo
přibyl do nabídky), pošle e-mail ve formátu:

```
Změna v nabídce bytu - rezervováno 1KK
Počet volných 1KK 3/50
Počet volných 2KK 25/80
Počet volných 3KK 12/30
```

## Jak to funguje

- Stránka je z části vykreslovaná JavaScriptem a byty se dotahují
  postupně scrollováním (infinite scroll) – proto skript používá
  headless prohlížeč (Playwright/Chromium), ne obyčejný HTTP request.
- Stav se ukládá do `state.json`, aby šlo příští den poznat, co se
  změnilo. Soubor musí přežít mezi jednotlivými spuštěními – proto je
  potřeba na Railway připojit **Volume**.
- E-mail se posílá přes tvůj Gmail účet (Nodemailer + SMTP), takže
  nic dalšího není potřeba zakládat.

## Nasazení na Railway

1. **Vytvoř nový projekt na Railway** a nahraj tuto složku (buď přes
   GitHub repozitář, nebo `railway up` z CLI). Railway automaticky
   pozná `Dockerfile` a použije ho k buildu.

2. **Přidej Volume:**
   - V nastavení služby → záložka *Volumes* → *New Volume*
   - Mount path: `/data`
   - Tím se `state.json` uloží trvale mezi jednotlivými běhy.

3. **Nastav proměnné prostředí** (Service → Variables):
   ```
   GMAIL_USER=tvuj.email@gmail.com
   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
   TO_EMAIL=jan.verner@gmail.com
   STATE_FILE=/data/state.json
   ```
   `GMAIL_APP_PASSWORD` NENÍ tvoje běžné heslo do Gmailu. Vygeneruješ
   ho zde (musíš mít zapnuté dvoufázové ověření):
   https://myaccount.google.com/apppasswords

4. **Nastav Cron Schedule:**
   - Service → Settings → *Cron Schedule*
   - Např. `0 7 * * *` = každý den v 7:00 UTC (v létě 9:00, v zimě
     8:00 tvého času)
   - Railway pak jednou denně spustí kontejner, ten proběhne (spustí
     `node scrape-and-notify.mjs`) a ukončí se.

5. **Deploy** a zkontroluj logy prvního běhu (Service → Deployments →
   Logs). První běh pouze uloží počáteční stav a **žádný e-mail
   neposílá** (nemá s čím porovnávat) – to je záměr, aby první
   spuštění neposlalo falešnou notifikaci o "změně".

## Lokální test (volitelné)

```bash
npm install
npx playwright install --with-deps chromium
GMAIL_USER=... GMAIL_APP_PASSWORD=... STATE_FILE=./state/state.json node scrape-and-notify.mjs
```

## Důležité poznámky

- Skript má bezpečnostní pojistku: pokud se z nějakého důvodu podaří
  načíst méně než 10 bytů (např. web změnil strukturu a parser
  přestal fungovat), skript skončí chybou a **nic neuloží ani
  neodešle** – takže se nemůže stát, že by kvůli chybě parsování
  přišel e-mail s nesmyslnými čísly.
- Po prvním ostrém běhu doporučuju zkontrolovat obsah `state.json`
  (na Volume) a porovnat součet bytů s číslem "XXX vyhovujících bytů"
  na webu, jestli sedí – kdyby web během roku změnil layout stránky,
  bude potřeba upravit `parseListings()` ve `scrape-and-notify.mjs`.
- Pokud web přidá nové budovy/dispozice (např. 4KK), skript je
  zohlední automaticky, žádná úprava kódu není potřeba.
