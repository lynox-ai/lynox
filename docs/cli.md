# CLI Reference

## Modes

### Interactive REPL

```bash
node dist/index.js
```

Full-featured REPL with animated bot icon banner, syntax-highlighted markdown output, interactive dialogs, footer bar, and tab-autocomplete for slash commands.

Input safeguards prevent runaway execution:
- **Control char sanitization** — non-printable characters (0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f) are stripped before processing
- **Ghost line debounce** — keypresses buffered during a run are discarded (150ms window)
- **Dedup guard** — identical consecutive inputs within 2 seconds are skipped
- **Rate limiter** — max 3 runs in 5 seconds; triggers a warning and returns to prompt

### Single Task

```bash
node dist/index.js "Your task here"
```

Runs the task, streams the response, and exits.

### Piped Input

```bash
echo "data" | node dist/index.js "Analyze this"
```

Auto-detected when stdin is not a TTY. Piped content is wrapped in `<input>` tags.

### Watch Mode

```bash
node dist/index.js --watch ./src --on-change "Review the changed files"
```

Monitors a directory for changes (recursive `fs.watch` with 500ms debounce) and runs the specified task on each batch of changes.

### MCP Server Mode

```bash
node dist/index.js --mcp-server                    # stdio transport
node dist/index.js --mcp-server --transport sse     # SSE transport
```

