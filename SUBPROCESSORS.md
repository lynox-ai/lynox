# lynox Sub-processors

**Last reviewed: 2026-08-11**

This file is the canonical, repo-checked-in list of sub-processors engaged for the **lynox Managed Hosting** service (`engine.lynox.cloud` / `*.lynox.cloud` tenant instances).

The **self-hosted lynox software** (`@lynox-ai/core` and `@lynox-ai/web-ui`) engages **no sub-processors** — when you run lynox on your own infrastructure, the software only communicates with the LLM provider whose API key you configure. This list applies only to lynox AI's managed offering.

The website page <https://lynox.ai/subprocessors> and this file mirror the customer-facing list. The contractually binding list lives in the **Data Processing Agreement** at <https://lynox.ai/dpa>. If any version diverges, the DPA prevails.

| Sub-processor | Purpose | Location | Transfer mechanism |
|---|---|---|---|
| Anthropic, PBC | Primary LLM inference (Claude family, direct API) — the default for every managed instance. | United States | SCCs (**Module 2 and Module 3**, 2021/914; Irish law) per Anthropic's DPA §I.1 — **not** the EU-US Data Privacy Framework: Anthropic is not a certified participant (US Dept. of Commerce register, checked 2026-08-11), and its own privacy policy names only adequacy decisions and SCCs. **Retention: inputs and outputs are deleted within 30 days of receipt or generation**, which is Anthropic's API default; lynox holds no zero-retention agreement, and zero retention is available from Anthropic only under one. Longer retention applies where a request is flagged under Anthropic's Usage Policy. No training on inputs under its Commercial Terms. |
| Mistral AI SAS | LLM inference for chat, agent workflows, mail-triage classification, and memory consolidation. The managed tiers route to Mistral Large (`mistral-large-2512`) and the Ministral edge models (`ministral-14b-2512` / `ministral-8b-2512`), via the direct API. Selected as primary provider by EU-residency customers and as secondary/fallback by others. | France (EU) | EU; zero-retention contractual commitment |
| Fireworks AI, Inc. | LLM inference for the opt-in "Efficient" and "Balanced" model strategies — engaged only for managed instances that actively select one of those presets, or a Fireworks model in their model settings. The option is enabled platform-wide; no data is transmitted to Fireworks until an instance selects it, and the default managed setup routes to Anthropic and Mistral only. Where a preset is selected, **all three** model tiers (fast / balanced / deep) run on Fireworks' serverless inference on open-weight models of Chinese origin — DeepSeek v4 Flash, MiniMax M3, GLM 5.2 and Kimi K3. The weights are open; the inference runs on Fireworks' own infrastructure. None of the sub-processors listed in Schedule 4 of its DPA is a Chinese entity. The processing locations named there include the United States, Germany, the United Kingdom, Japan and Iceland; one row, a content-delivery provider, is listed with no fixed country at all. Schedule 4 is Fireworks' list and can change — it is the list as we read it on 2026-08-11, and Fireworks owes 30 days' notice of changes to it (Fireworks DPA, Schedule 4). Fireworks does not retain prompt inputs or model outputs beyond the lifecycle of a request (Zero Data Retention — Fireworks' default for open models, which we have not opted out of by enabling prompt logging, and a contractual obligation under §4.5 of its DPA), and is contractually prohibited from using the data to train, fine-tune or otherwise improve any shared or foundational model (§4.3(f)). | United States | SCCs (Module 2, 2021/914; Irish law, Irish DPC); Zero Data Retention and the no-training commitment as additional safeguards; SOC 2 Type II, ISO 27001 / 27701 / 42001 |
| Stripe, Inc. | Payment processing and subscription billing | United States / EU | EU-US Data Privacy Framework + SCCs |
| Hetzner Online GmbH | Server infrastructure — shared tenant hosts (isolated container per customer); dedicated VPS available as Enterprise upgrade | Germany (EU) | EU |
| Brevo (Sendinblue SAS) | Transactional email delivery (SMTP relay) and contact list management | EU (France/Germany) | EU |
| Cloudflare, Inc. | DNS, CDN, DDoS protection, tunnel relay | United States / EU (edge network) | EU-US Data Privacy Framework + SCCs |
| Plausible Insights OÜ | Anonymous website analytics (no personal data) | EU (Estonia) | EU |
| Google LLC | Marketing measurement on lynox.ai only — Google Analytics 4 + Google Tag Manager (Consent Mode v2; fires only with marketing consent via Klaro). Not engaged inside Managed Hosting. | United States | EU-US Data Privacy Framework + SCCs (Module 2/3, 2021/914) |
| Self-hosted (Bugsink) | Error reporting (always active for managed instances) | EU (self-hosted on lynox infrastructure) | No third-party transfer |

## Notes

- **Customer-configured endpoints (BYOK).** If a customer connects their own LLM provider via Settings → LLM with their own key — for example OpenAI, an OpenAI-compatible endpoint, Google Vertex AI, or a self-hosted model — that provider is engaged by the customer under their own agreement with it. It is the customer's own controller relationship, not a lynox sub-processor, and is therefore not listed above. The default managed setup uses Anthropic + Mistral only.
- **Prompt caching.** Prompt prefixes are cached to cut latency and cost: on Anthropic we set explicit cache breakpoints, while Mistral and Fireworks apply their own automatic prefix caching. Cached data is short-lived and expires on its own: our Anthropic cache breakpoints carry a one-hour time-to-live, and for Fireworks its documentation states the data stays in volatile memory and is never written to persistent storage. Caching is the one carve-out from the Fireworks zero-retention commitment cited in the table (its DPA §4.5). It does not bear on Anthropic, whose 30-day retention already covers anything cached.
- **Google LLC** sub-processor scope is intentionally narrow — only `lynox.ai` marketing measurement (GA4 + Tag Manager, gated by Klaro Consent Mode v2). Managed Hosting tenant data never crosses Google's systems unless the customer separately enables a Google integration (Calendar OAuth, BYOK Gemini); those are customer-controlled and disclosed inline in the Privacy Policy where applicable.
- All sub-processor changes are notified to managed customers at least 30 days in advance per the DPA.

## Where this list is duplicated

The same sub-processor inventory appears on the lynox website in two places:

- <https://lynox.ai/privacy> — section 5 (third-party services)
- <https://lynox.ai/dpa> — section 9 (sub-processors)

The DE counterparts (`/de/datenschutz/`, `/de/avv/`) mirror these.

This `SUBPROCESSORS.md` file is the engineering-visible source of truth; the web pages are updated in the same change.

## Contact

For questions about sub-processors or to object to a sub-processor change:
<privacy@lynox.ai> · EU representative: <https://app.prighter.com/portal/13646667120>
