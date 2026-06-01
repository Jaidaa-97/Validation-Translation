const { chromium } = require('playwright');
const { buildGolfServicesUrl, buildUrlForLanguage } = require('../lib/changeLanguage');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
  const page = await browser.newPage();
  const base = 'https://www.lhw.com/hotel/Armancette-st-gervais-les-bains-france';

  await page.goto(buildUrlForLanguage(base, 'FRE'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2000);
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button,a')].map((el) => ({
      tag: el.tagName,
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    })).filter((x) => /service|équip|amenit/i.test(x.text)).slice(0, 15),
  );
  console.log('FRE overview service links', buttons);

  await page.goto(buildGolfServicesUrl(base, 'FRE'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2000);

  const detail = await page.evaluate(() => {
    const c = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const sel = (s) => {
      const el = document.querySelector(s);
      return el ? c(el.innerText).slice(0, 200) : null;
    };
    const pinned = {
      golfLessons: sel(
        '#hotel-amenities > section > div:nth-child(4) > section:nth-child(4) > div.row.no-gutters.info-items > div:nth-child(7)',
      ),
      dressCode: sel(
        '#hotel-amenities > section > div:nth-child(4) > section:nth-child(3) > div.row.no-gutters.info-items > div:nth-child(4) > div',
      ),
      handicapMen: sel(
        '#hotel-amenities > section > div:nth-child(4) > section:nth-child(3) > div.row.no-gutters.info-items > div:nth-child(3) > div > p:nth-child(2)',
      ),
      hours: sel(
        '#hotel-amenities > section > div:nth-child(4) > section.course-hours.mt-5 > div.hours',
      ),
    };
    const cards = [];
    for (const h3 of document.querySelectorAll('#hotel-amenities .info-items h3')) {
      const card = h3.closest('div[class*="col-"]') || h3.parentElement;
      cards.push({ h3: c(h3.innerText), text: c(card?.innerText).slice(0, 220) });
    }
    return { pinned, cards, hasAmenities: !!document.querySelector('#hotel-amenities') };
  });
  console.log('FRE golf page', JSON.stringify(detail, null, 2));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
