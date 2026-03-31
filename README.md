# lynox

[![npm version](https://img.shields.io/npm/v/@lynox-ai/core)](https://www.npmjs.com/package/@lynox-ai/core)
[![CI](https://github.com/lynox-ai/lynox/actions/workflows/ci.yml/badge.svg)](https://github.com/lynox-ai/lynox/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: ELv2](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**Run your business. Not your tools.**

One system that learns your business — replaces your CRM, workflows, outreach, and monitoring. Persistent knowledge graph, workflow capture, background worker. Open, self-hosted, no vendor lock-in.

## What it does

- **"Check my emails and tell me what's important"** — lynox reads your inbox, prioritizes, drafts replies in your tone. Tomorrow it remembers your style.
- **"Summarize this PDF"** — Drop a file, get structured key points. lynox saves the context for later.
- **"Research [topic] and give me the key points"** — Plans research phases, searches the web, cites sources, stores findings in the knowledge graph.
- **"Same as last Monday"** — lynox recognizes the pattern. "Want me to do this every Monday?" One tap, it's automated.
- **"What changed on competitor.com?"** — Started as a one-time check. Now runs weekly and alerts you via Telegram when something shifts.

## Quick start

```bash
curl -fsSL https://lynox.ai/install.sh | sh
```

You need an [Anthropic API key](https://console.anthropic.com/) — the setup wizard asks for it. That's all.

Already have Node.js 22+? `npx @lynox-ai/core` works too.

### Docker

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

## How it works

```
┌──────────────────────────────────────┐
│              You                     │
│  Web UI · Telegram · CLI · MCP      │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│            lynox                     │
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

**BYOK** — You provide your Anthropic API key. lynox calls the API directly. No proxy, no middleman, no data collection.

## Key capabilities

- **Knowledge Graph** — Learns entities, relationships, and contradictions across your business. 100 languages, fully local.
- **Web UI** — Primary interface. Chat, knowledge browser, run history, settings, integrations. Installable as PWA.
- **Background Worker** — Scheduled tasks, URL monitoring, recurring workflows.
- **Telegram Bot** — Secondary mobile interface. Voice, photos, files, follow-up suggestions.
- **Google Workspace** — Gmail, Sheets, Drive, Calendar, Docs via OAuth 2.0.
- **MCP Server** — Connect to Claude Desktop, Cursor, or any MCP client via stdio or HTTP.
- **Process Capture** — Teach lynox your workflow once, save it as a reusable template, schedule it.
- **4 Specialized Roles** — Researcher, Creator, Operator, Collector — each with scoped tools and budgets.
- **Security** — AES-256 encrypted vault, permission guard, input/output scanning, SSRF protection.

## Install

**Fastest** — open a terminal and paste:

```bash
curl -fsSL https://lynox.ai/install.sh | sh
```

**With Node.js 22+:**

```bash
npx @lynox-ai/core
```

> `better-sqlite3` needs C++ build tools. macOS: `xcode-select --install`. Ubuntu: `sudo apt-get install build-essential python3`.

### Clone & run

```bash
git clone https://github.com/lynox-ai/lynox.git
cd lynox && npm install
npm run dev
```

### Docker

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up
```

See [Docker docs](docs/docker.md) for Telegram, encryption, and production deployment.

## Your first run

After setup, lynox starts the Engine HTTP API and opens the Web UI in your browser:

```bash
npx @lynox-ai/core    # Starts Engine + opens Web UI
```

One-shot mode — run a task and exit:

```bash
npx @lynox-ai/core "Summarize the last 5 commits in this repo"
```

### Interactive REPL (for developers)

If you prefer a terminal-based interface:

```bash
npx @lynox-ai/core --repl
```

Or use Docker: `docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/lynox-ai/lynox:webui`

### Telegram (mobile)

Create a bot via [@BotFather](https://t.me/BotFather), add the token in Web UI → Settings → Integrations.


## Documentation

Architecture, tools, integrations, security, and deployment details are in [`docs/`](docs/).

## Community

- [GitHub Discussions](https://github.com/lynox-ai/lynox/discussions) — Questions, ideas, show & tell
- [GitHub Issues](https://github.com/lynox-ai/lynox/issues) — Bug reports, feature requests
- [Contributing](CONTRIBUTING.md) — Development setup and guidelines
- [Security](SECURITY.md) — Responsible disclosure

## License

[Elastic License 2.0](LICENSE) (ELv2) — free to use, modify, and self-host.

**What you can do:**
- Read, modify, and redistribute the source code
- Self-host lynox for your business, your clients, or your team
- Build commercial products and services on top of lynox

**The one restriction:** You may not offer lynox as a hosted service to third parties.

This protects the project's sustainability while keeping the code fully open. The same approach is used by Elasticsearch and CockroachDB. Questions? [Open an issue](https://github.com/lynox-ai/lynox/issues).

---

**[lynox.ai](https://lynox.ai)** · **[npm](https://www.npmjs.com/package/@lynox-ai/core)** · **[Changelog](CHANGELOG.md)**
