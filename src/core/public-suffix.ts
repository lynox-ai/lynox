/**
 * Hosts under which names belong to different people, so that allowing the host allows them all.
 * A net, not a fence: no public suffix list is carried, and a platform not listed here is not
 * caught.
 */

/** Second-level labels that, under a two-letter country code, are treated as a public suffix
 *  (`co.uk`, `com.au`, `ac.jp`). One entry per label; add a line to cover another. */
export const PUBLIC_SECOND_LEVEL_LABELS: readonly string[] = [
  'co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'ltd', 'plc',
];

/** Platforms that hand out subdomains to their customers: a store or site there is
 *  `<name>.<platform>`, and the platform alone covers every other customer's. */
export const SHARED_PLATFORM_DOMAINS: readonly string[] = [
  'myshopify.com', 'github.io', 'vercel.app', 'netlify.app', 'pages.dev', 'wixsite.com',
  'squarespace.com', 'web.app', 'herokuapp.com', 'blogspot.com', 'appspot.com', 's3.amazonaws.com',
  'cloudfront.net', 'azurewebsites.net', 'workers.dev', 'fly.dev', 'onrender.com', 'wordpress.com',
  'webflow.io', 'eu.org', 'sites.google.com',
];

/** Whether two labels form `<label from PUBLIC_SECOND_LEVEL_LABELS>.<two-letter country code>`. */
export function isCountrySecondLevel(labels: readonly string[]): boolean {
  return labels.length === 2 && /^[a-z]{2}$/.test(labels[1]!) && PUBLIC_SECOND_LEVEL_LABELS.includes(labels[0]!);
}

/** Whether a lower-case host is itself one of the suffixes above, rather than a name under one. */
export function isSharedSuffix(host: string): boolean {
  return SHARED_PLATFORM_DOMAINS.includes(host) || isCountrySecondLevel(host.split('.'));
}
