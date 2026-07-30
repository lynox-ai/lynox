/**
 * Onboarding Wave 1 — derive a candidate business domain from search results.
 *
 * The Activation Principle (POSITIONING.md): acquire context, don't make the user
 * do work the agent can do. Step-0 now collects the company name, so instead of an
 * empty URL field the onboarding pre-fills a candidate domain the user CONFIRMS with
 * one tap (propose→react). This is a heuristic over search results — NOT a model
 * call (provider-agnostic, no cost) — and it fails GRACEFULLY: if nothing clean
 * surfaces it returns null and the field stays empty (today's manual behaviour).
 * A wrong-but-confirmable candidate is fine; a wrong candidate the user must first
 * delete is worse than empty, so the blocklist is deliberately conservative.
 */

/** Hosts that are never a business's own site: social, directories, marketplaces,
 *  encyclopaedias, job boards, data brokers, review sites, maps. Matched exactly or
 *  as a subdomain. Deliberately broad across markets, not CH-only — a national
 *  directory slipping through is a wrong candidate the user must delete. */
const NON_BUSINESS_HOSTS: readonly string[] = [
  // Social / messaging (global)
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'threads.net', 'snapchat.com',
  'whatsapp.com', 'telegram.org', 't.me', 'vk.com', 'weibo.com', 'line.me',
  // Encyclopaedias / forums / code / publishing
  'wikipedia.org', 'wikimedia.org', 'reddit.com', 'medium.com', 'github.com',
  'quora.com', 'substack.com',
  // Marketplaces / platforms / maps
  'google.com', 'play.google.com', 'bing.com', 'duckduckgo.com', 'amazon.com',
  'ebay.com', 'apple.com', 'openstreetmap.org', 'foursquare.com', 'mapquest.com',
  // Jobs / employer-review
  'indeed.com', 'glassdoor.com', 'kununu.com', 'xing.com',
  // Company-data brokers / registries
  'crunchbase.com', 'bloomberg.com', 'zoominfo.com', 'dnb.com', 'opencorporates.com',
  'northdata.com', 'manta.com', 'thomasnet.com', 'kompass.com', 'wlw.de',
  'companieshouse.gov.uk', 'wko.at', 'firmenabc.at', 'herold.at',
  // Business directories (national)
  'moneyhouse.ch', 'local.ch', 'search.ch', 'zefix.ch', 'gelbeseiten.de',
  'pagesjaunes.fr', 'yell.com', 'yellowpages.com', 'paginegialle.it', 'gulesider.no',
  // Reviews / software-directories
  'trustpilot.com', 'tripadvisor.com', 'g2.com', 'capterra.com', 'clutch.co',
];

/** Directory/review brands that operate under MANY country TLDs (yelp.de, yelp.co.uk,
 *  europages.fr …). Matched when the host is `<brand>.<anything>` — the exact-host
 *  list above cannot enumerate every TLD. */
const NON_BUSINESS_BRANDS: readonly string[] = [
  'yelp', 'europages', 'cylex', 'hotfrog', 'tupalo', 'yellowpages',
  'kompass', 'paginegialle', 'goldenpages',
];

interface DomainResult {
  readonly url: string;
}

/** Extract the registrable host from a URL, lower-cased, `www.` stripped. Null if unparseable. */
function hostOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True if `host` is a blocklisted non-business host — either an exact/subdomain
 *  match, or a multi-TLD directory brand (`yelp.de`, `yelp.co.uk`, `europages.fr`). */
function isNonBusiness(host: string): boolean {
  if (NON_BUSINESS_HOSTS.some(b => host === b || host.endsWith(`.${b}`))) return true;
  // Brand match: the label before the (possibly multi-part) TLD equals a brand.
  const firstLabel = host.split('.')[0];
  return firstLabel !== undefined && NON_BUSINESS_BRANDS.includes(firstLabel);
}

/** Localized search query to surface a business's OWN homepage. The company name
 *  dominates; a language-matched "official website" suffix biases toward the
 *  homepage over news/directories. Unknown locales get the bare name (never an
 *  English suffix that would skew results in a non-English market). */
const OFFICIAL_SITE_SUFFIX: Record<string, string> = {
  en: 'official website',
  de: 'offizielle Website',
  fr: 'site officiel',
  it: 'sito ufficiale',
  es: 'sitio web oficial',
};

export function buildDomainSearchQuery(company: string, lang: string): string {
  const suffix = OFFICIAL_SITE_SUFFIX[lang];
  return suffix ? `${company} ${suffix}` : company;
}

/**
 * Pick the first search result that looks like the business's own website.
 * Returns `https://<host>` (no path, no `www.`) or `null` when nothing clean
 * surfaces in the first `maxScan` results — the caller then leaves the field empty.
 */
export function deriveBusinessDomain(results: readonly DomainResult[], maxScan = 6): string | null {
  for (const r of results.slice(0, maxScan)) {
    const host = hostOf(r.url);
    if (!host) continue;
    if (isNonBusiness(host)) continue;
    // A bare TLD or an IP is not a business site.
    if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
    return `https://${host}`;
  }
  return null;
}
