/**
 * The bootstrap-hint catalogue, as code.
 *
 * This is a text the engine writes into the model's briefing — the list of
 * external APIs it may offer to set up, plus the auth flows it must and must
 * not propose. It used to live in `data/suggested-apis.json` and be read at
 * boot.
 *
 * **It never arrived.** The production image copies `node_modules`, `dist`,
 * `package.json`, the web UI and the entrypoint — not `data/`. So in every
 * container (managed hosting, and every self-host via Compose) the read
 * failed, the reader returned `''`, and the model was briefed with no
 * catalogue at all. Silently: no log, no metric, no failing test, because the
 * tests run from `src/` and resolve `../../data/` to the copy in the
 * repository — the one no deployment loads. Meanwhile `package.json` `files`
 * did list `data/`, so the npm path shipped it and the container did not, and
 * nothing compared the two.
 *
 * The fix is not "ship the file too". It is that **the catalogue can no longer
 * go missing on its own.** A file read has a failure mode the code treats as
 * normal — absent is indistinguishable from deliberately empty — which is
 * precisely why four months passed without anyone noticing. A constant compiled
 * into `dist/` cannot be selectively absent: if it is gone the module does not
 * load, and that breaks far more than a list of hints. One home instead of
 * two, and one that cannot quietly evaporate.
 *
 * ⚠ **What this does NOT buy, because the first draft of this comment claimed
 * it and a review refuted it:** it is not a hardening, and nothing here should
 * be cited as one. The draft argued that a data file is an editable input and
 * that a constant is not. The reason that does not follow is in the Dockerfile
 * and needs no more than reading it: the production stage copies `dist/` with
 * `--chown=lynox:lynox` and then sets `USER lynox`, so the built module sits in
 * a tree owned by the account the engine runs under. Whatever holds for a file
 * beside it holds for the module too. The move changes where the text lives,
 * not what can reach it. If you want that second property, it is a separate
 * piece of work with its own measurement — this is not it, and a later reader
 * should not restore the claim because this file sounds like it earned one.
 *
 * ⚠ Its neighbour {@link ./oauth-presets.ts} argues that the OAuth preset
 * register must not come from a file, and draws a ranking while doing so: an
 * env-var opt-out is "right for a list of hints the model may read" and wrong
 * for presets. That ranking is correct and stands — a preset decides which site
 * a user is sent to and hands consent to, enforced by host validation; this is
 * hint text the model is told to ask about before acting on. This module moved
 * for a different reason than that one did, so do not read the move as the
 * preset argument winning a second case. Its ARGUMENT is untouched; its wording
 * changed here only where it described this catalogue's old mechanism.
 *
 * There is no `schema_version` here. It was a handshake between a file and a
 * parser that could disagree about its format; a constant and its type cannot.
 */

/** One entry in either list — the ones the model may offer, and the ones it may only act on. */
export interface SuggestedApi {
  /** Stable slug, lowercase; not shown to the model. */
  readonly id: string;
  /** Shown to the model and the user. */
  readonly name: string;
  /** Free-text grouping, e.g. `accounting / invoicing`. */
  readonly category: string;
  /**
   * The page `api_setup` action=bootstrap is pointed at. Load-bearing: the
   * auth shape and endpoints are extracted from THIS page at bootstrap time,
   * not from anything recorded here — so it has to be a page that documents
   * them, not a marketing landing page.
   */
  readonly docs_url: string;
  /**
   * How the provider authenticates, as a label for the model. It is read by a
   * human and rendered into prose; nothing branches on it.
   */
  readonly auth_type: string;
  /** Why a user would want it, one sentence. */
  readonly value_prop: string;
}

