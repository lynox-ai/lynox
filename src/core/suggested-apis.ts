/**
 * The bootstrap-hint catalogue, as code.
 *
 * This is a text the engine writes into the model's briefing — the list of
 * external APIs it may offer to set up, plus the auth flows it must and must
 * not propose. It used to live in `data/suggested-apis.json` and be read at
 * boot. Two measurements moved it here, and neither is a matter of taste:
 *
 *  • **It never arrived.** The production image copies `node_modules`, `dist`,
 *    `package.json`, the web UI and the entrypoint — not `data/`. So in every
 *    container (managed hosting, and every self-host via Compose) the read
 *    failed, the reader returned `''`, and the model was briefed with no
 *    catalogue at all. Silently: no log, no metric, no failing test, because
 *    the tests run from `src/` and resolve `../../data/` to the copy in the
 *    repository — the one no deployment loads. `dist/` is copied, so a
 *    constant compiled into the engine reaches every install by construction.
 *
 *  • **Where it did arrive, it was writable.** On an npm self-host the package
 *    directory usually belongs to the same user the engine runs as, and the
 *    `bash` tool takes absolute paths. A file that becomes part of the
 *    briefing and can be rewritten by a tool the briefing describes is an
 *    entrance into our own instructions.
 *
 * The obvious alternative — one `COPY data/` line in the Dockerfile — fixes
 * the first and worsens the second. The container is closed today for TWO
 * independent reasons: the file is absent, and `/app` belongs to root while
 * the process runs as `lynox`. Copying it in with `--chown=lynox:lynox` would
 * remove both at once. The cheaper fix is the one that opens a hole.
 *
 * ⚠ Same reasoning as {@link ./oauth-presets.ts}, and deliberately so — that
 * module's header argues at length why a text with this job must not come from
 * an operator-editable file. It called this catalogue the justified exception
 * ("right for a list of hints the model may read"). It was right about the
 * distinction and wrong about which side this falls on: hints steer which
 * third party a user is asked to hand a token to, and the reader's silent
 * `catch` meant nobody could tell the list apart from no list.
 *
 * There is no `schema_version` here. It was a handshake between a file and a
 * parser that could disagree about its format; a constant and its type cannot.
 */

/** One entry the model may offer to bootstrap. */
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
  readonly suggested_apis: readonly SuggestedApi[];
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
  ]),
  not_supported_auth_flows: Object.freeze([
    "oauth2 authorization_code grant with browser-redirect / callback-URL (in progress — APIs requiring this flow cannot be bootstrapped today)",
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
});
