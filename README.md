# nodyn

[![npm version](https://img.shields.io/npm/v/@nodyn-ai/core)](https://www.npmjs.com/package/@nodyn-ai/core)
[![CI](https://github.com/nodyn-ai/nodyn/actions/workflows/ci.yml/badge.svg)](https://github.com/nodyn-ai/nodyn/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: ELv2](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**The AI that knows your business.**

An AI agent that runs on your infrastructure, learns your business over time, and works in the background — so you don't repeat yourself. Persistent knowledge, autonomous workflows, real tool connections. No cloud dependency, no vendor lock-in.

## What it does

- **"Check my emails and tell me what's important"** — nodyn reads your inbox, prioritizes, drafts replies in your tone. Tomorrow it remembers your style.
- **"Summarize this PDF"** — Drop a file, get structured key points. nodyn saves the context for later.
- **"Research [topic] and give me the key points"** — Plans research phases, searches the web, cites sources, stores findings in the knowledge graph.
- **"Same as last Monday"** — nodyn recognizes the pattern. "Want me to do this every Monday?" One tap, it's automated.
- **"What changed on competitor.com?"** — Started as a one-time check. Now runs weekly and alerts you via Telegram when something shifts.

## Quick start

```bash
curl -fsSL https://nodyn.dev/install.sh | sh
```

You need an [Anthropic API key](https://console.anthropic.com/) — the setup wizard asks for it. That's all.

Already have Node.js 22+? `npx @nodyn-ai/core` works too.

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

**Fastest** — open a terminal and paste:

```bash
curl -fsSL https://nodyn.dev/install.sh | sh
```

**With Node.js 22+:**

```bash
npx @nodyn-ai/core
```

> `better-sqlite3` needs C++ build tools. macOS: `xcode-select --install`. Ubuntu: `sudo apt-get install build-essential python3`.

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
