# Tool System

## ToolRegistry

The `ToolRegistry` (`src/tools/registry.ts`) manages tool registration and lookup:

```typescript
const registry = new ToolRegistry();
registry.register(bashTool);       // Register a builtin tool
registry.registerMCP(server);      // Register an MCP server
registry.find('bash');             // Lookup by name
registry.getEntries();             // All registered tools
registry.getMCPServers();          // All MCP servers
registry.scopedView({ deniedTools: ['bash'] });  // Filtered view for role-based scoping
```

### `scopedView(config: ToolScopeConfig)`

Returns a filtered copy of registered tools based on `allowedTools` (whitelist) and/or `deniedTools` (blacklist). Used by `spawn_agent` to enforce role-based tool restrictions on child agents.

## ToolEntry Contract

Every tool implements the `ToolEntry` interface:

```typescript
interface ToolEntry<TInput = unknown> {
  definition: BetaTool;          // Name, description, input_schema
  handler: ToolHandler<TInput>;  // (input, agent) => Promise<string>
}
```

The handler receives the parsed input and a reference to the calling `IAgent` (for accessing memory, promptUser, etc.).

## Builtin Tools Reference

### `bash` -- Shell Execution

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/bash.ts` |
| Timeout | 120s (configurable via `timeout_ms`) |
| Max buffer | 10MB |
| Eager streaming | Yes |

Executes shell commands via `execSync`. Returns stdout on success, combined stdout+stderr on failure. Uses an **env var allowlist** — only safe prefixes (PATH, HOME, NODE_*, GIT_*, etc.) are passed to subprocesses. All secrets and API keys are stripped. See [Security](security.md#env-var-allowlist).

**Isolation env filtering** (`setIsolationEnv()`): Available as an extension point for Pro. When a tenant context is active (via `nodyn-pro`), the env passed to subprocesses is further restricted based on isolation level. Air-gapped tenants receive a minimal env (PATH, HOME, TMPDIR only). Sandboxed tenants can inject custom env vars via `IsolationConfig.envVars`. Shared and scoped levels use the default allowlist.

### `read_file` -- File Read

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/fs.ts` |
| Input | `path` (absolute) |
| Eager streaming | Yes |

Reads file contents as UTF-8.

### `write_file` -- File Write

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/fs.ts` |
| Input | `path`, `content` |
| Eager streaming | Yes |

Writes content to a file. Creates parent directories as needed. Resolves symlinks before writing to prevent symlink traversal attacks.

### `memory_store` -- Store Knowledge

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/memory.ts` |
| Input | `namespace` (knowledge/methods/project-state/learnings), `content` |
| Eager streaming | Yes |

Appends content to a knowledge namespace. Deduplicates -- skips if content already exists.

### `memory_recall` -- Recall Knowledge

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/memory.ts` |
| Input | `namespace` |
| Eager streaming | Yes |

Returns the contents of a knowledge namespace.

### `spawn_agent` -- Sub-Agent Spawning

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/spawn.ts` |
| Input | `agents` array of `SpawnSpec` |
| Eager streaming | Yes |
| Timeout | 10 minutes per agent |

Creates a new `Agent` instance per sub-agent. Supports **role-based spawning** — set `role` to a role ID (e.g. `researcher`, `creator`, `operator`, `collector`) to apply the role's model, system prompt, and tool restrictions automatically.

**SpawnSpec fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string (required) | Agent display name |
| `task` | string (required) | Task to execute |
| `role` | string | Role ID — loads defaults from the role registry |
| `context` | string | Additional context prepended to task as `<context>` block |
| `isolated_memory` | boolean | If true, child has no access to parent knowledge |
| `system_prompt` | string | Override role/default system prompt |
| `model` | ModelTier | Override role/default model |
| `thinking` | ThinkingMode | Override thinking mode |
| `effort` | EffortLevel | Override accuracy level |
| `tools` | string[] | Explicit tool whitelist (overrides role scoping) |
| `max_turns` | number | Max iterations |
| `max_tokens` | number | Max output tokens |
| `max_budget_usd` | number | Cost budget |

**3-tier resolution order:** explicit spec fields > role defaults > global defaults (`sonnet`, all tools).

**Tool scoping:**
1. `spec.tools` set → filter parent tools to only those names
2. Role has `allowedTools`/`deniedTools` → apply role scoping
3. Default → all parent tools minus `spawn_agent`

