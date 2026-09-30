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
 * precisely why a year passed without anyone noticing. A constant compiled
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
