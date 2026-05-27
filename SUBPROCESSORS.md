# lynox Sub-processors

**Last reviewed: 2026-05-23**

This file is the canonical, repo-checked-in list of sub-processors engaged for the **lynox Managed Hosting** service (`engine.lynox.cloud` / `*.lynox.cloud` tenant instances).

The **self-hosted lynox software** (`@lynox-ai/core` and `@lynox-ai/web-ui`) engages **no sub-processors** — when you run lynox on your own infrastructure, the software only communicates with the LLM provider whose API key you configure. This list applies only to lynox AI's managed offering.

The website page <https://lynox.ai/subprocessors> and this file mirror the customer-facing list. The contractually binding list lives in the **Data Processing Agreement** at <https://lynox.ai/dpa>. If any version diverges, the DPA prevails.

| Sub-processor | Purpose | Location | Transfer mechanism |
|---|---|---|---|
| Anthropic, PBC | Primary LLM inference (Claude family, direct API) | United States | EU-US Data Privacy Framework + SCCs (Module 2/3, 2021/914); zero-retention contractual commitment |
| Mistral AI SAS | LLM inference for chat, agent workflows, mail-triage classification, and memory consolidation (Mistral catalog: large/medium/small/magistral/ministral/codestral/nemo, direct API). Selected as primary provider by EU-residency customers and as secondary/fallback by others. | France (EU) | EU; zero-retention contractual commitment |
| OpenAI, L.L.C. | LLM inference — engaged only if the customer enables the OpenAI-compatible provider via BYOK | United States | SCCs (Module 2/3, 2021/914); subject to OpenAI's own DPA |
| Stripe, Inc. | Payment processing and subscription billing | United States / EU | EU-US Data Privacy Framework + SCCs |
| Hetzner Online GmbH | Server infrastructure — shared tenant hosts (isolated container per customer); dedicated VPS available as Enterprise upgrade | Germany (EU) | EU |
| Brevo (Sendinblue SAS) | Transactional email delivery (SMTP relay) and contact list management | EU (France/Germany) | EU |
| Cloudflare, Inc. | DNS, CDN, DDoS protection, tunnel relay | United States / EU (edge network) | EU-US Data Privacy Framework + SCCs |
| Plausible Insights OÜ | Anonymous website analytics (no personal data) | EU (Estonia) | EU |
| Google LLC | Marketing measurement on lynox.ai only — Google Analytics 4 + Google Tag Manager (Consent Mode v2; fires only with marketing consent via Klaro). Not engaged inside Managed Hosting. | United States | EU-US Data Privacy Framework + SCCs (Module 2/3, 2021/914) |
| Self-hosted (Bugsink) | Error reporting (always active for managed instances) | EU (self-hosted on lynox infrastructure) | No third-party transfer |

## Notes

- **OpenAI** is engaged only if the customer enables the OpenAI-compatible provider via BYOK (e.g. picking `openai` in the setup wizard with their own key). The default managed setup uses Anthropic + Mistral.
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
