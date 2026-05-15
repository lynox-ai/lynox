# lynox

[![npm version](https://img.shields.io/npm/v/@lynox-ai/core)](https://www.npmjs.com/package/@lynox-ai/core)
[![CI](https://github.com/lynox-ai/lynox/actions/workflows/ci.yml/badge.svg)](https://github.com/lynox-ai/lynox/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-4600%2B-brightgreen)](#testing-and-security)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: ELv2](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**Run your business. Not your tools.**

One open-source agent that learns your business — handles CRM, workflows, research, and monitoring. Persistent knowledge graph, workflow capture, background worker. Bring your own LLM (Anthropic, Mistral, or any OpenAI-compatible endpoint — Ollama, LM Studio, LiteLLM, Groq). Source-available (ELv2), self-hosted, no vendor lock-in.

> [!IMPORTANT]
> **lynox is a CLI, not a library.** Run `npx @lynox-ai/core`, not `npm install @lynox-ai/core`. The npm page sidebar suggests `npm i` by default, but that only installs lynox as a dependency without running anything.

## What it does

- **"Check my emails and tell me what's important"** — lynox reads your inbox, prioritizes, drafts replies in your tone. Tomorrow it remembers your style.
- **"Summarize this PDF"** — Drop a file, get structured key points. lynox saves the context for later.
- **"Research [topic] and give me the key points"** — Plans research phases, searches the web, cites sources, stores findings in the knowledge graph.
- **"Same as last Monday"** — lynox recognizes the pattern. "Want me to do this every Monday?" One tap, it's automated.
- **"What changed on competitor.com?"** — Started as a one-time check. Now runs weekly and alerts you via Telegram when something shifts.

## Quick start

```bash
npx @lynox-ai/core
```

You need Node.js 22+, Docker, and an LLM credential. The interactive installer walks you through provider choice (**Anthropic**, **Mistral**, or **Custom** — any OpenAI-compatible endpoint, including Ollama / LM Studio / LiteLLM / Groq / vLLM), generates a `docker-compose.yml`, pulls the image, and opens the Web UI at [localhost:3000](http://localhost:3000).

Prefer to edit `.env` yourself before the first run? Jump to [manual Docker](#docker) below.

## Documentation

Full docs at **[docs.lynox.ai](https://docs.lynox.ai)** — getting started, integrations, features, API reference.

## How it works

```
┌──────────────────────────────────────┐
│              You                     │
│  Web UI · Telegram · CLI · MCP       │
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
│  Custom (any   │  │ Files · APIs ·    │
│  OpenAI API)   │  │ Databases         │
└────────────────┘  └───────────────────┘
```

**BYOK** — You provide your LLM credential (Anthropic / Mistral / OpenAI-compatible). lynox calls the API directly. No proxy, no middleman, no data collection. Your data stays on the host you control.

## Key capabilities

- **Knowledge Graph** — Learns entities, relationships, and contradictions across your business. 100 languages, fully local.
- **Web UI** — Primary interface. Chat, knowledge browser, run history, settings, integrations. Installable as PWA. QR code login for instant phone access.
- **Background Worker** — Scheduled tasks, URL monitoring, recurring workflows.
- **Telegram Bot** — Mobile notifications and quick tasks. Voice, photos, files, follow-up suggestions.
- **Google Workspace** — Gmail, Sheets, Drive, Calendar, Docs via OAuth 2.0.
- **MCP Server** — Connect to Claude Desktop, Cursor, or any MCP client via stdio or HTTP.
- **Process Capture** — Teach lynox your workflow once, save it as a reusable template, schedule it.
- **4 Specialized Roles** — Researcher, Creator, Operator, Collector — each with scoped tools and budgets.
- **Security** — AES-256 encrypted vault, permission guard, input/output scanning, SSRF protection.

## What lynox is NOT good at yet

Honest about today's gaps, so you can decide if it's the right fit:

- **Voice in / out is functional, not polished.** Whisper + GPT-style TTS work, but iOS Safari has Web Audio quirks (use Chrome on iOS for now). Hands-free workflows still need keyboard fallback.
- **Native calendar integration is read-only.** CalDAV reads + ICS imports work; creating events from chat lands later. Until then, calendar tasks flow through Google Workspace OAuth.
- **No multi-user / team accounts.** lynox is single-user today. One vault, one workflow library, one knowledge graph per instance. Multi-tenant teams happen on the Managed tier; self-hosted is solo.
- **The LLM is not deterministic.** Like every agent built on Claude / Mistral, output quality varies run-to-run. We mitigate with the knowledge graph + workflow templates, but if you need 100%-reproducible automation, a script beats lynox.

## Install

**Fastest** — open a terminal and paste:

```bash
npx @lynox-ai/core
```

> `better-sqlite3` needs C++ build tools. macOS: `xcode-select --install`. Ubuntu: `sudo apt-get install build-essential python3`.

### Clone & run

```bash
git clone https://github.com/lynox-ai/lynox.git
cd lynox && pnpm install
pnpm run dev
```

### Docker

```bash
cp .env.example .env       # add your API key
docker compose up
```

See [Docker docs](https://docs.lynox.ai/daily-use/docker/) for Telegram, encryption, and production deployment.

## Your first run

`npx @lynox-ai/core` walks you through an interactive installer: provider selection, API key, Docker Compose scaffolding, container pull, health check, and finally it opens the Web UI at [localhost:3000](http://localhost:3000). Save the access token and vault key it prints — the vault key cannot be recovered if lost.

### One-shot mode

With `ANTHROPIC_API_KEY` already in your environment, you can run a single task inline without the Docker path:

```bash
ANTHROPIC_API_KEY=sk-ant-... npx @lynox-ai/core "Summarize the last 5 commits in this repo"
```

This starts an in-process engine, runs the task, and exits.

### Telegram (mobile)

Create a bot via [@BotFather](https://t.me/BotFather), add the token in Web UI → Settings → Integrations.

## Testing and security

- 4600+ tests across the engine, tools, and orchestrator. Coverage gates on `pnpm run typecheck` + `npx vitest run`.
- Layered defenses: input-guard, output-guard, permission-guard, data-boundary, AES-256 vault, security-audit. SSRF protection on every outbound URL; private-IP + DNS-rebinding heuristics in `fetchWithValidatedRedirects`.
- Responsible disclosure → [`SECURITY.md`](SECURITY.md).

## Who builds this

Built solo by Rafael Burlet in Zürich. lynox runs in production for three SMBs (one is mine). There's no fundraise — the project sustains through the [Managed hosting tier](https://lynox.ai/managed) for users who'd rather not run their own Docker host. Self-hosted is and stays free.

If something breaks, an [issue](https://github.com/lynox-ai/lynox/issues) lands on my desk directly; I tend to respond within a working day.

## Community

- [GitHub Discussions](https://github.com/lynox-ai/lynox/discussions) — Questions, ideas, show & tell
- [GitHub Issues](https://github.com/lynox-ai/lynox/issues) — Bug reports, feature requests
- [Contributing](CONTRIBUTING.md) — Bug reports, feature requests (no external PRs at this time)
- [Security](SECURITY.md) — Responsible disclosure

## Disclaimer

This software is provided **"as is"**, without warranty of any kind. By using lynox, you acknowledge that:

- **You are solely responsible** for your installation, data, security, and compliance with applicable laws.
- **AI-generated output may be inaccurate.** Do not rely on it for critical decisions without independent verification.
- **We are not liable** for any damage, data loss, or costs arising from your use of the software, including API costs charged by AI providers.
- **You use this software at your own risk.** See our full [Terms of Service](https://lynox.ai/terms) for details.

## License

[Elastic License 2.0](LICENSE) — source-available, **free for any use including production and customer-facing**, except offering lynox itself as a competing hosted service. Same model as Elasticsearch, CockroachDB, MongoDB Atlas.

**What you can do:** read, modify, and redistribute the source · self-host for your business, your clients, or your team · build commercial products and services on top of lynox.

**The one restriction:** you may not resell lynox as a managed hosting service to third parties (the Managed tier exists to fund the project; if you want to host it for someone else, [talk to me](https://github.com/lynox-ai/lynox/issues)).

---

**[lynox.ai](https://lynox.ai)** · **[npm](https://www.npmjs.com/package/@lynox-ai/core)** · **[Changelog](CHANGELOG.md)**
