/**
 * Property-search flow for the LHW translation validator.
 *
 * What this module does, end-to-end:
 *   1. Open the localized LHW homepage (e.g. https://de.lhw.com/ for GER).
 *   2. Wait for `#propertySearchBar`'s location input and type the hotel name.
 *      The hotel name is derived from the hotel URL slug — see
 *      `derivePropertySearchQueryFromUrl(...)`.
 *   3. Click the submit anchor (`.col-button > a`) and wait for navigation
 *      to the /property-search results page.
 *   4. Read the first article's `p.hotel-desc` text and return it.
 *
 * `runPropertySearchAndReadHotelDesc(...)` is the orchestrator; the small
 * per-step helpers below are exported so they can be reused or unit-tested.
 *
 * The runner (`lib/playwrightRunner.js`) only calls this flow when the uploaded
 * Excel has a row whose column A says "Property Search" AND that row has
 * content for the selected language. Empty cells stay "Skipped".
 */

const { normalizeText } = require('./textNormalize');
const {
  buildUrlForLanguage,
  dismissOptionalCookieBanner,
} = require('./changeLanguage');

/**
 * Selectors pinned to the structure of LHW's homepage / property-search results page.
 * Update these here if the markup changes — everything else stays the same.
 */
const SELECTORS = Object.freeze({
  searchInput:
    '#propertySearchBar > div > div.row.search-details > div.col.col-location > input',
  searchSubmit:
    '#propertySearchBar > div > div.row.search-details > div.col.col-button > a',
  hotelDesc:
    '#search-results > article > div > div.col-12.col-lg-7 > div > p.hotel-desc',
});

/** All timeouts in milliseconds. Tuned for slowish CDN responses. */
const TIMEOUTS = Object.freeze({
  navigation: 90_000,
  networkIdle: 15_000,
  searchInputVisible: 20_000,
  searchSubmitVisible: 10_000,
  resultsUrl: 40_000,
  hotelDescAttached: 20_000,
  innerText: 15_000,
  shortClick: 5_000,
  fill: 10_000,
});

const COUNTRY_SUFFIXES = Object.freeze([
  ['United', 'Arab', 'Emirates'],
  ['United', 'Kingdom'],
  ['United', 'States'],
  ['Saudi', 'Arabia'],
  ['South', 'Africa'],
  ['Costa', 'Rica'],
  ['Sri', 'Lanka'],
  ['Czech', 'Republic'],
  ['Croatia'],
  ['Denmark'],
  ['France'],
  ['Germany'],
  ['Greece'],
  ['Italy'],
  ['Japan'],
  ['Mexico'],
  ['Portugal'],
  ['Spain'],
  ['Switzerland'],
  ['Thailand'],
  ['Turkey'],
]);

/**
 * Tiny logger so progress lines stand out in the server console.
 * @param {string} message
 */
