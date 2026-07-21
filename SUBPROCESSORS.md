# lynox Sub-processors

**Last reviewed: 2026-06-08**

This file is the canonical, repo-checked-in list of sub-processors engaged for the **lynox Managed Hosting** service (`engine.lynox.cloud` / `*.lynox.cloud` tenant instances).

The **self-hosted lynox software** (`@lynox-ai/core` and `@lynox-ai/web-ui`) engages **no sub-processors** — when you run lynox on your own infrastructure, the software only communicates with the LLM provider whose API key you configure. This list applies only to lynox AI's managed offering.

The website page <https://lynox.ai/subprocessors> and this file mirror the customer-facing list. The contractually binding list lives in the **Data Processing Agreement** at <https://lynox.ai/dpa>. If any version diverges, the DPA prevails.

| Sub-processor | Purpose | Location | Transfer mechanism |
|---|---|---|---|
| Anthropic, PBC | Primary LLM inference (Claude family, direct API) | United States | EU-US Data Privacy Framework + SCCs (Module 2/3, 2021/914); zero-retention contractual commitment |
| Mistral AI SAS | LLM inference for chat, agent workflows, mail-triage classification, and memory consolidation. The managed tiers route to Mistral Large (`mistral-large-2512`) and the Ministral edge models (`ministral-14b-2512` / `ministral-8b-2512`), via the direct API. Selected as primary provider by EU-residency customers and as secondary/fallback by others. | France (EU) | EU; zero-retention contractual commitment |
| Fireworks AI, Inc. | LLM inference for the deep-reasoning tier of the opt-in "Efficient" model strategy — engaged only for managed instances that select the Efficient preset, and only once it is enabled for their instance. Its fast and balanced tiers stay on Mistral (EU); only the deep tier routes to a single open-weight model (GLM) on Fireworks' serverless inference. Not part of the default managed setup. Prompts and outputs are not retained or logged by Fireworks (Zero Data Retention, Fireworks' default for open models). | United States | SCCs (Module 2/3, 2021/914); Zero Data Retention as an additional safeguard |
| Stripe, Inc. | Payment processing and subscription billing | United States / EU | EU-US Data Privacy Framework + SCCs |
| Hetzner Online GmbH | Server infrastructure — shared tenant hosts (isolated container per customer); dedicated VPS available as Enterprise upgrade | Germany (EU) | EU |
| Brevo (Sendinblue SAS) | Transactional email delivery (SMTP relay) and contact list management | EU (France/Germany) | EU |
| Cloudflare, Inc. | DNS, CDN, DDoS protection, tunnel relay | United States / EU (edge network) | EU-US Data Privacy Framework + SCCs |
| Plausible Insights OÜ | Anonymous website analytics (no personal data) | EU (Estonia) | EU |
| Google LLC | Marketing measurement on lynox.ai only — Google Analytics 4 + Google Tag Manager (Consent Mode v2; fires only with marketing consent via Klaro). Not engaged inside Managed Hosting. | United States | EU-US Data Privacy Framework + SCCs (Module 2/3, 2021/914) |
| Self-hosted (Bugsink) | Error reporting (always active for managed instances) | EU (self-hosted on lynox infrastructure) | No third-party transfer |

## Notes

- **Customer-configured endpoints (BYOK).** If a customer connects their own LLM provider via Settings → LLM with their own key — for example OpenAI, an OpenAI-compatible endpoint, Google Vertex AI, or a self-hosted model — that provider is engaged by the customer under their own agreement with it. It is the customer's own controller relationship, not a lynox sub-processor, and is therefore not listed above. The default managed setup uses Anthropic + Mistral only.
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
