/**
 * Shopify store hosts, and the reasons the engine gives when it refuses a request to one.
 *
 * A store's Admin API and its OAuth token endpoint live on `<shop>.myshopify.com`. The engine sends
 * there only with a store pass (`store-pass.ts`), which `http_request` mints for a store connected
 * with api_setup action "connect", on a managed instance the control plane has cleared. Every other
 * request to such a host is refused, and each refusal names its own cause: a credential the model
 * sent itself, a self-hosted instance, a part of the instance that is missing, the control plane's
 * answer, a redirect, a Host header, a page fetch, a token fetch. Under all of them, `fetchPinned`
 * refuses every pinned request and redirect hop whose URL or Host header names such a host without
 * a pass.
 *
 * The host is compared the way DNS reads it, not the way the profile map keys it: lowercased and
 * without trailing root dots (`shop.myshopify.com.` is the same store and a different map key).
 * The apex `myshopify.com` counts too.
 */

import { controlPlaneFromEnv, type ExactClearanceRefusal } from './exact-clearance.js';
import type { ToolContext } from './tool-context.js';

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
 * The refusals of a request to a Shopify store, one per cause. Each is model text: it says what
 * happened, whether another try changes anything, and what the user is told. None says Shopify is
 * "temporarily" unavailable, since no refusal here has an end the engine knows of.
 */

/** A request to a store carried a `secret:` reference, while a store pass would be possible. */
export const SHOPIFY_CREDENTIAL_REFERENCE =
  'a request to a Shopify store may not carry a credential reference (secret:…). Remove it and send the request again; the engine attaches the store connection itself.';

/** No control plane: a self-hosted instance, which never gets a store pass. */
export const SHOPIFY_SELF_HOSTED =
  'lynox reaches Shopify stores (*.myshopify.com) only on an instance that lynox runs, and this instance is self-hosted, so nothing was sent. Retrying, another profile, credential or address does not change that. Tell the user that Shopify stores can be reached only on an instance run by lynox.';

/** A managed instance that lacks a part a store pass needs (clearance, binding digest, sidecar, vault). */
export const SHOPIFY_NOT_SET_UP =
  'Shopify is not set up on this instance: a part lynox needs for store requests is missing, so nothing was sent. This is not a problem with the store, a profile or a credential, and retrying does not help. Tell the user that Shopify is not set up on their instance and that lynox has to fix this, not them. Do not offer another way to reach the store.';

/** The control plane did not answer, or asked to wait: the engine asks again after its backoff. */
export const SHOPIFY_UNCONFIRMED =
  'lynox could not confirm that this instance may reach Shopify stores right now, so nothing was sent. Try once more in a few minutes; if it is refused again, tell the user that Shopify cannot be reached from their instance right now and to try again later.';

/** The control plane refused the instance. */
export const SHOPIFY_NOT_CLEARED =
  'lynox has not cleared this instance for Shopify stores right now, so nothing was sent. Retrying does not change that, and do not try to reach the store another way. Tell the user that Shopify is not cleared for their instance right now and that only lynox can clear it.';

/**
 * A redirect from another host to a store. It names no address to send to: the one in the redirect
 * was chosen by whoever answered, and the store connection would be attached to it.
 */
export const SHOPIFY_REDIRECT =
  'the server redirected this request to a Shopify store, and lynox does not follow a redirect to a store, so nothing was sent there. Do not request the address the redirect named; tell the user the page leads to a Shopify store, and ask what they want to read from their own store.';

/** A Host header that names a store while the URL does not. */
export const SHOPIFY_HOST_HEADER =
  'a Host header may not name a Shopify store. Remove the Host header; to reach a store, put its address in the URL.';

/**
 * A page fetch on a store host (web search, watch, api_setup discovery, calendar, connector). It
 * names no way through a store's own domain on purpose: a store's data comes only through the
 * store connection, where containment and the record hold.
 */
export const SHOPIFY_PAGES =
  "lynox does not open pages on Shopify store hosts (*.myshopify.com), public store pages included. Read a connected store's data with http_request to the store's address; the engine attaches its connection.";

/** A token fetch on a store outside the connect flow. */
export const SHOPIFY_FETCH_TOKEN =
  'lynox gets a Shopify store\'s token only through api_setup action "connect", not through fetch_token. Use connect for this store.';

/** The control plane's refusals that a later ask may turn: it did not answer, or asked to wait. */
const CLEARANCE_UNCONFIRMED: ReadonlySet<ExactClearanceRefusal> = new Set([
  'busy', 'rate_limited', 'unreachable', 'timeout', 'server_error', 'no_answer',
]);

/**
 * The refusal for a clearance the control plane did not give. `reason` decides, never the time:
 * a refusal and an unanswered ask both back off for the same 60 s. `backoff` is no cause of its
 * own and reads the cause it holds (`held`); with none known (the backoff ran out between the two
 * reads), it is one to ask again later. An engine without its control plane or its marker, and a
 * marker engine.db could not write, are not set up: that is the instance's, not the answer's.
 * `no_answer` also covers a 4xx without a reason, such as a wrong instance secret; it is read as
 * one to ask again, since the engine cannot tell it from a passing fault of the control plane.
 */
export function clearanceRefusalText(reason: ExactClearanceRefusal, held: ExactClearanceRefusal | null = null): string {
  const cause = reason === 'backoff' ? held : reason;
  if (cause === null || cause === 'backoff') return SHOPIFY_UNCONFIRMED;
  if (cause === 'not_provisioned' || cause === 'marker_unwritable') return SHOPIFY_NOT_SET_UP;
  return CLEARANCE_UNCONFIRMED.has(cause) ? SHOPIFY_UNCONFIRMED : SHOPIFY_NOT_CLEARED;
}

/**
 * Whether this instance could give a request to a Shopify store a pass at all, before anything
 * about the request is read: steps 1, 2 and 6a of `storePassPrecheck` (`tools/builtin/http.ts`), which read no vault
 * and ask nobody. `null` when they hold, else the refusal of the first that fails. The secret
 * check of a request (`agent.ts`) asks it too, so a `secret:` reference to a store is refused
 * with the credential sentence only where a pass is possible, and with this cause where not.
 */
export function storeInstanceRefusal(toolContext: ToolContext | undefined): string | null {
  return storeSetupRefusal(toolContext) ?? storeClearanceHeld(toolContext!);
}

/**
 * Steps 1 and 2: self-hosted (no control plane, so no pass ever), or a managed instance without
 * its clearance, its binding digest or the sidecar, which misses a part only lynox can put in.
 */
export function storeSetupRefusal(toolContext: ToolContext | undefined): string | null {
  if (controlPlaneFromEnv() === null) return SHOPIFY_SELF_HOSTED;
  if (!toolContext?.exactClearance || !toolContext.storeBindingDigest) return SHOPIFY_NOT_SET_UP;
  if (toolContext.shellIsolation.kind !== 'sidecar') return SHOPIFY_NOT_SET_UP;
  return null;
}

/** Step 6a: a refusal of the control plane that still holds, named by its cause. */
export function storeClearanceHeld(toolContext: ToolContext): string | null {
  const clearance = toolContext.exactClearance!;
  return clearance.blockedNow() ? clearanceRefusalText('backoff', clearance.heldRefusal()) : null;
}