export interface SuggestedApiCatalog {
  /** Auth flows `api_setup` can actually carry out today. */
  readonly supported_auth_flows: readonly string[];
  /** Flows it cannot — named so the model does not offer them. */
  readonly not_supported_auth_flows: readonly string[];
  /** Categories the model must not bring up on its own. */
  readonly do_not_proactively_suggest: readonly string[];
  /** Public APIs the model may OFFER when they fit the user's question. */
  readonly suggested_apis: readonly SuggestedApi[];
  /**
   * Providers the model is told to set up only once the USER has named one.
   *
   * ⚠ Told, not prevented. Nothing downstream enforces it: `api_setup` takes
   * any `docs_url` the model passes, and the model could reach these providers
   * by hand-writing a profile or by reading the docs itself. The real friction
   * is that it cannot finish without a credential the user supplies through
   * `ask_secret`. Read this list as an instruction with a lookup attached, and
   * do not cite it as a control.
   *
   * Two lists rather than one, because a single list cannot say both things.
   * `do_not_proactively_suggest` forbids raising an API that moves production
   * billing, customer records or live financial state unprompted; bexio,
   * HubSpot, WooCommerce and Shopware are squarely that. Notion, Airtable and
   * WordPress are NOT — they are here by choice, because a workspace, a base
   * and a website are the user's own material and offering to wire them
   * unprompted is presumptuous rather than dangerous. Rendering any of them
   * under the other list's heading would have called them free, which none of
   * them is.
   *
   * Entry bar, and it is the one Shopify sits outside: the user must be able
   * to create the credential THEMSELVES, in their own account, and the engine
   * must be able to attach it. See the note below the constant.
   *
   * Each `value_prop` names the API's own host, or says the user supplies it.
   * That is not decoration: `api_setup` action=bootstrap derives `base_url`
   * from the DOCS host, and for all seven of these the docs host is not the
   * API host — for WordPress, WooCommerce and Shopware there is no fixed host
   * at all, because the API is the user's own site. Three of them (bexio,
   * Notion, Airtable) additionally get an advisory note from bootstrap's
   * parent-domain host scan, but the drafted `base_url` is wrong in every case:
   * the scan only appends "verify before swapping", it never swaps.
   */
  readonly connect_when_user_asks: readonly SuggestedApi[];
}