See [MCP Server](mcp-server.md) for details.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--resume` | Restore the latest saved session |
| `--project <dir>` | Change working directory and load project config |
| `--watch <dir>` | Enable watch mode on directory |
| `--on-change "task"` | Task to run on file changes (with `--watch`) |
| `--output <path>` | Save response to file (single-task mode) |
| `--mcp-server` | Start as MCP server |
| `--transport sse` | Use SSE transport for MCP server |
| `--task "description"` | Create a background task (processed by WorkerLoop) |
| `--manifest <path>` | Run a manifest file (DAG workflow) |
| `--pre-approve <glob>` | Pre-approve bash commands matching glob (repeatable) |
| `--no-pre-approve` | Disable fast-tier planning pass for pre-approvals |
| `--auto-approve-all` | Auto-approve low+medium risk patterns without dialog |
| `--version` | Show version |

## Slash Commands

All commands support tab autocomplete in the REPL.

### Conversation

| Command | Description |
|---------|-------------|
| `/clear` | Reset conversation (knowledge preserved). Alias: `/reset` |
| `/compact [focus]` | Compress conversation with optional focus instructions |
| `/save` | Save current session to `~/.nodyn/sessions/` |
| `/load [name]` | Load session (latest if no name given) |
| `/export [md\|file path]` | Export last response to file |

### Model

| Command | Description |
|---------|-------------|
| `/model [name]` | Switch model (opus/sonnet/haiku) or interactive select |
| `/accuracy [level]` | Set accuracy level or toggle thinking display (alias: `/effort`) |
| `/cost [subcommand]` | Show token usage and cost (`today`, `week`, `by-model`) |
| `/context` | Show context window usage as visual grid |

### Project

| Command | Description |
|---------|-------------|
| `/git [cmd]` | Git info: status (branch, ahead/behind, changes), diff, log, branch |
| `/pr` | Generate PR description from current branch |
| `/status` | Show version, model, mode, tools, MCP, knowledge, scopes |
| `/config [key] [value]` | Interactive settings pane, or direct get/set |

### Tools

| Command | Description |
|---------|-------------|
| `/tools` | List available tools and MCP servers |
| `/mcp <name> <url>` | Register an MCP server at runtime |
| `/approvals [subcommand]` | Pre-approval management (`list`, `show`, `export`) |
| `/hooks` | Show registered hooks and extension commands |
| `/plugin [subcommand]` | Manage plugins (`add`, `remove`, `list`) |

### Knowledge

| Command | Description |
|---------|-------------|
| `/memory [subcommand]` | Show knowledge (optional: knowledge/methods/project-state/learnings), gc [dry], embeddings (`list`, `prune`), scope (`info`, `list`, `create`, `tree`, `overrides`, `memory`, `stats`, `migrate`) |

### Session

| Command | Description |
|---------|-------------|
| `/mode` | Show current session status |

### Automation

| Command | Description |
|---------|-------------|
| `/pipeline [subcommand]` | Workflows (`list`, `plan`, `run`, `show`, `retry`, `history`, `chain`, `manifest`, `workflow`) |
| `/profile [subcommand]` | Profiles (`list`, `<name>`) |
| `/roles` | List the 4 built-in roles |
| `/batch [subcommand]` | Batches (`submit <file>`, `list`, `<id>`, `retry-failed`, `export`) |

### Tasks

| Command | Description |
|---------|-------------|
| `/task [subcommand]` | Task management (`list`, `add`, `done`, `start`, `show`, `edit`, `delete`) |
| `/task answer` | Answer a pending question from a background task |
| `/schedule [subcommand]` | Scheduled tasks (`list`, `details <id>`, `cancel <id>`, `test <cron>`) |

### History

| Command | Description |
|---------|-------------|
| `/runs [subcommand]` | List, search, show detail, or tree view (`tree <run_id>`) of past runs |
| `/stats [subcommand]` | Show usage statistics (`tools`, `export`, `prompts`, `workflows`) |
| `/history [search]` | Show or search command history |

### Identity

| Command | Description |
|---------|-------------|
| `/alias [subcommand]` | Command aliases (`list`, `create <name> <cmd>`, `delete <name>`) |
| `/secret [subcommand]` | Secrets (`list`, `set`, `delete`, `status`, `migrate`) |

### System

| Command | Description |
|---------|-------------|
| `/quickstart` | Guided first steps — 3 starter tasks to explore nodyn |
| `/help` | Show command help |
| `/exit` | Exit NODYN. Alias: `/quit` |

### Changeset Review

When `changeset_review` is enabled (default in interactive CLI), file writes are backed up before execution. After each run, if files were modified, an interactive review appears:

- **Summary**: file count, +/- line counts per file
- **Unified diff**: colored (green additions, red removals)
- **Decision**: `[A]ccept all`, `[R]ollback all`, or `[P]artial review` (per-file accept/reject)

Rollback restores original file contents. New files are deleted on rollback. Disable with `changeset_review: false` in config.

## Compact

Compress the current conversation into a summary, then reset and inject the summary as context. Useful when the context window is filling up but you want to keep working on the same topic.

```
/compact                          # Summarize entire conversation
/compact the database migration   # Summarize with focus on specific topic
```

The summary is generated by the agent, then the conversation is reset and the summary is loaded as synthetic context so the agent retains awareness of what was discussed.

## Status

Show current session information at a glance:

```
/status
```

Displays: version, model, accuracy level, tool count, MCP servers, knowledge status, active scopes, secrets, changeset review, cost, and session token stats.

## Config

Interactive settings pane or direct get/set:

```
/config                  # Interactive settings pane (toggle, select, text input)
/config default_tier     # Show specific key
/config effort_level max # Set value in ~/.nodyn/config.json
```

The interactive pane shows all settings with current values, sensitive keys masked. Toggles flip directly, selects show options, text/number fields use freeform input. Changes are saved to `~/.nodyn/config.json` immediately. API key changes require a restart.

Values are parsed as JSON when possible (numbers, booleans, objects), otherwise stored as strings.

## Context

Visualize context window usage as a colored grid:

```
/context
```

Shows a 10x5 grid where filled cells represent used context (green < 50%, yellow 50-80%, red > 80%). Also displays cache hit statistics and compaction warnings.

## Hooks

List registered hooks from plugins and extension commands:

```
/hooks
```

Shows loaded plugin names that provide hooks and any extension commands registered via `registerCommand()`.

## Model Switching

```
/model opus      # Switch to thorough (most capable)
/model sonnet    # Switch to balanced (default)
/model haiku     # Switch to fast (lightweight tasks)
/model           # Interactive select dialog
```

Aliases: `apex`=opus, `fast`=sonnet, `micro`=haiku.

## Accuracy Control

```
/accuracy low      # Minimal reasoning
/accuracy medium   # Moderate depth
/accuracy high     # Thorough (default)
/accuracy max      # Maximum depth
/accuracy show     # Toggle thinking display on/off
/accuracy         # Interactive select dialog
```

## Background Tasks

Use `--task` to create a background task processed by the WorkerLoop:

```bash
nodyn --task "Check website status every hour"
```

The agent recognizes natural language scheduling intents (e.g. "Every morning check...", "Research X and get back to me") and creates the appropriate background task automatically via `task_create`.

`/mode` shows current session status (no mode switching).

### Pre-Approval

Use `--pre-approve` to auto-approve bash commands matching glob patterns:

```bash
nodyn --pre-approve "npm run *" \
  --pre-approve "rm dist/**"
