/**
 * LHW uses different *subdomains* for each language. Same path and query string,
 * only the host changes:
 *
 *   ENG → www.lhw.com
 *   GER → de.lhw.com
 *   ITA → it.lhw.com
 *   FRE → fr.lhw.com
 *   JAP → jp.lhw.com
 *   SPA → es.lhw.com
 *
 * Example:
 *   https://www.lhw.com/hotel/CORI-Hornbaek-Hotel-Hornbaek-Denmark?rooms=1&...
 *   https://de.lhw.com/hotel/CORI-Hornbaek-Hotel-Hornbaek-Denmark?rooms=1&...
 */

/** @type {Record<string, string>} */
const LANGUAGE_HOSTS = {
  ENG: 'www.lhw.com',
  GER: 'de.lhw.com',
  ITA: 'it.lhw.com',
  FRE: 'fr.lhw.com',
  JAP: 'jp.lhw.com',
  SPA: 'es.lhw.com',
};

/**
 * Normalize language codes from the UI (uppercase, trim).
 * @param {string} code
 * @returns {string}
 */
function normalizeLanguageCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase();
}

/**
 * Hostname for a language button code (e.g. GER → de.lhw.com).
 * @param {string} languageCode
 * @returns {string|null}
 */
function getHostForLanguage(languageCode) {
  const key = normalizeLanguageCode(languageCode);
  return LANGUAGE_HOSTS[key] || null;
}

/**
 * Return a full URL string with the correct lhw.com subdomain for the selected language.
 * Path, query, and hash are kept; only hostname is replaced.
 *
 * @param {string} urlString Any valid https URL on *.lhw.com
 * @param {string} languageCode ENG | GER | ITA | FRE | JAP | SPA
 * @returns {string}
 */
function buildUrlForLanguage(urlString, languageCode) {
  const host = getHostForLanguage(languageCode);
  if (!host) {
    throw new Error(
      `Unknown language code: "${languageCode}". Use one of: ${Object.keys(LANGUAGE_HOSTS).join(', ')}`,
    );
  }

  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!url.hostname.toLowerCase().endsWith('lhw.com')) {
    throw new Error('URL must be on lhw.com (e.g. https://www.lhw.com/hotel/...).');
  }

  url.hostname = host;
  return url.toString();
}

/**
 * Build `…/services-amenities/{segment}` for the same hotel slug as a hotel or subpage URL.
 *
 * @param {string} urlString
 * @param {string} languageCode
 * @param {'dining'|'spa'} segment
 * @returns {string|null}
 */
function buildServicesAmenitiesUrl(urlString, languageCode, segment) {
  let url;
  try {
    url = new URL(buildUrlForLanguage(urlString, languageCode));
  } catch {
    return null;
  }

  const match = url.pathname.match(/^\/hotel\/[^/]+/i);
  if (!match) {
    return null;
  }

  url.pathname = `${match[0]}/services-amenities/${segment}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Build the LHW “Services & Amenities → Dining” URL for the same hotel as a hotel detail URL.
 * Used to read restaurant copy from the dining subpage (e.g. Plumeria Beach House paragraphs),
 * not from the hotel overview tab.
 *
 * @param {string} urlString Hotel page on any *.lhw.com host (path must start with /hotel/{slug})
 * @param {string} languageCode ENG | GER | ...
 * @returns {string|null} Full dining URL, or null if the path does not look like a hotel page
 */
function buildDiningServicesUrl(urlString, languageCode) {
  return buildServicesAmenitiesUrl(urlString, languageCode, 'dining');
}

/**
 * Same pattern as dining, for spa / wellness copy on the spa subpage.
 *
 * @param {string} urlString
 * @param {string} languageCode
 * @returns {string|null}
 */
function buildSpaServicesUrl(urlString, languageCode) {
  return buildServicesAmenitiesUrl(urlString, languageCode, 'spa');
}

/**
 * True when the path is the dining subpage (user pasted a dining deep link).
 * @param {string} urlString
 * @returns {boolean}
 */
function isDiningServicesPath(urlString) {
  try {
    const u = new URL(urlString.trim());
    return /\/services-amenities\/dining\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * True when the path is the spa subpage (user pasted a spa deep link).
 * @param {string} urlString
 * @returns {boolean}
 */
function isSpaServicesPath(urlString) {
  try {
    const u = new URL(urlString.trim());
    return /\/services-amenities\/spa\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Strip `/services-amenities/…` (and anything after `/hotel/{slug}`) so Playwright opens
 * the hotel overview first. Keeps query string when present.
 *
 * @param {string} urlString
 * @param {string} languageCode
 * @returns {string|null}
 */
function buildHotelOverviewUrl(urlString, languageCode) {
  let url;
  try {
    url = new URL(buildUrlForLanguage(urlString, languageCode));
  } catch {
    return null;
  }

  const match = url.pathname.match(/^(\/hotel\/[^/]+)/i);
  if (!match) {
    return null;
  }

  url.pathname = match[1];
  url.hash = '';
  return url.toString();
}

/**
 * After navigation: optional cookie/consent (best-effort).
 * @param {import('playwright').Page} page
 */
async function dismissOptionalCookieBanner(page) {
  const candidates = [
    page.getByRole('button', { name: /accept|agree|ok|allow all|i understand/i }),
    page.locator('[id*="accept" i][role="button"]'),
    page.locator('button:has-text("Accept")'),
  ];
  for (const loc of candidates) {
    try {
      const first = loc.first();
      if (await first.isVisible({ timeout: 1500 })) {
        await first.click({ timeout: 3000 });
        break;
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Navigate the page to the same path on the localized host (Playwright helper).
 * Uses the *current* page URL if you already called page.goto() once.
 *
 * @param {import('playwright').Page} page
 * @param {string} languageCode
 * @returns {Promise<void>}
 */
async function changeLanguage(page, languageCode) {
  const current = page.url();
  if (!current || current === 'about:blank') {
    throw new Error('changeLanguage: page has no URL yet. Call page.goto() first.');
  }
  const target = buildUrlForLanguage(current, languageCode);
  try {
    await page.goto(target, { waitUntil: 'networkidle', timeout: 90_000 });
  } catch {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  }
  await dismissOptionalCookieBanner(page);
}

module.exports = {
  LANGUAGE_HOSTS,
  normalizeLanguageCode,
  getHostForLanguage,
  buildUrlForLanguage,
  buildServicesAmenitiesUrl,
  buildDiningServicesUrl,
  buildSpaServicesUrl,
  buildHotelOverviewUrl,
  isDiningServicesPath,
  isSpaServicesPath,
  dismissOptionalCookieBanner,
  changeLanguage,
};