export const SUGGESTED_API_CATALOG: SuggestedApiCatalog = Object.freeze({
  supported_auth_flows: Object.freeze([
    "none (public, no key)",
    "api_key in custom header (e.g. X-Api-Key)",
    "api_key in query parameter",
    "bearer token in Authorization header",
    "basic auth (user/pass or pre-encoded base64)",
    "oauth2 client_credentials grant (server-to-server, no browser redirect)",
    "oauth2 refresh_token grant (if a refresh token is already held in the vault)",
    "oauth2 authorization_code grant for a provider with a built-in preset (auth.oauth.preset_id; api_setup action=connect gives the user the sign-in link)",
  ]),
  not_supported_auth_flows: Object.freeze([
    "oauth2 authorization_code grant with browser-redirect / callback-URL for a provider WITHOUT a built-in preset (cannot be bootstrapped today)",
  ]),
  do_not_proactively_suggest: Object.freeze([
    "payment providers (Stripe, PayPal, Adyen, etc.) — require explicit user-initiated setup",
    "cloud / hosting / infrastructure providers (Hetzner, AWS, GCP, Azure, Cloudflare account API) — destructive-action risk",
    "any API that mutates production billing, customer records, or live financial state without the user explicitly asking to wire it",
  ]),
  suggested_apis: Object.freeze([
    Object.freeze({
      id: "hackernews",
      name: "Hacker News (Algolia)",
      category: "search / community",
      docs_url: "https://hn.algolia.com/api",
      auth_type: "none",
      value_prop: "Hacker News full-text search across stories + comments. Public API, no key.",
    }),
    Object.freeze({
      id: "github",
      name: "GitHub REST API (public read)",
      category: "code / repos",
      docs_url: "https://docs.github.com/en/rest",
      auth_type: "none",
      value_prop: "Public repos, releases, issues, search. Unauthenticated 60 req/h per IP; a personal-access-token bumps it to 5000/h.",
    }),
    Object.freeze({
      id: "npm",
      name: "npm Registry",
      category: "code / package metadata",
      docs_url: "https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md",
      auth_type: "none",
      value_prop: "Public npm package metadata: versions, latest, dist-tags. No key for read access.",
    }),
    Object.freeze({
      id: "wikipedia",
      name: "Wikipedia (MediaWiki API)",
      category: "knowledge",
      docs_url: "https://www.mediawiki.org/wiki/API:Main_page",
      auth_type: "none",
      value_prop: "Wikipedia article summaries, search, full text. No key. Per-language hosts (en./de./fr./...).",
    }),
    Object.freeze({
      id: "arxiv",
      name: "arXiv",
      category: "research / papers",
      docs_url: "https://info.arxiv.org/help/api/index.html",
      auth_type: "none",
      value_prop: "arXiv preprint search + metadata. Atom XML responses. No key, ~3-second rate-limit between requests.",
    }),
    Object.freeze({
      id: "open-meteo",
      name: "Open-Meteo",
      category: "weather",
      docs_url: "https://open-meteo.com/en/docs",
      auth_type: "none",
      value_prop: "Free weather forecasts + historical reanalysis. Lat/lon based, metric defaults. No key for non-commercial / low-volume use.",
    }),
    Object.freeze({
      id: "frankfurter",
      name: "Frankfurter (ECB FX rates)",
      category: "currency / finance",
      docs_url: "https://frankfurter.dev/",
      auth_type: "none",
      value_prop: "ECB-sourced foreign-exchange rates, daily + historical timeseries back to 1999. Open-source, no key.",
    }),
    Object.freeze({
      id: "restcountries",
      name: "REST Countries",
      category: "geography / reference",
      docs_url: "https://restcountries.com/",
      auth_type: "none",
      value_prop: "Country metadata: ISO codes, capital, currency, languages, region, neighbors. Community-maintained, no key.",
    }),
    Object.freeze({
      id: "nager-date",
      name: "Nager.Date (public holidays)",
      category: "calendar / scheduling",
      docs_url: "https://date.nager.at/Api",
      auth_type: "none",
      value_prop: "Public-holiday calendar for 100+ countries incl. DACH with per-region (Bundesland / Kanton) granularity. No key. Useful for holiday-aware scheduling + SLA business-day calculations.",
    }),
    Object.freeze({
      id: "vatcomply",
      name: "VATcomply (EU VAT + IBAN + FX)",
      category: "B2B / EU compliance",
      docs_url: "https://www.vatcomply.com/documentation",
      auth_type: "none",
      value_prop: "Validate EU VAT numbers via VIES, decode IBANs, fetch ECB FX rates. No key. DACH/EU-relevant for B2B invoicing flows.",
    }),
  ]),
  connect_when_user_asks: Object.freeze([
    Object.freeze({
      id: "bexio",
      name: "bexio",
      category: "accounting / invoicing (CH)",
      docs_url: "https://docs.bexio.com/",
      auth_type: "oauth2",
      value_prop: "Swiss accounting: contacts, invoices, quotes, projects. API base is https://api.bexio.com/2.0/ (not the docs host); send Accept: application/json. Connect with this engine's built-in bexio OAuth provider — no bootstrap; create the profile directly: auth.type \"oauth2\", auth.oauth {preset_id: \"bexio\", scope with the read scopes needed (e.g. contact_show kb_invoice_show), client_id_key and client_secret_key naming vault entries for the id and secret of the app the user registered with bexio}, and auth.vault_keys listing those same two names; then api_setup connect gives the user a sign-in link. Read scopes only. bexio ends a connection after a year without use; the user then connects again. A Personal Access Token is the fallback; say first that bexio limits it to 60 days, gives it full access to the company's data, and means it \"strictly\" for personal use.",
    }),
    Object.freeze({
      id: "notion",
      name: "Notion",
      category: "notes / databases",
      docs_url: "https://developers.notion.com/reference/intro",
      auth_type: "bearer",
      value_prop: "Notion pages and databases: read, create, update. API base is https://api.notion.com/v1/. The user creates an internal connection in Notion's developer portal and then shares each page with it from the page's ••• menu; without that sharing step the connection sees nothing. The token goes in the Authorization header as a Bearer token and every request also needs a Notion-Version header. No redirect.",
    }),
    Object.freeze({
      id: "hubspot",
      name: "HubSpot",
      category: "CRM / contacts",
      docs_url: "https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview",
      auth_type: "bearer",
      value_prop: "HubSpot CRM: contacts, companies, deals, tickets. API base is https://api.hubapi.com/ — a different domain from the docs, so it has to be set by hand. The user creates a private app in their own HubSpot account, which the UI now files under Development, then Legacy apps; its access token goes as a Bearer token. HubSpot's docs describe no automatic expiry, recommend rotating every six months, and offer rotate-and-expire — so it is not a token that lasts forever either.",
    }),
    Object.freeze({
      id: "airtable",
      name: "Airtable",
      category: "databases / spreadsheets",
      docs_url: "https://airtable.com/developers/web/api/authentication",
      auth_type: "bearer",
      value_prop: "Airtable bases as structured data: records, fields, views. API base is https://api.airtable.com/v0/. The user creates a personal access token, sent as a Bearer token; it needs both the right scope and the specific base added to it as a resource; Airtable documents 403 Forbidden for credentials that do not have access to a resource, so a missing grant surfaces as an error rather than as an empty result.",
    }),
    Object.freeze({
      id: "wordpress",
      name: "WordPress",
      category: "CMS / website",
      docs_url: "https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/",
      auth_type: "basic",
      value_prop: "A WordPress site's own content: posts, pages, media, users. There is no shared host — the API base is the user's own site, https://THEIR-SITE/wp-json/wp/v2/, so ask for it. The user creates an Application Password under Users -> Edit User, in core since WordPress 5.6 with no plugin needed, and it goes as Basic auth. The field only appears on a site served over SSL/HTTPS, and the filters wp_is_application_passwords_available and ..._for_user let a plugin switch it off globally or per user.",
    }),
    Object.freeze({
      id: "woocommerce",
      name: "WooCommerce",
      category: "e-commerce / orders",
      docs_url: "https://woocommerce.github.io/woocommerce-rest-api-docs/",
      auth_type: "basic",
      value_prop: "Orders, products and customers on the user's own WooCommerce shop. There is no shared host — the API base is their shop, https://THEIR-SHOP/wp-json/wc/v3/, so ask for it. They create a Consumer Key and Consumer Secret under WooCommerce -> Settings -> Advanced -> REST API, choosing Read, Write or Read/Write; the key is tied to a WordPress user and inherits that user's rights. Over HTTPS the pair goes as Basic auth, key as username and secret as password.",
    }),
    Object.freeze({
      id: "shopware",
      name: "Shopware 6",
      category: "e-commerce / orders",
      docs_url: "https://developer.shopware.com/docs/guides/development/integrations-api/",
      auth_type: "oauth2 client_credentials",
      value_prop: "Orders, products and customers on the user's own Shopware 6 shop. There is no shared host — the API base is their shop, https://THEIR-SHOP/api/, so ask for it. They create an Integration under Settings -> System -> Integrations and must switch its Administrator toggle on, or it has no permissions; its client id and secret then exchange for a token at POST /api/oauth/token with grant_type=client_credentials, which needs no browser redirect.",
    }),
  ]),
});

