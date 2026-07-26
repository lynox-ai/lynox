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
 *  encyclopaedias, job boards, data brokers. A result on one of these is skipped. */
const NON_BUSINESS_HOSTS: readonly string[] = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'wikipedia.org', 'wikimedia.org',
  'xing.com', 'indeed.com', 'glassdoor.com', 'kununu.com', 'crunchbase.com',
  'bloomberg.com', 'zoominfo.com', 'dnb.com', 'yelp.com', 'tripadvisor.com',
  'google.com', 'bing.com', 'duckduckgo.com', 'amazon.com', 'ebay.com',
  'medium.com', 'reddit.com', 'github.com', 'apple.com', 'play.google.com',
  'moneyhouse.ch', 'local.ch', 'search.ch', 'zefix.ch', 'northdata.com',
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

/** True if `host` is (or is a subdomain of) a blocklisted non-business host. */
function isNonBusiness(host: string): boolean {
  return NON_BUSINESS_HOSTS.some(b => host === b || host.endsWith(`.${b}`));
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