```

- Repeatable flag — each occurrence adds a pattern
- Default tool: `bash`, default risk: `medium`
- Critical operations (`sudo`, `rm -rf /`, `shutdown`, etc.) are silently filtered — can never be auto-approved
- Session-scoped by default (expires when process exits)
- Max 10 uses per pattern before falling back to normal permission prompt

## Session Management

```
/save              # Save session to ~/.nodyn/sessions/{timestamp}.json
/load              # Load most recent session
/load 2025-01-15   # Load session matching name fragment
```

Sessions store the full message history, enabling conversation resumption.

## Command History

All user inputs are appended to `~/.nodyn/history`. View with `/history` or search with `/history <term>`.

## Run History

Run history is persisted in `~/.nodyn/history.db` (SQLite). View past runs:

```
/runs              # List recent runs
/runs search term  # Search runs
/runs <id>         # Show run detail (cost, tokens, tools, status)
/runs tree <id>    # Spawn genealogy tree
/stats             # Aggregated usage statistics
```

Cost subcommands query the history DB:

```
/cost              # Current session cost
/cost today        # Today's cost across all sessions
/cost week         # This week's cost
/cost by-model     # Cost breakdown by model
```

## Aliases

```
/alias list                                            # List all aliases
/alias create summarize "Summarize the following text"  # Create alias
/alias delete summarize                                # Delete alias
/summarize                                             # Runs the aliased command
```

Stored in `~/.nodyn/aliases.json`.

## Profiles

Profiles are reusable agent configurations stored in `~/.nodyn/profiles/{name}.json`:

```json
{
  "systemPrompt": "You are a code reviewer...",
  "model": "sonnet",
  "effort": "high"
}
```

```
/profile list              # List available profiles
/profile <name>            # Load a profile
```

## Roles

4 built-in roles as a const map. Used via `spawn_agent`'s `role` field. No file-based CRUD.

Built-in roles: `researcher`, `creator`, `operator`, `collector`.

```
/roles                   # List available roles
```

## Workflows

Workflows are multi-role, multi-step agent packages that orchestrate role-based agents in a dependency graph. 3-tier resolution: project `.nodyn/workflows/` > user `~/.nodyn/workflows/` > built-in. Managed via `/pipeline workflow`.

3 built-in workflow templates: `code-review`, `feedback`, `research-report`.

```
/pipeline workflow list              # List available workflows with source and step count
/pipeline workflow show <id>         # Show workflow configuration as JSON
/pipeline workflow run <id>          # Run workflow (collects missing inputs interactively)
/pipeline workflow create <id>       # Scaffold a new custom workflow
/pipeline workflow delete <id>       # Remove a user workflow
/pipeline workflow import <path>     # Import workflow from JSON file
/pipeline workflow export <id>       # Export workflow as JSON
```

Running a workflow registers the `run_workflow` tool on demand, collects any missing required inputs via `InteractiveDialog`, then executes the workflow's DAG with role-based agents.

## Plugins

Plugins extend NODYN with custom tools and lifecycle hooks. Installed from npm.

```
/plugin list           # List installed plugins
/plugin add <name>     # Install plugin from npm
/plugin remove <name>  # Uninstall plugin
```

Plugin config in `~/.nodyn/config.json` under `plugins`.

## Knowledge Graph

Manage semantic knowledge with embeddings:

```
/memory embeddings list      # List stored embeddings
/memory embeddings prune     # Remove stale or duplicate entries
```

## Task Management

Manage tasks with deadlines, priorities, and scopes. Tasks are stored in SQLite (`~/.nodyn/history.db`, v12 migration).

### `/task` (no subcommand)

Shows a week overview: overdue, due today, due this week, and in progress tasks. Color-coded by urgency.

### Subcommands

```
/task list [--status open] [--scope client:x]   # Filtered table view
/task add "Title" [--due 2026-03-20] [--priority high] [--scope client:x]
/task done <id>                                  # Complete task + subtasks
/task start <id>                                 # Set status to in_progress
/task show <id>                                  # Show details + subtasks
/task edit <id> --title "..." --due ... --priority ...
/task delete <id>                                # Delete task + subtasks
```

### Agent Tools

The agent has 3 task tools (`task_create`, `task_update`, `task_list`) and is instructed to use them when users mention tasks, deadlines, or deliverables. The system prompt includes intent recognition for background tasks — natural language triggers in DE/EN (e.g. "Do this and get back to me", "Every Monday at 9am...", "Watch this website", "Remind me next week") are mapped to `task_create` with the appropriate fields (`assignee`, `schedule`, `watch_url`, `pipeline_id`). The agent also proactively offers to run long tasks in the background. Background tasks can ask questions via `ask_user` — the user is notified and the task pauses until they respond.

### Briefing Integration

Active tasks appear in the session briefing as `<task_overview>`:

```
<task_overview>
3 tasks due today, 1 overdue, 2 in progress.
Overdue: "Landing Page erstellen" (client:acme, due Mar 10, HIGH)
</task_overview>
```

The agent proactively mentions overdue items based on this briefing.

## UI Components

### Banner

Large bot icon rendered in brand purple gradient (256-color palette). The bot materializes bottom-to-top on startup, eyes flash white on "wake up", then the dashboard fades in beside the icon. Shows nodyn version, model, thinking mode, accuracy level, knowledge scope, tool count, and MCP server count. Response prefix uses 👾 emoji.

### Spinner

Braille-character spinner on stderr. Auto-stops on the first stream event. Supports `updateLabel()` for dynamic label changes (used for retry feedback during API errors).

### Markdown Renderer

Streaming markdown-to-ANSI renderer supporting:
- Bold, italic, bold+italic, strikethrough
- Inline code and code blocks with language labels
- Headers (levels 1-3) with inline formatting
- Ordered, unordered, and nested lists
- Horizontal rules
- Tables as box-drawn grids
- Blockquotes with `▎` bar
- Links with underlined text + dim URL

### Footer Bar

Separator + inline status line after each turn showing:
- Token counts (input/output) with elapsed time
- Context window usage bar (10-char `█░` bar, green/yellow/red by %)
- Cache hit percentage (green >= 50%, dim otherwise)
- Mode indicator (when a non-default mode is active)
- Thinking indicator (`👾 detailed` when detailed thinking is active)

### Diff Renderer

LCS-based line diff with red (removed) / green (added) coloring. Hunk-based output with collapsed unchanged regions. Shown before `write_file` permission prompts (when changeset review is disabled).

### Changeset Review

Post-run review UI for the Changeset Manager. Shows all file changes as colored unified diffs with Accept/Rollback/Partial options. Only active when `changeset_review` is enabled (default for interactive CLI).

### Interactive Dialog

Three auto-detected modes:

1. **Select**: Arrow keys, number jump, freeform fallback, "Other" as last option
2. **Confirm**: Allow/Deny buttons (auto-detected from `[y/N]` or `Allow?`)
3. **Freeform**: Text input

Plus **tabbed multi-question** dialogs with tab chip navigation and ESC-back.

Non-TTY graceful fallback for all modes.

## Setup Wizard

On first run without an API key (TTY mode), an interactive 6-step setup wizard runs automatically. Re-run anytime with `nodyn --init` or `nodyn init`.

1. **API key** — validates format (`sk-` prefix, 20+ characters) and live-verifies against the Anthropic API. Invalid keys rejected with retry. Network errors warned but key accepted
2. **Encryption** — optional vault key generation (AES-256-GCM). Saved atomically to `~/.nodyn/.env` (`0o600`). Auto-loaded on restart with symlink/ownership/permission validation
3. **Accuracy level** — thorough, balanced (default), or fast
4. **Telegram bot** — optional. Token + auto-detected chat ID (or manual entry)
5. **Web search** — optional Tavily API key for `web_research` tool
6. **Google Workspace** — optional OAuth 2.0 credentials. Auth completed later via `/google auth`

Writes `~/.nodyn/config.json` with secure permissions (0o700 dir, 0o600 file). After setup, a business profile onboarding asks 4 optional questions about your business. Re-run with `/profile update`.

See [Getting Started](getting-started.md) for a detailed walkthrough of each step.

## Pipe Mode

When stdin is not a TTY (piped input or single-task mode):

- **API key required** — exits with a clear error and setup instructions if no key is configured
- **Model info** — prints the active model ID to stderr before execution
- **Summary** — writes a JSON summary (`__NODYN_SUMMARY__`) to stderr after completion

## ESC Interrupt

During agent execution in the REPL, pressing **ESC** aborts the current run. The agent's `AbortController` is triggered, the stream is flushed, and `[interrupted]` is shown. Ctrl+C exits the process.