`spawn_agent` is always excluded from children to prevent recursion.

Agents run in parallel via `Promise.allSettled`. If all fail, throws `AggregateError` with details. Cancellation via `AbortController` with 10-minute timeout.

### `ask_user` -- Interactive Prompting

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/ask-user.ts` |
| Modes | Select, confirm, freeform, tabbed |

The agent should use `ask_user` **proactively** — don't guess preferences or decisions. `options` should **always** be provided when the set of possible answers is finite (yes/no, file picks, deploy targets, approach selection). Free-text only for truly open-ended input.

Three input modes:

1. **Single question with options** (preferred): `{ question: "...", options: ["Yes", "No"] }` — 2-5 clear, distinct choices
2. **Tabbed multi-question**: `{ question: "...", questions: [...] }` -- sequential tabs with navigation
3. **Non-interactive fallback**: Returns "Interactive input not available" when no `promptUser` callback

In Slack, questions with `options` render as interactive buttons. Questions without options show a "Reply in this thread" prompt for free-text input.

### `batch_files` -- Batch File Operations

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/batch-files.ts` |
| Operations | rename, move, transform |
| Input | `pattern`, `directory`, `operation`, plus operation-specific fields |

- **rename**: Renames matching files using `$1` substitution pattern
- **move**: Moves matching files to a destination directory
- **transform**: Find-and-replace in file contents (skips files > 10MB)

### `http_request` -- HTTP Client

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/http.ts` |
| Methods | GET, POST, PUT, DELETE, PATCH, HEAD |
| Response limit | 100KB (configurable via `http_response_limit`, truncated with hint) |
| SSRF protection | Yes |

Makes HTTP requests with full SSRF protection (see [Security](security.md)). Returns status, headers, and body. JSON responses are pretty-printed.

**Network policy enforcement** (`setNetworkPolicy()`): Available as an extension point for Pro. When a tenant context is active (via `nodyn-pro`), the http tool enforces the tenant's network policy. `allow-all` (default) permits any request. `allow-list` restricts requests to hostnames in `IsolationConfig.allowedHosts`. `deny-all` blocks all outbound HTTP requests. See [Security](security.md#isolation-levels).

### `run_pipeline` -- Run Workflow

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/pipeline.ts` |
| Input | `steps[]` or `pipeline_id`, `on_failure?`, `context?`, `retry?`, `modifications?` |
| Eager streaming | Yes |
| Max steps | 20 |

Execute a multi-step workflow. Two modes: provide `steps[]` for inline execution, or `pipeline_id` to run a stored workflow (from `plan_task` or saved workflows). Steps without `input_from` dependencies execute in parallel automatically. Supports `retry: true` for re-running failed steps, and `modifications` (remove/update_task) for stored workflows. Step results truncated at 50KB (configurable via `pipeline_step_result_limit`).

### `task_create` -- Create Task

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/task.ts` |
| Input | `title`, `description?`, `priority?`, `due_date?`, `scope?`, `tags?`, `parent_task_id?`, `schedule?`, `watch_url?`, `watch_interval_minutes?`, `pipeline_id?` |
| Eager streaming | Yes |

Creates a task in the SQLite task store. Supports scope validation against active scopes, subtask creation via `parent_task_id`, and date validation (YYYY-MM-DD). Returns the created task summary.

**Task types** determined by input fields:

| Type | Created when | Behavior |
|------|-------------|----------|
| `manual` | Default (no scheduling fields) | Standard task, executed on demand |
| `scheduled` | `schedule` field set (cron expression or shorthand like `every 5 minutes`) | WorkerLoop picks up at scheduled times |
| `watch` | `watch_url` field set | WorkerLoop polls the URL at `watch_interval_minutes` (default: 60), triggers on content change |
| `pipeline` | `pipeline_id` field set | WorkerLoop executes the stored pipeline workflow |

Background tasks with `assignee='nodyn'` auto-trigger immediately (`nextRunAt=now`).

### `task_update` -- Update Task

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/task.ts` |
| Input | `task_id`, `status?`, `priority?`, `due_date?`, `title?`, `description?`, `tags?` |
| Eager streaming | Yes |

Updates task fields. Setting `status: "completed"` also completes all subtasks and sets `completed_at`. Task IDs support prefix matching.

