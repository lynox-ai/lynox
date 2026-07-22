# lynox Roadmap

The public-facing slice of what's next for lynox. Strategic details (pricing, business model, go-to-market) live in the private Pro repo; this page is the engineering-and-feature view that an evaluator or contributor needs.

This roadmap is intentionally short. The Managed-hosting tier funds the project, so engineering capacity is one full-time maintainer plus occasional help — multi-year speculative roadmaps would be theatre.

---

## next
- Calendar Integration (CalDAV + ICS imports, then create)
- OpenAI Native Provider (first-class, alongside Anthropic + Mistral)
- MCP Client (connect to Smithery catalog + custom servers)
- OAuth Authorization-Code Callbacks (closes api_setup OAuth gap)
- Durable Knowledge rollout (archival memory tier — shipped opt-in, being enabled per instance)

## later
- Browser Use / Playwright Tool (automate sites without APIs)
- Deeper multimodal document understanding (server-side PDF/Word extraction + image input are shipped; a first-class multimodal pipeline is next)
- Inbound Webhook Receivers (Stripe / GitHub / Twilio events trigger workflows)

## under evaluation
- iOS / Android native apps (PWA exists today — gauging demand)
- Gladia.io as an additional STT provider (Whisper + Voxtral are shipped)

## beyond
(focus is on items above)

---

## How priorities get decided

In rough order:

1. **Critical bugs in production** — anything that affects the currently-running customer deployments.
2. **Issues that gate the next release.** The release-cut flow has a "no opens that block this version" gate.
3. **Items the maintainer has personally hit** while using lynox for his own business.
4. **Issues with a credible repro** from anyone running lynox.
5. **Strategic features** from this roadmap.

A vocal customer with a real repro outranks a strategic feature most of the time. That's by design — lynox needs to keep working for the people who already trust it before it can scale.

---

## Telling us what to prioritize

[Open an issue](https://github.com/lynox-ai/lynox/issues) with the use case. The roadmap above is the maintainer's best-guess priority; real customers move items up.

GitHub Discussions are also open if you want to think out loud about something before filing an issue: [github.com/lynox-ai/lynox/discussions](https://github.com/lynox-ai/lynox/discussions).
