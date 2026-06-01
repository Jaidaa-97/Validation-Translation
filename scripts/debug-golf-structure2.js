const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(
    'https://www.lhw.com/hotel/Armancette-st-gervais-les-bains-france/services-amenities/golf',
    { waitUntil: 'domcontentloaded', timeout: 90000 },
  );
  await page.waitForTimeout(4000);
  const data = await page.evaluate(() => {
    const pick = (el) => String(el?.innerText || el?.textContent || '').trim();
    const titles = [...document.querySelectorAll('h3.golf-course-title')];
    return titles.map((titleEl, i) => {
      const details = titleEl.closest('.details, section, article') || titleEl.parentElement;
      let node = titleEl.closest('section') || titleEl.parentElement;
      const siblings = [];
      while (node) {
        const next = node.nextElementSibling;
        if (!next) break;
        if (next.querySelector('h3.golf-course-title') && next.querySelector('h3.golf-course-title') !== titleEl) break;
        siblings.push({
          cls: next.className?.slice?.(0, 60),
          h2: pick(next.querySelector('h2')).slice(0, 40),
          ps: [...next.querySelectorAll('p')].map((p) => pick(p).slice(0, 100)),
        });
        node = next;
      }
      return {
        i,
        name: pick(titleEl),
        parentCls: details?.className?.slice?.(0, 80),
        siblings: siblings.slice(0, 4),
      };
    });
  });
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
