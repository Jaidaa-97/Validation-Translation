const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'demo-assets');
const VIDEO_DIR = path.join(ASSET_DIR, 'videos');
const DEMO_XLSX = path.join(ASSET_DIR, 'demo-translation-content.xlsx');

const APP_URL = process.env.DEMO_APP_URL || 'http://localhost:3002';
const HOTEL_URL =
  process.env.DEMO_HOTEL_URL ||
  'https://www.lhw.com/hotel/Lesante-Cape-Zakynthos-Greece?rooms=1&numadult1=2&numchild1=0';

function ensureDemoWorkbook() {
  fs.mkdirSync(ASSET_DIR, { recursive: true });

  const rows = [
    ['Section', 'ENG', 'GER', 'ITA', 'FRE', 'JAP', 'SPA', 'Special Note'],
    [
      'Restaurant #4 Name',
      'Fiore Fine Dining',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
    [
      'Restaurant #4 Description',
      'The awarded Fiore Fine Dining is a gateway into the regal past and contemporary face of Zakynthos. Enjoy high-end cuisine in a chic locale framed by panoramic views of the surrounding seascape. Internationally renowned classics meet local produce and refined techniques, creating a singularly unique experience of refined gastronomy.',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
    ['Restaurant #4 Hours of Operation', '19:30 - 22:00', '', '', '', '', '', ''],
    ['Restaurant #5 Name', 'Novita Restaurant', '', '', '', '', '', ''],
    ['Restaurant #5 Hours of Operation', '12:00 - 23:00', '', '', '', '', '', ''],
  ];

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'CONTENT');
  XLSX.writeFile(workbook, DEMO_XLSX);
  return DEMO_XLSX;
}

async function addCaption(page, text) {
  await page.evaluate((caption) => {
    let box = document.getElementById('demo-caption');
    if (!box) {
      const style = document.createElement('style');
      style.textContent = `
        #demo-caption {
          position: fixed;
          right: 24px;
          bottom: 24px;
          max-width: 520px;
          z-index: 999999;
          padding: 16px 18px;
          border-radius: 14px;
          color: #fff;
          background: rgba(10, 28, 45, 0.92);
          box-shadow: 0 10px 28px rgba(0,0,0,.25);
          font: 600 20px/1.35 Arial, sans-serif;
        }
      `;
      document.head.appendChild(style);
      box = document.createElement('div');
      box.id = 'demo-caption';
      document.body.appendChild(box);
    }
    box.textContent = caption;
  }, text);
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const demoWorkbook = ensureDemoWorkbook();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1440, height: 1000 },
    },
  });

  const page = await context.newPage();
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await addCaption(page, 'LHW Translation Validator: upload Excel, choose a hotel, and compare against the live site.');
    await pause(2500);

    await page.setInputFiles('#file', demoWorkbook);
    await addCaption(page, 'Step 1: upload the translation Excel file with expected hotel copy.');
    await pause(2000);

    await page.fill('#pageUrl', HOTEL_URL);
    await addCaption(page, 'Step 2: paste the LHW hotel URL. The tool uses this as the live source.');
    await pause(2000);

    await page.click('.lang-btn[data-lang="ENG"]');
    await addCaption(page, 'Step 3: choose a language. This demo validates English first.');
    await pause(1600);

    await page.click('#run-btn');
    await addCaption(page, 'Step 4: Playwright opens the real LHW site and validates dining content and operation hours.');

    await page.waitForSelector('details.language-section', { timeout: 10 * 60 * 1000 });
    await page.waitForFunction(
      () => document.querySelector('#status')?.textContent?.toLowerCase().includes('done'),
      { timeout: 10 * 60 * 1000 },
    );
    await pause(1500);

    await addCaption(page, 'Results are grouped by language with Passed, Not Found, Failed, or Skipped status.');
    await page.locator('details.language-section').first().scrollIntoViewIfNeeded().catch(() => {});
    await pause(2500);

    await addCaption(page, 'The validator matched operation hours by restaurant name, so Fiore uses the correct live hours.');
    await pause(3000);
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();

    if (video) {
      const originalPath = await video.path();
      const finalPath = path.join(VIDEO_DIR, `translation-validator-demo-${Date.now()}.webm`);
      fs.renameSync(originalPath, finalPath);
      console.log(`Demo video saved: ${finalPath}`);
      console.log(`Demo Excel saved: ${demoWorkbook}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
