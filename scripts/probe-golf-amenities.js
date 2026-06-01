const { chromium } = require('playwright');
const { buildUrlForLanguage, buildGolfServicesUrl } = require('../lib/changeLanguage');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: process.env.PW_CHANNEL || undefined,
  });
  const page = await browser.newPage();
  const base =
    'https://www.lhw.com/hotel/Armancette-st-gervais-les-bains-france?rooms=1&numadult1=2&numchild1=0';

  await page.goto(buildUrlForLanguage(base, 'ENG'), { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const btn = page.getByRole('button', { name: /services\s*&\s*amenities/i }).first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('Click SERVICES & AMENITIES');
    await btn.click();
    await page.waitForTimeout(2500);
  }

  const onOverview = await page.evaluate(() => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    return {
      hasAmenities: !!document.querySelector('#hotel-amenities'),
      amenitiesLen: document.querySelector('#hotel-amenities')?.innerHTML?.length || 0,
      infoH3: [...(document.querySelectorAll('#hotel-amenities .info-items h3') || [])].map((h) =>
        clean(h.innerText),
      ),
      golfInBody: /golf\s*lesson|only by reservation|dress\s*code/i.test(clean(document.body.innerText)),
    };
  });
  console.log('overview after SERVICES button', onOverview);

  await page.goto(buildGolfServicesUrl(base, 'ENG'), { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const onGolf = await page.evaluate(() => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const hits = [];
    for (const el of document.querySelectorAll('h2, h3, em, p, div')) {
      const t = clean(el.innerText);
      if (/golf\s*lesson|only by reservation|dress\s*code|handicap/i.test(t) && t.length < 300) {
        hits.push({ tag: el.tagName, class: (el.className || '').slice(0, 40), text: t.slice(0, 120) });
      }
    }
    return {
      url: location.href,
      hasAmenities: !!document.querySelector('#hotel-amenities'),
      hits: hits.slice(0, 25),
    };
  });
  console.log('golf page', JSON.stringify(onGolf, null, 2));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