### `task_list` -- List Tasks

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/task.ts` |
| Input | `scope?`, `status?`, `due?` (today/week/overdue), `limit?` |
| Eager streaming | Yes |

Lists tasks filtered by scope, status, or due date range. Results are ordered by priority (urgent > high > medium > low), then by due date. Default limit: 20.

### `plan_task` -- Structured Planning with Workflow Bridge

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/plan-task.ts` |
| Input | `summary`, `context?`, `phases?`, `steps?` |
| Registration | At init (always available) |

Presents a structured plan to the user for approval before executing complex tasks. On approval with phases, auto-converts to a runnable workflow and returns a `pipeline_id` for `run_pipeline`.

**Schema** (simplified for LLM reliability — runtime assigns model, role, and effort):
- `summary`: What will be done (plain language)
- `context`: Exploration findings (`summary`, `findings[]`)
- `phases[]`: Steps with `name`, `steps[]`, `verification?`, `depends_on?`, `assignee?` (`"agent"` | `"user"`)
- `steps[]`: Legacy flat step list (no workflow conversion)

**Workflow bridge**: Agent phases are auto-converted to executable workflow steps. User phases (`assignee: "user"`) excluded — handled via `ask_user` or `task_create`. Cost estimate shown before approval.

**Presentation**: Business-friendly numbered list. User phases marked `[your input needed]`. No model names or dependency syntax.

### `capture_process` -- Process Capture

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/process.ts` |
| Input | `name`, `description?` |
| Registration | Dynamic (with workflow tools) |

Captures the current session's work as a reusable process template. Reads tool calls from `run_history` (structured data, not LLM knowledge), filters internal tools, and uses a fast-tier call (~$0.001) to name steps and identify parameters (fixed vs. variable elements).

Returns a `ProcessRecord` with typed steps, parameters (with source classification: `user_input`, `relative_date`, `context`), and defaults. Stored in SQLite `processes` table for cross-session availability.

### `promote_process` -- Workflow Promotion

| Property | Value |
|----------|-------|
| Source | `src/tools/builtin/process.ts` |
| Input | `process_id`, `parameter_values?` |
| Registration | Dynamic (with workflow tools) |

Converts a captured process into a reusable workflow. Steps are organized into a dependency graph. Parameters become workflow context variables with `{{param}}` templates. Returns `pipeline_id` for `run_pipeline`.

### `web_search` -- Web Search (Native)

Built-in Anthropic server tool (`web_search_20250305`). Added automatically to every agent's tool list. No custom handler needed.

### `web_research` -- Web Search Tool (Tavily / Brave)

Client-side web search and content extraction tool. Registered conditionally when `TAVILY_API_KEY` or `BRAVE_API_KEY` is set.

**Actions:**
- `search` — Search the web. Returns numbered results with title, URL, snippet, and optionally full content (Tavily). Supports `max_results` (default 5, max 20), `topic` (general/news/finance, Tavily only), and `time_range` (day/week/month/year).
- `read` — Extract main content from a URL using Readability. Returns clean text with title, word count, and truncation indicator. SSRF-protected.

**Providers:**
- **Tavily** (default): Free tier 1,000 searches/month. Returns AI-optimized parsed content. Key prefix: `tvly-`.
- **Brave**: Privacy-focused, own index. Requires `X-Subscription-Token` header.

**Configuration:** `TAVILY_API_KEY` env var, or `search_api_key` + `search_provider` in `~/.nodyn/config.json`.

## Eager Input Streaming

Most builtin tools enable `eager_input_streaming: true` in their definition:

```typescript
definition: {
  name: 'bash',
  eager_input_streaming: true,
  // ...
}
```

This enables 5x faster delivery of the first tool parameter from the streaming API.

## Worker Pool

> **Note:** The worker pool is a Pro feature provided by `nodyn-pro`. It registers via Orchestrator Hooks (`onInit`/`onShutdown`).

The `WorkerPool` runs tools off the main thread using `node:worker_threads`:

- **Pool size**: 4 workers (default)
- **Safe tools**: `bash`, `read_file`, `write_file`
- **Resource limits**: 256MB max old generation per worker
- **Queue**: Tasks queue when all workers are busy
- **Auto-recovery**: Workers respawn on crash
- **Cancellation**: `AbortSignal` support -- terminates worker and respawns
- **Spawn failure handling**: `EAGAIN` / `ERR_WORKER_INIT_FAILED` are caught in try/catch — no uncaught throw in event handlers
- **Backoff on init failure**: `ERR_WORKER_INIT_FAILED` triggers exponential backoff: 1s → 2s → 4s → … → 30s cap before retrying
- **Normal crashes**: Non-init worker crashes still respawn immediately (no backoff)

The agent automatically routes worker-safe tools through the pool:

```typescript
const result = this.workerPool && this.workerPool.isWorkerSafe(tc.name)
  ? await this.workerPool.execute(tc.name, tc.input)
  : await tool.handler(tc.input, this);
