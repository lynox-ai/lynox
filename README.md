# lynox

[![npm version](https://img.shields.io/npm/v/@lynox-ai/core)](https://www.npmjs.com/package/@lynox-ai/core)
[![CI](https://github.com/lynox-ai/lynox/actions/workflows/ci.yml/badge.svg)](https://github.com/lynox-ai/lynox/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-7000%2B-brightgreen)](#testing-and-security)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: ELv2](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**Run your business. Not your tools.**

One source-available (ELv2) agent that learns your business — connects any API, runs your workflows, researches the web, and monitors for changes. Persistent knowledge graph, workflow capture, sub-agents, background worker. Bring your own LLM — **Anthropic Claude** and **Mistral** are natively supported and tested on every release, and **Ollama** and **Fireworks AI** are verified with a real end-to-end tool-calling run. Other OpenAI-compatible endpoints (LM Studio, vLLM, LocalAI, Groq, Together AI, OpenAI itself, LiteLLM) and Google Vertex AI are wired but experimental. Self-hosted, no vendor lock-in.

> [!IMPORTANT]
> **lynox is a CLI, not a library.** Run `npx @lynox-ai/core`, not `npm install @lynox-ai/core`. The npm page sidebar suggests `npm i` by default, but that only installs lynox as a dependency without running anything.

## What it does

- **"Check my emails and tell me what's important"** — lynox reads your inbox, prioritizes, drafts replies in your tone. Tomorrow it remembers your style.
- **"Summarize this PDF"** — Drop a file, get structured key points. lynox saves the context for later.
- **"Research [topic] and give me the key points"** — Plans research phases, searches the web, cites sources, stores findings in the knowledge graph.
- **"Do this every Monday"** — teach lynox the workflow once, save it as a template, schedule it. Next Monday it runs on its own.
- **"What changed on competitor.com?"** — Started as a one-time check. Now runs weekly and notifies you when something shifts.

## Quick start

```bash
npx @lynox-ai/core
```

You need Node.js 22+, Docker, and an LLM credential. The interactive installer walks you through provider choice (**Anthropic** or **Mistral** are the natively-supported options; the OpenAI-compatible **Custom** path lets you point at anything else), generates a `docker-compose.yml`, pulls the image, and opens the Web UI at [localhost:3000](http://localhost:3000). In the Web UI's LLM settings, one-click presets cover Ollama, LM Studio, vLLM, LocalAI, Groq, Together AI, and Fireworks — Ollama and Fireworks are verified end-to-end with a real tool-calling run; the rest are experimental, and each tile says which.

Prefer to edit `.env` yourself before the first run? Jump to [manual Docker](#docker) below.

## Documentation

Full docs at **[docs.lynox.ai](https://docs.lynox.ai)** — getting started, integrations, features, API reference.

**Roadmap:** see [ROADMAP.md](./ROADMAP.md) for what's next, later, and under evaluation.

## How it works

```
┌──────────────────────────────────────┐
│              You                     │
│  Web UI · Mobile · CLI               │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│            lynox                     │
│  Knowledge Graph · Workflow Capture  │
│  Entity Resolution · Background      │
│  Worker · Activity Visibility        │
└──────┬───────────────────────┬───────┘
       │                       │
┌──────▼─────────┐  ┌──────────▼────────┐
│   Your LLM     │  │     Your Data     │
│  Anthropic ·   │  │ Gmail · Sheets ·  │
│  Mistral ·     │  │ Drive · Calendar  │
│  Ollama · more │  │ Files · APIs ·    │
│  via presets   │  │ Databases         │
└────────────────┘  └───────────────────┘
```

**BYOK** — You provide your LLM credential (Anthropic and Mistral are the natively-supported and tested paths; Ollama and Fireworks are verified end-to-end; other OpenAI-compatible endpoints / LiteLLM / Vertex are wired but experimental). When self-hosted, lynox calls the LLM API directly: no proxy, no middleman, and no telemetry unless you opt in via `LYNOX_BUGSINK_DSN` for error reporting. Your data stays on the host you control. (Managed tier opt-in routes via the lynox control plane — see the Managed page for that flow.)

## Key capabilities

- **Knowledge Graph** — Learns entities, relationships, and contradictions across your business. 100 languages, fully local.
- **Web UI** — Primary interface. Chat, knowledge browser, run history, settings, integrations. Installable as PWA. QR code login for instant phone access.
- **Activity Bar** — Every tool call streams live with its current sub-phase (e.g. "Reading API docs..." → "Extracting auth..."). No mysterious 30-second waits.
- **Background Worker** — Scheduled tasks, URL monitoring, recurring workflows.
- **Mobile Access** — Voice input (Whisper or Voxtral STT), push notifications, and mail/voice workflows. Install as a PWA for a native app feel, or use any mobile browser directly.
- **Google Workspace** — Gmail, Sheets, Drive, Calendar, Docs via OAuth 2.0.
- **Process Capture** — Teach lynox your workflow once, save it as a reusable template, schedule it. Export a workflow to a versioned format and import it on another instance — secrets and trusted hosts are re-approved on import, never carried over implicitly.
- **Model Choice** — Pick the model per chat, or set a named model strategy that maps each routing tier to a specific provider's model — with the backing host always disclosed.
- **4 Specialized Roles** — Researcher, Creator, Operator, Collector — each with scoped tools and budgets.
- **Security** — AES-256 encrypted vault, permission guard, input/output scanning, SSRF protection.

## What lynox is NOT good at yet

Honest about today's gaps, so you can decide if it's the right fit:

- **Voice in / out is functional, not polished.** Whisper STT + browser TTS work, but iOS Safari has Web Audio quirks (use Chrome on iOS for now). Hands-free workflows still need keyboard fallback.
- **Native calendar integration is on the roadmap.** CalDAV reads + ICS imports are spec'd (Phase 0 spike done) but not yet shipped; until then, calendar tasks flow through Google Workspace OAuth.
- **No multi-user / team accounts.** lynox is single-user today — one vault, one workflow library, one knowledge graph per instance, whether self-hosted or managed. In a team, each person runs their own instance; shared multi-user instances are something we're exploring, with no promised timeline.
- **The LLM is not deterministic.** Like every agent built on Claude / Mistral, output quality varies run-to-run. lynox mitigates with the knowledge graph + workflow templates, but if you need 100%-reproducible automation, a script beats lynox.

## Install

**Fastest** — open a terminal and paste:

```bash
npx @lynox-ai/core
```

> `better-sqlite3` needs C++ build tools. macOS: `xcode-select --install`. Ubuntu: `sudo apt-get install build-essential python3`.

### Clone & contribute

```bash
git clone https://github.com/lynox-ai/lynox.git
cd lynox && pnpm install
pnpm run build
node dist/index.js --http-api          # engine HTTP API on :3100

# In another terminal:
cd packages/web-ui && pnpm run dev     # web UI on :5173, talks to :3100
```

`pnpm run dev` from the repo root fires the Docker installer wizard — that's the same path as `npx @lynox-ai/core` (good for testing the installer itself). To actually run lynox from source, use the engine + web-ui combo above.

### Docker

```bash
cp .env.example .env       # add your API key
docker compose up
```

See [Docker docs](https://docs.lynox.ai/setup/docker/) for encryption and production deployment.

## Your first run

`npx @lynox-ai/core` walks you through an interactive installer: provider selection, API key, Docker Compose scaffolding, container pull, health check, and finally it opens the Web UI at [localhost:3000](http://localhost:3000). Save the access token and vault key it prints — the vault key cannot be recovered if lost.

### Mobile access (PWA)

Open [localhost:3000](http://localhost:3000) on your phone and use your browser's "Add to Home Screen" to install lynox as a PWA. The QR code in Web UI → Settings makes pairing instant — scan it on any device to get a pre-authenticated session.

## Testing and security

- 7000+ tests across the engine, tools, orchestrator, and web UI. Coverage gates on `pnpm run typecheck` + `npx vitest run`.
- Layered defenses: input-guard, permission-guard, data-boundary, AES-256-GCM vault, security-audit, plus tool-result injection scanning. SSRF protection on every outbound URL via `fetchWithValidatedRedirects` — DNS resolves once, the connection is pinned to the validated IP at TCP-connect time (rebind-safe), and each redirect hop is re-validated.
- Responsible disclosure → [`SECURITY.md`](SECURITY.md).

## Who builds this

Built solo by Rafael Burlet in Rapperswil SG, Switzerland. lynox runs in production for three SMBs (one is mine). The project sustains through the [Managed hosting tier](https://lynox.ai/managed) for users who'd rather not run their own Docker host — self-hosted is and stays free.

If something breaks, an [issue](https://github.com/lynox-ai/lynox/issues) lands on my desk directly; I usually reply within a few working days.

## Community

- [GitHub Discussions](https://github.com/lynox-ai/lynox/discussions) — Questions, ideas, show & tell
- [GitHub Issues](https://github.com/lynox-ai/lynox/issues) — Bug reports, feature requests
- [Contributing](CONTRIBUTING.md) — Bug reports and docs/test/integration-scaffold PRs welcome; feature PRs are issue-first
- [Security](SECURITY.md) — Responsible disclosure

## Disclaimer

This software is provided **"as is"**, without warranty of any kind. By using lynox, you acknowledge that:

- **You are solely responsible** for your installation, data, security, and compliance with applicable laws.
- **AI-generated output may be inaccurate.** Do not rely on it for critical decisions without independent verification.
- **We are not liable** for any damage, data loss, or costs arising from your use of the software, including API costs charged by AI providers.
- **You use this software at your own risk.** See our full [Terms of Service](https://lynox.ai/terms) for details.

## License

**Free for any use including production and customer-facing**, except offering lynox itself as a competing hosted service. Source-available and forkable under the [Elastic License 2.0](LICENSE) — same license as Elasticsearch and Kibana, not OSI-approved "open source". Use it commercially, self-host it, fork it — the one restriction is you can't resell it as a competing managed service.

**What you can do:** read, modify, and redistribute the source · self-host for your business, your clients, or your team · build commercial products and services on top of lynox.

**The one restriction:** you may not resell lynox as a managed hosting service to third parties (the Managed tier exists to fund the project; if you want to host it for someone else, [talk to me](https://github.com/lynox-ai/lynox/issues)).

---

**[lynox.ai](https://lynox.ai)** · **[npm](https://www.npmjs.com/package/@lynox-ai/core)** · **[Changelog](CHANGELOG.md)**
