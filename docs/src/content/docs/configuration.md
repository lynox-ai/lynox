---
title: "Configuration"
description: "Config tiers, environment variables, and profiles"
---

## Quick Settings

Most users only need these settings. Ask nodyn via Telegram or edit `~/.nodyn/config.json`:

| Setting | What it does | Default |
|---------|-------------|---------|
| `max_daily_cost_usd` | Daily spending limit for AI usage | No limit |
| `default_tier` | AI quality: `"opus"` (best), `"sonnet"` (fast), `"haiku"` (cheapest) | `"sonnet"` |
| `enforce_https` | Block unencrypted HTTP requests | `true` |
| `backup_schedule` | Automatic backup frequency | Not set |

Send `/cost` in Telegram to check your current spending. Everything else works out of the box.

---

## Config System (Technical Reference)

nodyn uses a 3-tier configuration merge (highest priority first):

1. **Environment variables** (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
2. **Project config** (`.nodyn/config.json` in project root) -- restricted to `PROJECT_SAFE_KEYS`
3. **User config** (`~/.nodyn/config.json`) -- full access

Project config cannot override sensitive keys (`api_key`, `api_base_url`) to prevent malicious project configs from exfiltrating credentials.

Config is loaded by `loadConfig()` in `src/core/config.ts`. The canonical `~/.nodyn` path is provided by `getNodynDir()` — all modules use this instead of hardcoded `join(homedir(), '.nodyn')`.

## NodynUserConfig

User configuration stored at `~/.nodyn/config.json`:

```typescript
interface NodynUserConfig {
  api_key?:              string;              // Anthropic API key
  api_base_url?:         string;              // Custom API endpoint (for proxies)
  default_tier?:         ModelTier;           // Default model tier
  thinking_mode?:        'adaptive' | 'disabled';
  effort_level?:         EffortLevel;         // 'low' | 'medium' | 'high' | 'max' (accuracy level)
  max_session_cost_usd?: number;              // Cost guard budget
  max_daily_cost_usd?:   number;              // Daily spending cap (persistent, across sessions)
  max_monthly_cost_usd?: number;              // Monthly spending cap (persistent, across sessions)
  max_http_requests_per_hour?: number;        // HTTP rate limit per hour (persistent)
  max_http_requests_per_day?:  number;        // HTTP rate limit per day (persistent)
  embedding_provider?:   'voyage' | 'onnx' | 'local';  // Embedding provider (default: 'onnx')
  embedding_model?:      'all-minilm-l6-v2' | 'multilingual-e5-small' | 'bge-m3';  // ONNX model (default: 'multilingual-e5-small')
  knowledge_graph_enabled?: boolean;              // Knowledge Graph (default: true). Always enabled — field retained for migration compatibility
  plugins?:              Record<string, boolean>;  // Plugin enable/disable map
  changeset_review?:     boolean;                 // Backup files before write, review post-run (default: true; mandatory for autonomous modes)
  google_oauth_scopes?:  string[];                // Google OAuth scopes (default: read-only). Add write scopes as needed
  enforce_https?:        boolean;                 // Block plain HTTP requests except localhost (default: false)
  sentry_dsn?:           string;                  // Sentry DSN for opt-in error reporting
  backup_dir?:           string;                  // Backup storage directory (default: ~/.nodyn/backups)
  backup_schedule?:      string;                  // Cron schedule for auto-backups (default: '0 3 * * *')
  backup_retention_days?: number;                 // Days to keep old backups (default: 30)
  backup_encrypt?:       boolean;                 // Encrypt backups (default: true when vault key set)
  backup_gdrive?:        boolean;                 // Upload backups to Google Drive (default: true when Google auth has drive.file scope)
  mcp_servers?:          [{name, url}];           // Persistent MCP server connections, loaded on every startup
}
```

File permissions: directory created with `0o700`, file written with `0o600` (atomic write).

## Setup Wizard

On first run without an API key (TTY mode), a streamlined wizard guides through two interactions:

1. **API key** — validates format (`sk-` prefix, 20+ characters) and live-verifies against the Anthropic API. Invalid keys rejected with retry. Network errors produce a warning but the key is accepted. Encryption is enabled automatically (vault key generated and saved to `~/.nodyn/.env` with mode `0o600`). Accuracy defaults to Balanced (sonnet)
2. **Integrations checklist** — interactive multi-select (arrow keys + Space to toggle + Enter to confirm). Three options, all optional:
   - **Google Workspace** — OAuth 2.0 client ID + secret for Gmail, Sheets, Drive, Calendar, Docs. Actual auth deferred to `/google auth` command
   - **Telegram** — bot token + auto-detect chat ID by spinning up the bot and waiting for a message. Falls back to manual entry
   - **Web Research** — Tavily API key for the `web_research` tool (free tier: 1K/month)

**Prerequisites check** runs before the wizard: Node.js version, `~/.nodyn` directory, network connectivity.

**Security**: Vault key file written atomically with `0o600` permissions. Auto-load on startup validates: no symlinks, owner-only access, base64 format. Shell profile injection uses `basename($SHELL)`, append-only with duplicate guard, single quotes in fallback. Config written with `0o700` dir / `0o600` file. See [Security](/security/#vault-key-auto-load-security).

**Seamless flow**: Vault key is set in `process.env` immediately, config cache invalidated — the REPL starts with encryption active, no restart needed. `--init` continues directly into the REPL instead of exiting.

**Docker**: The entrypoint auto-loads `~/.nodyn/.env` on startup. Run `docker run -it ... --init` to use the wizard in a container.

After setup, nodyn starts a natural conversation to learn about your business. Everything is stored in the knowledge graph automatically.

## NodynConfig (Engine)

Top-level configuration for the `Engine` singleton:

```typescript
interface NodynConfig {
  model?:        ModelTier;       // Default: 'opus'
  systemPrompt?: string;          // Custom system prompt
  thinking?:     ThinkingMode;    // Default: { type: 'adaptive' }
  effort?:       EffortLevel;     // Default: 'high' (accuracy level)
  maxTokens?:    number;          // Default: model-aware (Opus 32K, Sonnet 16K, Haiku 8K)
  mcpServers?:   MCPServer[];     // External MCP servers
  memory?:       boolean;         // Default: true (knowledge system)
  promptUser?:   Function;        // Interactive permission callback
  promptTabs?:   Function;        // Multi-question dialog callback
}
```

## SessionOptions

Per-session configuration for `engine.createSession()`:

```typescript
interface SessionOptions {
  model?:              ModelTier;       // Override engine default
  effort?:             EffortLevel;     // Override engine default
  thinking?:           ThinkingMode;    // Override engine default
  autonomy?:           AutonomyLevel;   // 'supervised' | 'guided' | 'autonomous'
  briefing?:           string;          // Initial session briefing
  systemPromptSuffix?: string;          // Appended to system prompt
}
```

Session-level settings mutated via `session.setModel()`, `session.setEffort()`, `session.setThinking()` only affect that session, not the engine or other sessions.

## Automatic Behaviors

These behaviors run automatically on `Engine.init()` without configuration:

| Behavior | Trigger | Details |
|----------|---------|---------|
| **Pre-update backup** | Version change detected | Compares `~/.nodyn/.last_version` with current package version. Creates a full backup before anything else runs. See [Backup](/backup/#pre-update-backup) |
| **Debug logging** | `NODYN_DEBUG` env var | Activates diagnostic channel subscribers |
| **Security audit** | Always (when run history available) | Subscribes to security channels, logs to `history.db` |

## Worker Configuration

The WorkerLoop runs automatically in server modes (Telegram, MCP) where an Engine is long-lived. It executes scheduled, watch, and pipeline background tasks.

| Setting | Value | Location |
|---------|-------|----------|
| Tick interval | 60s | `core/worker-loop.ts` |
| Task timeout | 5min (300,000ms) | `core/constants.ts` (`DEFAULT_TASK_TIMEOUT_MS`) |
| Max iterations per task | 30 | `core/constants.ts` (`WORKER_MAX_ITERATIONS`) |
| Retry backoff | 1min to 30min cap | exponential |

The WorkerLoop is started on `engine.init()` and stopped on `engine.shutdown()`.

## AgentConfig

Configuration for individual `Agent` instances:

```typescript
interface AgentConfig {
  name:              string;          // Agent identifier
  model:             string;          // Full model ID (from MODEL_MAP)
  systemPrompt?:     string;          // System prompt text
  tools?:            ToolEntry[];     // Available tools
  mcpServers?:       MCPServer[];     // MCP server connections
  thinking?:         ThinkingMode;    // Thinking configuration
  effort?:           EffortLevel;     // Accuracy level
  maxTokens?:        number;          // Max output tokens
  memory?:           IMemory;         // Memory instance
  onStream?:         StreamHandler;   // Stream event callback
  workerPool?:       IWorkerPool;     // Worker thread pool
  promptUser?:       Function;        // Permission callback
  promptTabs?:       Function;        // Tabbed dialog callback
  apiKey?:           string;          // API key (from config)
  apiBaseURL?:       string;          // API base URL (from config)
  currentRunId?:     string;          // Current run ID for history
  briefing?:         string;          // Session briefing from recent runs
  maxIterations?:    number;          // Max loop iterations (default: 20)
  continuationPrompt?: string;       // Auto-continue prompt after iteration limit
  excludeTools?:     string[];       // Filter tools from API calls
  autonomy?:         AutonomyLevel;  // 'supervised' | 'guided' | 'autonomous'
  preApproval?:      PreApprovalSet; // Pre-approval patterns for autonomous modes
  audit?:            PreApproveAuditLike; // Audit trail for pre-approval decisions
  knowledgeContext?: string;         // Knowledge context (set by Session, not user)
  changesetManager?: ChangesetManagerLike; // Changeset manager for backup-before-write mode
}
```

## Accuracy Levels

| Level | Model | Context | Default max_tokens |
|-------|-------|---------|-------------------|
| Thorough | `opus` | 1M | 32,000 |
| Balanced | `sonnet` | 200K | 16,000 |
| Fast | `haiku` | 200K | 8,192 |

The CLI defaults to balanced (`sonnet`). Switch at runtime with `/model` or `/accuracy`.

## ThinkingMode

```typescript
type ThinkingMode =
  | { type: 'enabled'; budget_tokens: number }  // Fixed thinking budget
  | { type: 'adaptive' };                       // Claude decides depth (default)
```

## EffortLevel

```typescript
type EffortLevel = 'low' | 'medium' | 'high' | 'max';
```

Controls the `output_config.effort` parameter (accuracy level). Set via config, `/accuracy` command, or `nodyn.setEffort()`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | -- | Anthropic API key (required) |
| `ANTHROPIC_BASE_URL` | -- | Custom API endpoint (for proxies) |
| `NODYN_VAULT_KEY` | -- | Encrypts secrets vault, run history, and OAuth tokens at rest. Auto-loaded from `~/.nodyn/.env` on startup (with symlink, ownership, and permission validation). Generate: `openssl rand -base64 48` |
| `NODYN_MCP_SECRET` | -- | Bearer token for MCP HTTP auth. Required for network-exposed deployments. Can also be stored in vault. Generate: `openssl rand -hex 32` |
| `NODYN_MCP_PORT` | `3042` | MCP HTTP server port |
| `NODYN_EMBEDDING_PROVIDER` | `onnx` | Override embedding provider (`onnx`, `voyage`, `local`) |
| `NODYN_WORKSPACE` | -- | Workspace sandbox root (set in Docker) |
| `NODYN_USER` | -- | User scope identity for multi-scope memory |
| `NODYN_DEBUG` | -- | Debug logging: `1`/`true`/`*` for all, or comma-separated groups |
| `TELEGRAM_BOT_TOKEN` | -- | Telegram bot token — auto-starts bot mode |
| `TELEGRAM_ALLOWED_CHAT_IDS` | -- | Comma-separated chat IDs to restrict bot access |
| `GOOGLE_CLIENT_ID` | -- | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | -- | Google OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | -- | Path to service account JSON key file (headless/Docker) |
| `TAVILY_API_KEY` | -- | Tavily API key for web search |
| `BRAVE_API_KEY` | -- | Brave Search API key (alternative to Tavily) |
| `NODYN_SENTRY_DSN` | -- | Sentry DSN for opt-in error reporting. See [Error Reporting](/sentry/) |

## Profiles

Profiles are JSON files in `~/.nodyn/profiles/{name}.json`:

```json
{
  "systemPrompt": "You are a senior code reviewer. Focus on correctness, performance, and security.",
  "model": "sonnet",
  "effort": "high"
}
```

Load with `/profile <name>` in the CLI. List available profiles with `/profile list`.

## Aliases

Aliases map custom commands to task strings, stored in `~/.nodyn/aliases.json`:

```json
{
  "review": "Review this code for bugs and security issues",
  "summarize": "Summarize the following concisely"
}
```

Create with `/alias <name> <command>`. Use with `/<name>` in the REPL.

## Plugins

Plugins extend nodyn with custom tools and lifecycle hooks:

```json
{
  "plugins": {
    "nodyn-plugin-jira": true,
    "nodyn-plugin-slack": false
  }
}
```

Plugins are installed from npm into `~/.nodyn/plugins/node_modules/`. Plugin names validated against `NPM_NAME_RE`. Secrets (`api_key`, `api_base_url`) are stripped from the `PluginContext` passed to plugins.

Manage via `/plugin add|remove|list`.

## MCP Server Configuration

Register external MCP servers either in config or at runtime:

```typescript
// In NodynConfig (passed to Engine)
const engine = new Engine({
  mcpServers: [
    { type: 'url', name: 'my-server', url: 'http://localhost:8080' }
  ],
});

// At runtime
engine.addMCP({ type: 'url', name: 'my-server', url: 'http://localhost:8080' });
```

Or via CLI:

```
/mcp my-server http://localhost:8080
```

## Beta Headers

All beta API calls include:

```typescript
const NODYN_BETAS: AnthropicBeta[] = [
  'token-efficient-tools-2025-02-19',
];
```

## Pricing

Built-in cost tracking (per 1M tokens):

| Tier | Input | Output | Cache Write | Cache Read |
|------|-------|--------|-------------|------------|
| Thorough (`opus`) | $15 | $75 | $18.75 | $1.50 |
| Balanced (`sonnet`) | $3 | $15 | $3.75 | $0.30 |
| Fast (`haiku`) | $0.80 | $4 | $1.00 | $0.08 |

View with `/cost` in the CLI. Costs shown in both USD and CHF. Optional pricing override via `~/.nodyn/pricing.json`.