```

## Google Workspace Tools

Available when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are configured. Users authenticate via `/google auth` (OAuth 2.0 device flow). Service account auth supported via `GOOGLE_SERVICE_ACCOUNT_KEY` for headless/Docker deployments. Default OAuth scopes are **read-only**; write scopes opt-in via `google_oauth_scopes` config or `requestScope()` at runtime.

**Security**: All Google tool responses are scanned for prompt injection via `scanToolResult()`. All read handlers wrap external content with `wrapUntrustedData()` boundary markers. `ToolCallTracker` detects exfiltration patterns (Google read → email send, HTTP POST, or sensitive file read). Write actions require user confirmation and are blocked in autonomous mode. See [Security: Google Workspace Injection Hardening](security.md#google-workspace-injection-hardening-v4).

### `google_gmail`

Interact with Gmail via REST API.

| Action | Description | Confirmation |
|--------|-------------|-------------|
| `search` | Search emails using Gmail query syntax (`from:`, `is:unread`, etc.) | No |
| `read` | Read full email content (HTML→text conversion) | No |
| `send` | Compose and send new email | **Yes** |
| `reply` | Reply to thread (sets `In-Reply-To`/`References` headers) | **Yes** |
| `draft` | Save draft without sending | No |
| `archive` | Remove INBOX label | **Yes** |
| `mark_read` | Remove UNREAD label | No |
| `labels` | List all labels with counts | No |

Scopes: `gmail.readonly` (search/read/labels), `gmail.send` (send/reply/draft), `gmail.modify` (archive/mark_read).

### `google_sheets`

Interact with Google Sheets via REST API.

| Action | Description | Confirmation |
|--------|-------------|-------------|
| `read` | Read range as markdown table | No |
| `write` | Overwrite range with values | **Yes** |
| `append` | Append rows after existing data | No |
| `create` | Create new spreadsheet | No |
| `list` | List spreadsheets from Drive | No |
| `format` | Apply batchUpdate formatting | No |

Scopes: `spreadsheets.readonly` (read/list), `spreadsheets` (write/append/create/format).

### `google_drive`

Interact with Google Drive via REST API.

| Action | Description | Confirmation |
|--------|-------------|-------------|
| `search` | Search files with Drive query syntax | No |
| `read` | Read file content (auto-exports Google Docs as text) | No |
| `upload` | Upload file (multipart) | **Yes** |
| `create_doc` | Create Google Doc from text content | **Yes** |
| `list` | List folder contents | No |
| `move` | Move file between folders | **Yes** |
| `share` | Share file with email/role | **Yes** |

Scopes: `drive.readonly` (search/read/list), `drive.file` (upload/create_doc), `drive` (move/share).

### `google_calendar`

Interact with Google Calendar via REST API.

| Action | Description | Confirmation |
|--------|-------------|-------------|
| `list_events` | List upcoming events (default: next 7 days) | No |
| `create_event` | Create event (with optional attendees, sends invites) | **Yes** |
| `update_event` | Update existing event | **Yes** |
| `delete_event` | Delete event | **Yes** |
| `free_busy` | Check availability across calendars | No |

Scopes: `calendar.readonly` (list_events/free_busy), `calendar.events` (create/update/delete).

### `google_docs`

Interact with Google Docs via REST API.

| Action | Description | Confirmation |
|--------|-------------|-------------|
| `read` | Read document as markdown | No |
| `create` | Create document from markdown content | **Yes** |
| `append` | Append text to end of document | No |
| `replace` | Find and replace text | **Yes** |

Scopes: `documents.readonly` (read), `documents` (create/append/replace).
