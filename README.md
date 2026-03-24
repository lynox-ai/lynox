# nodyn

[![npm version](https://img.shields.io/npm/v/@nodyn-ai/core)](https://www.npmjs.com/package/@nodyn-ai/core)
[![CI](https://github.com/nodyn-ai/nodyn/actions/workflows/ci.yml/badge.svg)](https://github.com/nodyn-ai/nodyn/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: ELv2](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**Open agent engine that gives any business persistent knowledge, autonomous workflows, and tool connections — running entirely in your own infrastructure.**

## Get started

```bash
npx @nodyn-ai/core
```

Needs [Node.js 22+](https://nodejs.org) and an [Anthropic API key](https://console.anthropic.com/). The setup wizard handles everything else — encryption, integrations, business profile — then drops you straight into the REPL.

## What can it do?

```
Monday, 09:12
you ›  "Run a competitive analysis on our top three accounts"
nodyn ›  fetching CRM → pulling Ads data → researching competitors → cross-referencing

  Account A: ROAS declining vs. competitor shift in brand keywords
  Account B: opportunity — competitor paused spend last week
  Account C: strong. no action needed.

  Stored to knowledge. Workflow scheduled for next Monday.

Three weeks later — a new client

you ›  "Same analysis for this new client"
nodyn ›  loading your analysis template → adapting to new account structure → running
  Done in 4 minutes. Report in /outputs/client-new-2026-03.md
```

No re-briefing. No copy-paste. nodyn picks up where you left off.

## Who is this for?

- **Solopreneurs** running five clients alone — nodyn handles the Monday workflow, flags what changed, drops reports in your inbox
- **Consultants** delivering audits at scale — teach nodyn your process once, it adapts to each client
- **Developers** who want business AI they actually own — local, transparent, no vendor lock-in

## Features

### Knowledge that compounds

- **Knowledge Graph** — Entities, relationships, contradiction detection, graph-augmented retrieval
- **Three knowledge levels** — Organization, project, personal — each with its own scope
- **100 languages** — Multilingual embeddings, fully local, no data leaves your machine

### Autonomous workflows

- **Multi-step automation** — Dependency graphs, conditions, parallel execution
- **Workflow capture** — Teach nodyn your process once, save it as a reusable template
- **7 built-in playbooks** — Research, Evaluation, Diagnosis, Synthesis, Assessment, Creation, Planning
- **Task management** — Priority, due dates, assignees — nodyn proposes working on tasks assigned to it

### Works where you work

- **Telegram bot** — Your primary interface for daily use. Rich status, follow-up suggestions, voice, file uploads
- **Google Workspace** — Gmail, Sheets, Drive, Calendar, Docs via OAuth 2.0
- **MCP server** — stdio + HTTP transport — connect to Claude Desktop, Cursor, or any MCP client
- **Secret vault** — AES-256-GCM encrypted storage for API keys and credentials

### You stay in control

- **Assistant or Autopilot** — You steer step by step, or set a goal and let nodyn run
- **8 specialized roles** — Researcher, Analyst, Executor, Strategist, Creator, and more
- **Pre-approval** — Glob-based auto-approval with audit trail for autonomous operation
- **Cost tracking** — Budget enforcement, cache accounting, daily and monthly caps

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
# Set your API key, then:
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up
```

Or without Compose:

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.nodyn:/home/nodyn/.nodyn \
  ghcr.io/nodyn-ai/nodyn:latest
```

See [Docker docs](docs/docker.md) for Telegram, encryption, and production deployment.

## Your first run

### Terminal

After setup you're in the interactive REPL. Type a task, press Enter:

```
❯ What can you do?
```

One-shot mode — run a task and exit:

```bash
npx @nodyn-ai/core "Summarize the last 5 commits in this repo"
```

### Telegram (recommended for daily use)

The setup wizard can configure Telegram for you, or set it up manually. Create a bot via [@BotFather](https://t.me/BotFather), then:

```bash
TELEGRAM_BOT_TOKEN=123:ABC... npx @nodyn-ai/core
```

Send messages from your phone. Get results when they're ready. Telegram is the primary interface for working with nodyn day to day — rich status updates, follow-up suggestions, voice messages, file uploads.

### Re-run setup

Reconfigure at any time:

```bash
npx @nodyn-ai/core --init
```

For SDK usage, see [docs/sdk.md](docs/sdk.md) and [`examples/`](examples/).

## How it works

```
┌───────────────────────────────────────────────────┐
│                   Your Input                      │
│          Terminal · Telegram · MCP · SDK           │
└─────────────────────┬─────────────────────────────┘
                      │
┌─────────────────────▼─────────────────────────────┐
│                  nodyn Engine                      │
│                                                    │
│  Knowledge       Roles          Workflows          │
│  (remembers)    (specializes)   (automates)        │
│                                                    │
│  Playbooks       Tools          Security           │
│  (strategizes)  (acts)          (protects)         │
└────────────────────────────────────────────────────┘
```

**BYOK** — You provide your Anthropic API key. nodyn calls the API directly. No proxy, no middleman, no data collection.

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
