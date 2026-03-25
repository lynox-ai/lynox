# nodyn

[![npm version](https://img.shields.io/npm/v/@nodyn-ai/core)](https://www.npmjs.com/package/@nodyn-ai/core)
[![CI](https://github.com/nodyn-ai/nodyn/actions/workflows/ci.yml/badge.svg)](https://github.com/nodyn-ai/nodyn/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: ELv2](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**The AI that knows your business.**

An AI agent that runs on your infrastructure, learns your business over time, and works in the background — so you don't repeat yourself. Persistent knowledge, autonomous workflows, real tool connections. No cloud dependency, no vendor lock-in.

## What it does

- **"Run a competitive analysis on our top three accounts"** — nodyn fetches your data, cross-references competitors, stores the findings, and schedules the same analysis for next Monday.
- **"Same analysis for this new client"** — No re-briefing. nodyn adapts the process it learned to the new account structure.
- **"Monitor our pricing page and notify me if anything changes"** — Background task runs on schedule, sends you a Telegram message when it detects a change.
- **"Summarize last week's emails and create a report in Google Docs"** — Connects to Gmail and Docs, writes the report, drops the link in your chat.
- **"Every Monday at 9am, pull KPIs from our tracking sheet"** — Recurring workflow, fully autonomous, results delivered to Telegram.

## Quick start

```bash
npx @nodyn-ai/core
```

Needs [Node.js 22+](https://nodejs.org) and an [Anthropic API key](https://console.anthropic.com/). The setup wizard handles everything else.

### Docker

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.nodyn:/home/nodyn/.nodyn \
  ghcr.io/nodyn-ai/nodyn:latest
```

## How it works

```
┌──────────────────────────────────────┐
│              You                     │
│   Terminal · Telegram · MCP · SDK    │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│            nodyn                     │
│                                      │
│  Understands your business context   │
│  Remembers what it learned           │
│  Works autonomously in background    │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│          Your Data                   │
│   Gmail · Sheets · Drive · Calendar  │
│   Files · APIs · Databases           │
└──────────────────────────────────────┘
```

**BYOK** — You provide your Anthropic API key. nodyn calls the API directly. No proxy, no middleman, no data collection.

## Key capabilities

- **Knowledge Graph** — Learns entities, relationships, and contradictions across your business. 100 languages, fully local.
- **Background Worker** — Scheduled tasks, URL monitoring, recurring workflows. Results delivered via Telegram.
- **Telegram Bot** — Primary daily interface. Rich status, follow-up suggestions, voice messages, file uploads.
- **Google Workspace** — Gmail, Sheets, Drive, Calendar, Docs via OAuth 2.0.
- **MCP Server** — Connect to Claude Desktop, Cursor, or any MCP client via stdio or HTTP.
- **Process Capture** — Teach nodyn your workflow once, save it as a reusable template, schedule it.
- **4 Specialized Roles** — Researcher, Creator, Operator, Collector — each with scoped tools and budgets.
- **Security** — AES-256 encrypted vault, permission guard, input/output scanning, SSRF protection.

## Install

### Quick install (auto-detects Node.js or Docker)

```bash
curl -fsSL https://nodyn.dev/install.sh | sh
```

### npm (recommended)

```bash
npx @nodyn-ai/core
```

> **Note:** `better-sqlite3` requires C++ build tools. macOS: `xcode-select --install`. Ubuntu/Debian: `sudo apt-get install build-essential python3`. Windows: [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/).

### Clone & run

```bash
git clone https://github.com/nodyn-ai/nodyn.git
cd nodyn && npm install
npm run dev
```

### Docker

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up
```

See [Docker docs](docs/docker.md) for Telegram, encryption, and production deployment.

## Your first run

After setup you're in the interactive REPL:

```
❯ What can you do?
```

One-shot mode — run a task and exit:

```bash
npx @nodyn-ai/core "Summarize the last 5 commits in this repo"
```

### Telegram (recommended for daily use)

Create a bot via [@BotFather](https://t.me/BotFather), then:

```bash
TELEGRAM_BOT_TOKEN=123:ABC... npx @nodyn-ai/core
```

For SDK usage, see [docs/sdk.md](docs/sdk.md) and [`examples/`](examples/).

## Documentation

Architecture, tools, integrations, security, and deployment details are in [`docs/`](docs/).

## Community

- [GitHub Discussions](https://github.com/nodyn-ai/nodyn/discussions) — Questions, ideas, show & tell
- [GitHub Issues](https://github.com/nodyn-ai/nodyn/issues) — Bug reports, feature requests
- [Contributing](CONTRIBUTING.md) — Development setup and guidelines
- [Security](SECURITY.md) — Responsible disclosure

## License

[Elastic License 2.0](LICENSE) (ELv2) — free to use, modify, and self-host.

**What you can do:**
- Read, modify, and redistribute the source code
- Self-host nodyn for your business, your clients, or your team
- Build commercial products and services on top of nodyn

**The one restriction:** You may not offer nodyn as a hosted service to third parties.

This protects the project's sustainability while keeping the code fully open. The same approach is used by Elasticsearch and CockroachDB. Questions? [Open an issue](https://github.com/nodyn-ai/nodyn/issues).

---

**[nodyn.dev](https://nodyn.dev)** · **[npm](https://www.npmjs.com/package/@nodyn-ai/core)** · **[Changelog](CHANGELOG.md)**
