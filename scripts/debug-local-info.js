/**
 * One-off: dump DOM hints for Local Information on a hotel page.
 * Run: node scripts/debug-local-info.js [url]
 */
const { chromium } = require('playwright');

const url =
  process.argv[2] ||
  'https://www.lhw.com/hotel/Kahala-Yokohama-Japan?rooms=1&numadult1=2&numchild1=0';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  } catch (e) {
    console.log('goto warning:', e.message);
  }
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const section = document.querySelector('section.local-information');
    const pAir = section ? section.querySelector('p.airport') : null;
    const tabs = [...document.querySelectorAll('[role="tab"]')]
      .map((t) => (t.textContent || '').trim())
      .filter(Boolean);
    const stickyA = [...document.querySelectorAll('.sticky-nav-page-wrapper a')].map((a) => ({
      href: a.getAttribute('href'),
      text: (a.textContent || '').trim(),
    }));
    const anyLocal = [...document.querySelectorAll('section[class*="local"]')].map((s) => s.className);
    return {
      href: location.href,
      title: document.title,
      hasMainContent: !!document.querySelector('#main-content'),
      hasLocalSection: !!section,
      sectionClasses: section ? section.className : null,
      airportPreview: pAir ? (pAir.textContent || '').trim().slice(0, 120) : null,
      sectionsMatchingLocal: anyLocal,
      tabs,
      stickyLinksSample: stickyA.slice(0, 25),
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
