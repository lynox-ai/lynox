# lynox Roadmap

The public-facing slice of what's next for lynox. Strategic details (pricing, business model, go-to-market) live in the private Pro repo; this page is the engineering-and-feature view that an evaluator or contributor needs.

**This is directional, not a commitment.** There are no dates and no version promises here — priorities shift, and items move between the sections below as we learn. The order within a section is rough, not ranked.

This roadmap is intentionally short. The Managed-hosting tier funds the project, so engineering capacity is one full-time maintainer plus occasional help — multi-year speculative roadmaps would be theatre.

---

## shipped

Recent capabilities that are live today, so you can tell them apart from plans:

- **Portable workflows** — export a saved workflow and import it elsewhere, with a versioned format that refuses to silently misread a newer file.
- **Per-tier model choice** — pick which model backs each speed tier (fast / balanced / deep), across Anthropic, Mistral, and OpenAI-compatible gateways, instead of taking one vendor's ladder as given.
- **Guided first-run setup** — a short onboarding that grounds the agent in your business up front, rather than starting from an empty context.
- **Outbound network controls** — configure which hosts the agent may reach, from open to a vetted allow-list.
- **Durable Knowledge** — an archival memory tier, available opt-in per instance.
- **Conversation and diagnostic export** — take your threads and run history with you.

## next

- Reversible knowledge edits — being able to split or undo a merge, so the agent's memory is genuinely correctable rather than append-only. This one comes first: as long as merging two same-named things is a one-way door, everything built on top inherits that. A first piece is in: when two records share a name, the agent now refuses the ambiguous match and asks, instead of silently picking one. That stops new merges from going wrong; undoing the ones already made is the part still ahead.
- Durable Knowledge rollout — moving it from opt-in toward the default. Flipping a memory default changes behaviour on an instance that is already running, so the test is whether the archival path measurably beats the one it would replace, not whether a date has arrived. It does. What holds the switch is the item above: memory should be correctable before it becomes the store everything else reads from. Until then, opt-in is the honest setting.
- Calendar Integration (CalDAV + ICS imports, then create)
- OpenAI Native Provider (first-class, alongside Anthropic + Mistral)
- MCP Client (connect to Smithery catalog + custom servers)
- OAuth Authorization-Code Callbacks (closes the remaining `api_setup` OAuth gap)

## later

- Workflow template sharing (a directory you can publish to and install from)
- Browser Use / Playwright Tool (automate sites without APIs)
- Deeper multimodal document understanding (server-side PDF/Word extraction + image input are shipped; a first-class multimodal pipeline is next)
- Inbound Webhook Receivers (Stripe / GitHub / Twilio events trigger workflows)

## under evaluation

- iOS / Android native apps (PWA exists today — gauging demand)
- Gladia.io as an additional STT provider (Whisper + Voxtral are shipped)

---

## How priorities get decided

In rough order:

1. **Critical bugs in production** — anything that affects currently-running deployments.
2. **Issues that gate the next release.** The release flow has a "no opens that block this version" gate.
3. **Items the maintainer has personally hit** while using lynox for his own business.
4. **Issues with a credible repro** from anyone running lynox.
5. **Strategic features** from this roadmap.

A vocal user with a real repro outranks a strategic feature most of the time. That's by design — lynox needs to keep working for the people who already trust it before it can scale.

---

## Telling us what to prioritize

[Open an issue](https://github.com/lynox-ai/lynox/issues) with the use case. The roadmap above is the maintainer's best-guess priority; real usage moves items up.

GitHub Discussions are also open if you want to think out loud about something before filing an issue: [github.com/lynox-ai/lynox/discussions](https://github.com/lynox-ai/lynox/discussions).
