const { chromium } = require('playwright');
const { buildGolfServicesUrl } = require('../lib/changeLanguage');
const { scrapeGolfCoursesFromPage } = require('../lib/playwrightRunner');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const base =
    'https://www.lhw.com/hotel/Armancette-st-gervais-les-bains-france?rooms=1&numadult1=2&numchild1=0';
  await page.goto(buildGolfServicesUrl(base, 'ENG'), { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const html = await page.content();
  console.log('golf page has hotel-amenities', html.includes('hotel-amenities'));
  console.log('golf page has info-items', html.includes('info-items'));
  console.log('golf page has Golf Lessons', /golf\s*lessons/i.test(html));
  console.log('golf page has reservation', /only by reservation/i.test(html));
  const courses = await scrapeGolfCoursesFromPage(page);
  console.log('courses', courses.length, courses.map((c) => c.name));

  const structure = await page.evaluate(() => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    return {
      h3s: [...document.querySelectorAll('h3')].map((h) => clean(h.innerText)).slice(0, 20),
      infoItems: [...document.querySelectorAll('.info-items h3')].map((h) => clean(h.innerText)),
      mainLen: document.querySelector('#main-content')?.innerHTML?.length || 0,
    };
  });
  console.log('structure', structure);

  await browser.close();
})();
