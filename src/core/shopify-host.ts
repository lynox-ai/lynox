/**
 * Shopify store hosts, which this engine does not reach for now.
 *
 * A store's Admin API and its OAuth token endpoint live on `<shop>.myshopify.com`. While Shopify
 * connections are reworked, the engine sends nothing there: every `http_request` and bulk request
 * to such a host is refused (with or without a profile, whatever the request carries, since a
 * credential can sit in any header or the body), and so are a `secret:` reference in a request to
 * it and a token exchange with it, each with {@link SHOPIFY_UNAVAILABLE} as the reason. Under all
 * of them, `fetchPinned` refuses every pinned request and redirect hop whose URL or Host header
 * names such a host.
 *
 * The host is compared the way DNS reads it, not the way the profile map keys it: lowercased and
 * without trailing root dots (`shop.myshopify.com.` is the same store and a different map key).
 * The apex `myshopify.com` counts too.
 */

const SHOPIFY_STORE_DOMAIN = 'myshopify.com';

/** The host as DNS reads it: lowercased, trailing root dots removed. */
export function normalizeHostForMatch(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

/** `true` when `hostname` (a URL's hostname, not a URL) is a Shopify store host. */
export function isShopifyAdminHost(hostname: string): boolean {
  const h = normalizeHostForMatch(hostname);
  return h === SHOPIFY_STORE_DOMAIN || h.endsWith(`.${SHOPIFY_STORE_DOMAIN}`);
}

/** `true` when `url` parses and its host is a Shopify store host. An unparseable URL is `false`. */
export function isShopifyAdminUrl(url: string): boolean {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return false; }
  return isShopifyAdminHost(hostname);
}

/**
 * The reason every refusal gives. It tells the model and the user that Shopify as a whole is not
 * reachable for now, so that neither takes it for a broken profile or a wrong credential.
 */
export const SHOPIFY_UNAVAILABLE =
  'Shopify cannot be connected in lynox at the moment: lynox refuses requests to Shopify stores (*.myshopify.com) while it reworks how Shopify connections are set up. This is not a problem with the api_profile or a credential, so do not change either, do not retry, and do not try to reach the store another way; tell the user that Shopify is temporarily unavailable in lynox.';
