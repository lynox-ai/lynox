# lynox Roadmap

The public-facing slice of what's next for lynox. Strategic details (pricing, business model, go-to-market) are not part of this page; this is the engineering-and-feature view that an evaluator or contributor needs.

**This is directional, not a commitment.** There are no dates and no version promises here — priorities shift, and items move between the sections below as we learn. The order within a section is rough, not ranked.

This roadmap is intentionally short. We publish directions we actually intend to work on — a multi-year speculative feature list would be theatre.

---

## shipped

Recent capabilities that are live today, so you can tell them apart from plans:

- **Portable workflows** — export a saved workflow and import it elsewhere, with a versioned format that refuses to silently misread a newer file.
- **Speed-tier presets** — pick a routing preset rather than assembling a model ladder by hand, with each tier's model named and its context window stated at the point where you choose it.
- **Per-tier model choice** — pick which model backs each speed tier (fast / balanced / deep), across Anthropic, Mistral, and OpenAI-compatible gateways, instead of taking one vendor's ladder as given.
- **Durable Knowledge** — an archival memory tier. New hosted instances start with it on; existing ones keep whatever they were set to.
- **Delegation you can see and afford** — a sub-agent's work is attributed to the sub-agent rather than the main chat, its cost and wait are reported, and spending a deep tier is asked about rather than assumed.
- **Guided first-run setup** — a short onboarding that grounds the agent in your business up front, rather than starting from an empty context. What you answer on day one is what the agent carries into every conversation.
- **Outbound network controls** — configure which hosts the agent may reach, from open to a vetted allow-list.
- **Calendar reading** — a read-only view of an ICS feed. It ships switched off, and turning it on is an operator-side setting rather than something you flip in the app.
- **Conversation and diagnostic export** — take your threads and run history with you.

## next

- **Reversible knowledge edits** — being able to split or undo a merge, so the agent's memory is genuinely correctable rather than append-only. It is the item with the widest blast radius: as long as merging two same-named things is a one-way door, everything built on top inherits that. A first piece is in — when two records share a name, the agent refuses the ambiguous match and asks instead of silently picking one. That stops new merges from going wrong. Undoing the ones already made is the part still ahead — until it lands, treat a merge as permanent: the agent asks before it merges, but there is no undo in the interface yet.
- **One memory store instead of two** — durable knowledge currently runs alongside the older memory archive rather than replacing it. Consolidating them means one place where memory is stored, corrected and exported — instead of two with different capabilities.
- **Calendar writing** — creating and changing events, not just reading them. The read path shipped first deliberately; the write path is a different design question and is not settled yet.
- **OpenAI as a first-class provider** — alongside Anthropic and Mistral, rather than only through the OpenAI-compatible gateway path.
- **MCP client** — connect to external MCP servers, both catalog and custom.
- **OAuth authorization-code callbacks** — closing the remaining gap in connecting APIs that need a redirect flow.

## later

- Workflow template sharing (a directory you can publish to and install from)
- Browser use (automating sites that offer no API)
- Deeper multimodal document understanding (server-side PDF/Word extraction and image input are shipped; a first-class multimodal pipeline is the direction, not a scheduled item)
- Inbound webhook receivers (external events triggering workflows)

## under evaluation

- iOS / Android native apps (a PWA exists today — gauging demand)
- Additional speech-to-text providers (Whisper and Voxtral are shipped)

---

## How priorities get decided

In rough order:

1. **Critical bugs in production** — anything that affects currently-running deployments.
2. **Issues that gate the next release.** The release flow has a "no opens that block this version" gate.
3. **Items we have personally hit** while running our own business on lynox.
4. **Issues with a credible repro** from anyone running lynox.
5. **Strategic features** from this roadmap.

A vocal user with a real repro outranks a strategic feature most of the time. That's by design — lynox needs to keep working for the people who already trust it before it can scale.

---

## Telling us what to prioritize

[Open an issue](https://github.com/lynox-ai/lynox/issues) with the use case. The roadmap above is our current best-guess priority; real usage moves items up.

GitHub Discussions are also open if you want to think out loud about something before filing an issue: [github.com/lynox-ai/lynox/discussions](https://github.com/lynox-ai/lynox/discussions).