/**
 * Why Shopify is NOT in the list above, so that its absence reads as a decision
 * rather than as an oversight — the same reason this file keeps any note at all.
 *
 * It was on the shortlist. Two facts, both quoted from shopify.dev on
 * 2026-09-30, and a third that decides it:
 *  • the path where a merchant makes their own app in their admin and copies an
 *    Admin API token is closed — "You can no longer create new admin-created
 *    custom apps. Existing apps are unaffected and continue to work";
 *  • the `client_credentials` grant "only works when the app and the store
 *    belong to the same Shopify organization", and "can't reach a store outside
 *    your organization, including a client's store". The same page adds that
 *    "Owning a store or having it installed doesn't automatically place it in
 *    your org".
 *
 * ⚠ That does NOT add up to "impossible", and the first draft of this note said
 * so — a review was right to push back. The same page describes a server-side
 * app "acting on stores in your own Shopify organization ... with no redirect
 * flow to implement", so a merchant whose store sits in a Dev Dashboard
 * organization they control could create the app, install it, and hand over a
 * client id and secret. That is the shape Shopware already has here.
 *
 * It stays out for two reasons that are about the entry rather than the vendor:
 * whether an ordinary merchant's store sits in such an organization is not
 * established by anything we have read, and the token that grant returns lives
 * 24 hours (`expires_in` 86399), so a connection made this way dies daily
 * unless something re-exchanges it. An entry the model may act on and usually
 * cannot finish spends the user's attention and ends in an apology.
 *
 * The bar this states, for whoever adds the next one: the user must be able to
 * create the credential THEMSELVES in their own account, it must ride one of
 * `supported_auth_flows`, and it must outlive the conversation that created it.
 * All three, checked at the provider's own docs.
 */
