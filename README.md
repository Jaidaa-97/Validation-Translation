# LHW translation validator

Small **Node.js** tool with:

- **Express** — web UI + upload API  
- **Playwright** — opens the Leading Hotels of the World (LHW) hotel page, switches locale, reads visible text  
- **xlsx** — reads your `CONTENT` sheet (columns **A–G**)

You can upload an Excel file, pick **ENG / GER / ITA / FRE / JAP / SPA**, and see **Passed / Not Found / Skipped** (and **Failed** for run errors) in a table.

## Excel format

- Workbook must contain a sheet named **`CONTENT`**.
- **Column A** — section / label (for your own reference in the results table).
- **Columns B–G** — translations:

| Column | Language |
|--------|----------|
| B | ENG (English) |
| C | GER (German) |
| D | ITA (Italian) |
| E | FRE (French) |
| F | JAP (Japanese) |
| G | SPA (Spanish) |

If row 1 looks like a header (e.g. column B is `ENG`), it is skipped automatically.

Rows with an **empty expected cell** for the selected language are marked **Skipped**.

To compare the **Local Information** airport line (`p.airport` on the site), put **Local Information** (or **Local info** / **Airport**) in column A for that row. Other rows use main page text only; the airport line is not mixed into their **Actual** column.

## How language switching works

Only the **subdomain** changes; **path and query string stay the same**:

| Code | Example host |
|------|----------------|
| ENG | `www.lhw.com` |
| GER | `de.lhw.com` |
| ITA | `it.lhw.com` |
| FRE | `fr.lhw.com` |
| JAP | `jp.lhw.com` |
| SPA | `es.lhw.com` |

Example (same hotel, different language):

- `https://www.lhw.com/hotel/CORI-Hornbaek-Hotel-Hornbaek-Denmark?rooms=1&numadult1=2&numchild1=0`
- `https://de.lhw.com/hotel/CORI-Hornbaek-Hotel-Hornbaek-Denmark?rooms=1&numadult1=2&numchild1=0`

In the web UI, clicking **ENG / GER / …** updates the URL field automatically. The server also runs `buildUrlForLanguage()` so the opened page always matches the selected language even if the field was not updated.

Helpers in `lib/changeLanguage.js`:

```js
const { buildUrlForLanguage, changeLanguage } = require('./lib/changeLanguage');

const url = buildUrlForLanguage('https://www.lhw.com/hotel/My-Hotel', 'GER');
// → https://de.lhw.com/hotel/My-Hotel

// If you already have a Playwright page on any *.lhw.com URL:
await changeLanguage(page, 'ITA');
```

Edit `LANGUAGE_HOSTS` in `lib/changeLanguage.js` if LHW changes subdomains.

## How text is compared

1. After navigation, the tool reads visible text from `<main>` (or `<body>` if needed).
2. Whitespace is normalized (line breaks / double spaces).
3. For each Excel row, the **expected** string must appear as a **contiguous substring** in that visible text.
4. If it does not appear → **Not Found** (the run continues for all rows).
5. If the Excel cell for that language is empty → **Skipped**.

This is intentionally simple. If copy is split across elements in a way that breaks a single substring match, you may see **Not Found** even when the words exist on the page — in that case you can shorten the expected snippet or extend the matcher later.

## Setup

1. Install **Node.js 18+** (LTS recommended).

2. Install dependencies and Chromium for Playwright:

```bash
cd lhw-translation-validator
npm install
```

`postinstall` runs `npx playwright install chromium`. If it fails (network/proxy), run that command manually once.

## Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

1. Upload your `.xlsx` file.  
2. Choose a language button.  
3. Optionally edit the hotel URL (defaults to the Kahala Yokohama link from your brief).  
4. Click **Run / Compare**.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default `3000`). |
| `DEFAULT_LHW_URL` | Default hotel URL if the form field is empty. |
| `HEADLESS` | Set to `false` to show the browser while debugging (`HEADLESS=false npm start`). |

## Project layout

- `server.js` — Express app, upload handling, `/api/run`  
- `lib/changeLanguage.js` — **`changeLanguage(page, languageCode)`**  
- `lib/excel.js` — reads the `CONTENT` sheet  
- `lib/playwrightRunner.js` — launches Playwright, calls `changeLanguage`, builds results  
- `public/` — simple static UI (`index.html`, `app.js`, `styles.css`)  
- `uploads/` — temporary uploads (created automatically; gitignored)

## Cloudflare / bot checks

LHW uses Cloudflare. If Playwright is blocked in your environment, try:

- Running on your normal home/office network  
- `HEADLESS=false` so the browser is visible (sometimes helps with challenges)  
- Updating Playwright: `npm update playwright` and reinstall browsers  

This is environment-specific; the code stays generic.

## Cursor / AI usage

This repo is a plain Node app: open the folder in **Cursor**, run `npm install` / `npm start`, and use the AI to extend matchers (e.g. per-section CSS selectors), add CSV export, or wire CI — the structure is kept small on purpose.

## License

MIT