function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[Property Search] ${message}`);
}

/**
 * True when the Excel row's column A indicates the property-search flow.
 *
 * Matches "Property Search", "property  search", "PROPERTY SEARCH", etc.
 *
 * @param {string} label
 * @returns {boolean}
 */
function isPropertySearchSectionLabel(label) {
  const s = normalizeText(label);
  if (!s) {
    return false;
  }
  return /property\s*search/i.test(s);
}

function suffixMatches(parts, suffix) {
  if (suffix.length > parts.length) {
    return false;
  }
  const start = parts.length - suffix.length;
  return suffix.every((part, i) => part.toLowerCase() === parts[start + i].toLowerCase());
}

function stripTrailingLocationFromHotelSlugParts(parts) {
  for (const country of COUNTRY_SUFFIXES) {
    if (!suffixMatches(parts, country)) {
      continue;
    }
    // LHW hotel slugs usually end with "...-{City}-{Country}". Remove the country
    // plus one city token, but only if at least two words of hotel name remain.
    const end = parts.length - country.length - 1;
    if (end >= 2) {
      return parts.slice(0, end);
    }
  }
  return parts;
}

/**
 * Derive a human-friendly hotel name from a hotel-detail or property-search URL.
 *
 * Examples:
 *   https://www.lhw.com/hotel/Kahala-Yokohama-Japan?…    → "Kahala Yokohama Japan"
 *   https://de.lhw.com/hotel/CORI-Hornbaek-Hotel-…       → "CORI Hornbaek Hotel"
 *   https://www.lhw.com/property-search/My_Hotel+Name    → "My Hotel Name"
 *
 * @param {string} urlString
 * @returns {string}
 */
function derivePropertySearchQueryFromUrl(urlString) {
  try {
    const raw = String(urlString || '').trim();

    const propertySearchMatch = raw.match(/\/property-search\/([^/?#]+)/i);
    if (propertySearchMatch) {
      return decodeURIComponent(propertySearchMatch[1])
        .replace(/\+/g, ' ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const hotelMatch = raw.match(/\/hotel\/([^/?#]+)/i);
    if (!hotelMatch) {
      return '';
    }

    const slug = decodeURIComponent(hotelMatch[1]);
    const parts = slug.split('-').filter(Boolean);

    const withoutLocation = stripTrailingLocationFromHotelSlugParts(parts);
    if (withoutLocation.length !== parts.length) {
      return withoutLocation.join(' ');
    }

    const hotelIdx = parts.findIndex((p) => /^hotel$/i.test(p));
    if (hotelIdx > 0) {
      return parts.slice(0, hotelIdx + 1).join(' ');
    }
    if (parts.length >= 5) {
      return parts.slice(0, parts.length - 2).join(' ');
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

/**
 * Spot common Cloudflare / "you have been blocked" pages so we don't compare junk.
 * @param {string} text
 * @returns {boolean}
 */
function isLikelyBotBlockPage(text) {
  const t = normalizeText(text).toLowerCase();
  if (t.length < 20) {
    return false;
  }
  return (
    t.includes('you have been blocked') ||
    (t.includes('unable to access') && t.includes('lhw')) ||
    (t.includes('access denied') && t.includes('lhw')) ||
    t.includes('zugriff verweigert') ||
    t.includes('zugriff nicht möglich') ||
    (t.includes('gesperrt') && t.includes('lhw'))
  );
}

/**
 * Step 1: open the localized LHW homepage (e.g. de.lhw.com for GER) on the given page.
 *
 * @param {import('playwright').Page} page
 * @param {string} languageCode
 * @returns {Promise<string>} the URL that was opened
 */
async function openLocalizedHomepage(page, languageCode) {
  const homeUrl = buildUrlForLanguage('https://www.lhw.com/', languageCode);
  log(`Step 1: opening localized homepage → ${homeUrl}`);
  await page.goto(homeUrl, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUTS.navigation,
  });
  await dismissOptionalCookieBanner(page);
  await page.locator(SELECTORS.searchInput).first().waitFor({ state: 'visible', timeout: TIMEOUTS.searchInputVisible }).catch(() => {});
  await page.waitForTimeout(400);
  return homeUrl;
}

/**
 * Step 2: wait for the #propertySearchBar location input and type the hotel name.
 *
 * @param {import('playwright').Page} page
 * @param {string} hotelName
 * @returns {Promise<boolean>} true if the input was filled, false if it never appeared
 */
async function typeHotelNameIntoPropertySearch(page, hotelName) {
  log(`Step 2: typing hotel name into property-search input → "${hotelName}"`);
  const input = page.locator(SELECTORS.searchInput).first();
  try {
    await input.waitFor({
      state: 'visible',
      timeout: TIMEOUTS.searchInputVisible,
    });
  } catch {
    log('   property-search input was not visible in time — aborting flow.');
    return false;
  }

  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: TIMEOUTS.shortClick }).catch(() => {});
  await input.fill('', { timeout: 2_000 }).catch(() => {});
  await input.fill(hotelName, { timeout: TIMEOUTS.fill });
  return true;
}

/**
 * Step 3: click the search submit anchor and wait for navigation to /property-search.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true when the click happened (URL may still be off if the page is slow)
 */
async function clickPropertySearchSubmit(page) {
  log('Step 3: clicking the search submit button (#propertySearchBar .col-button > a)');
  const submitBtn = page.locator(SELECTORS.searchSubmit).first();
  try {
    await submitBtn.waitFor({
      state: 'visible',
      timeout: TIMEOUTS.searchSubmitVisible,
    });
  } catch {
    log('   submit button was not visible in time — aborting flow.');
    return false;
  }
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});

  // Race the navigation with the click so we don't miss a fast redirect.
  await Promise.all([
    page
      .waitForURL(/property-search/i, { timeout: TIMEOUTS.resultsUrl })
      .catch(() =>
        log('   did not see /property-search in URL within timeout — continuing anyway.'),
      ),
    submitBtn.click({ timeout: 10_000 }),
  ]);

  await page
    .locator(SELECTORS.hotelDesc)
    .first()
    .waitFor({ state: 'attached', timeout: TIMEOUTS.hotelDescAttached })
    .catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

/**
 * Step 4: read the first article's `p.hotel-desc` from the property-search results page.
 *
 * Falls back to `textContent` if `innerText` is empty (hidden tabs, lazy rendering).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readFirstHotelDescription(page) {
  log(`Step 4: reading description from ${SELECTORS.hotelDesc}`);
  const desc = page.locator(SELECTORS.hotelDesc).first();
  await desc
    .waitFor({ state: 'attached', timeout: TIMEOUTS.hotelDescAttached })
    .catch(() => {});

  let raw = await desc
    .innerText({ timeout: TIMEOUTS.innerText })
    .catch(() => '');

  if (!normalizeText(raw)) {
    raw = await desc
      .evaluate((el) => (el && el.textContent ? el.textContent : ''))
      .catch(() => '');
  }
  return String(raw || '').trim();
}

/**
 * Orchestrate the whole property-search flow in a NEW tab so the main hotel-overview
 * page used by the runner is left untouched.
 *
 * Returns:
 *   - `text`       : the captured `p.hotel-desc` text (empty string on failure)
 *   - `resultUrl`  : URL of the page we ended on (e.g. /property-search/…)
 *   - `query`      : the hotel-name string we typed into the search input
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} hotelPageUrl     hotel or property-search URL (only used to derive the query)
 * @param {string} languageCode     ENG | GER | ITA | FRE | JAP | SPA
 * @returns {Promise<{ text: string, resultUrl: string, query: string }>}
 */
async function runPropertySearchAndReadHotelDesc(context, hotelPageUrl, languageCode) {
  const empty = { text: '', resultUrl: '', query: '' };

  const query = derivePropertySearchQueryFromUrl(hotelPageUrl);
  if (!normalizeText(query)) {
    log('skipped: could not derive a hotel-name query from the URL.');
    return { ...empty, query: '' };
  }

  log(`starting flow (language=${languageCode}, query="${query}")`);

  /** @type {import('playwright').Page | null} */
  let page = null;
  try {
    page = await context.newPage();
    await openLocalizedHomepage(page, languageCode);

    const typed = await typeHotelNameIntoPropertySearch(page, query);
    if (!typed) {
      return { ...empty, query };
    }

    const clicked = await clickPropertySearchSubmit(page);
    if (!clicked) {
      return { ...empty, query };
    }

    const text = await readFirstHotelDescription(page);
    const resultUrl = page.url() || '';

    if (isLikelyBotBlockPage(text)) {
      log('results page looked like a bot-block page — returning empty.');
      return { text: '', resultUrl, query };
    }

    if (!normalizeText(text)) {
      log('finished but `p.hotel-desc` was empty.');
      return { text: '', resultUrl, query };
    }

    log(
      `done. captured ${text.length} chars: "${normalizeText(text).slice(0, 120)}${
        text.length > 120 ? '…' : ''
      }"`,
    );
    return { text, resultUrl, query };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`flow errored: ${message}`);
    return { ...empty, query };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

module.exports = {
  SELECTORS,
  TIMEOUTS,
  isPropertySearchSectionLabel,
  derivePropertySearchQueryFromUrl,
  isLikelyBotBlockPage,
  openLocalizedHomepage,
  typeHotelNameIntoPropertySearch,
  clickPropertySearchSubmit,
  readFirstHotelDescription,
  runPropertySearchAndReadHotelDesc,
};
