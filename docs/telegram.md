# Telegram Bot

nodyn includes a built-in Telegram bot for hands-free operation. Send tasks to your bot, get rich status updates with tool details, and interact via inline keyboards.

> **Conversation context:** The bot maintains a sliding conversation window (last ~10 exchanges). You can refer to previous messages naturally — "now write tests for that", "fix the error from before". Older messages are automatically dropped to keep responses fast and costs low. Long-term knowledge (facts, preferences, decisions) is stored permanently and available even after the conversation window resets. Use `/clear` to start a fresh conversation.

## Architecture

```
Telegram API (long polling)
    ↕  HTTPS (outbound only)
nodyn process
    ├─ Engine (shared singleton)
    ├─ Session (per-conversation)
    ├─ Telegraf bot (message routing, commands)
    └─ TelegramNotificationChannel (background task notifications)
```

The Telegram bot runs in-process using `session.run()` directly — no MCP server needed. It also serves as a notification channel for background tasks via `TelegramNotificationChannel`, which is registered with the `NotificationRouter` on the Engine.

## Setup

### 1. Create a bot via @BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### 2. Start nodyn with Telegram

```bash
# Via environment variable (recommended)
ANTHROPIC_API_KEY=sk-ant-... TELEGRAM_BOT_TOKEN=123:ABC... npm run dev

# Or with --telegram flag
ANTHROPIC_API_KEY=sk-ant-... TELEGRAM_BOT_TOKEN=123:ABC... node dist/index.js --telegram
```

Auto-detection: if `TELEGRAM_BOT_TOKEN` is set, the bot starts automatically — no `--telegram` flag needed.

### 3. Docker

```bash
docker run -d \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e TELEGRAM_BOT_TOKEN=123:ABC... \
  -v ~/.nodyn:/home/nodyn/.nodyn \
  nodyn
```

### 4. Setup Wizard

The setup wizard (`nodyn --setup`) includes an optional Telegram step. The token is saved to `~/.nodyn/config.json` as `telegram_bot_token`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | No | Comma-separated chat IDs to restrict access |

## Security: Allowed Chat IDs

By default, anyone who finds your bot can use it. For production, restrict access:

```bash
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

> **Shared knowledge:** All users on the same bot share the same knowledge, memory, and history. Add multiple chat IDs only for people who work on the same business. For separate businesses, deploy separate nodyn instances (see [Docker — One instance = one business](docker.md#one-instance--one-business)).

To find your chat ID: send a message to the bot without `TELEGRAM_ALLOWED_CHAT_IDS` set — the bot will reply with your chat ID in the "Unauthorized" message.

## Usage

### Send a text message

Just send any text message to your bot. nodyn processes it as a task.

### File and image uploads

Send documents or photos to the bot. The file URL and caption are passed to the agent for analysis.

### Voice messages

Send a voice message to the bot. It will be transcribed automatically via whisper.cpp and processed as a text task. Both whisper and ffmpeg are included in the Docker image — no setup needed.

### Inline keyboards

When the agent needs input (e.g. permission prompts), the bot shows inline keyboard buttons. Tap to respond.

### Stop button

Every running task shows a Stop button. Tap it or send `/stop` to abort.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with capabilities |
| `/stop` | Abort the current running task |
| `/clear` | Start a fresh conversation (knowledge preserved) |
| `/status` | Show whether a task is running |
| `/bug` | Report a bug or issue (sent to Sentry). See [Error Reporting](sentry.md) |
| `/help` | List available commands |

## Rich Status Message

During execution, the bot edits a single status message to show progress. The status message is progressively updated — no intermediate messages are posted, keeping the chat clean.

### Status flow

```
🔵 Thinking… · 2.1s
💭 analyzing the code structure
          ↓ (edit)
🟡 Working… · 5.3s · 2 tools
✅ bash — npm test
⏳ read_file — src/index.ts
          ↓ (edit)
🟢 Done · 8.1s · 2 tools
✅ bash — npm test
✅ read_file — src/index.ts
```

### Status states

| Status | Meaning |
|--------|---------|
| 🔵 Thinking… | Agent is reasoning. Thinking summary shown below |
| 🟡 Working… N tools | Agent is executing tools. Tool list with input previews shown |
| 🔄 Iteration N/M | Agent continues in multi-turn mode |
| 🟢 Done — Xs, N tools | Task completed. Final tool list with ✅/❌ results |
| 🔴 Error | Task failed |
| 🛑 Stopped | Task was aborted |

### Tool details

Each tool call is shown in the status message with:
- **Status icon**: ⏳ pending, ✅ success, ❌ failed
- **Tool name**: `bash`, `read_file`, `write_file`, etc.
- **Input preview**: first command, file path, URL, or other context

When more than 6 tools are used, older entries are collapsed with a "… N earlier tools" indicator.

### Thinking summary

While the agent is thinking (before any tool calls), the status shows the last line of the thinking process as an italic summary. This disappears once tools start executing.

## Follow-Up Suggestions

After a task completes, the agent includes contextual follow-up suggestions directly in its response via a `<follow_ups>` JSON block. The Telegram system prompt instructs the agent to append 2-4 suggestions at the end of each response:

```
<follow_ups>[{"label":"Run tests","task":"Run the test suite to verify changes"}]</follow_ups>
```

`parseFollowUps()` extracts the block, strips it from the displayed text, and renders the suggestions as Telegram inline keyboard buttons. Labels are capped at 24 characters. The agent generates labels in the user's language — no static i18n mapping needed.

For error/abort cases (where the agent didn't produce a response), `fallbackFollowUps()` provides localized Retry and Explain buttons.

Tapping a follow-up button starts a new run with the suggested task. Suggestions expire when a new run starts.

## Business-Friendly UX

The Telegram bot is designed for non-technical business users. All internal implementation details are hidden behind friendly labels:

- **Tool names**: Status messages show labels like "Running command", "Reading file", "Delegating" instead of `bash`, `read_file`, `spawn_agent`. Labels are localized (DE/EN) via `friendlyToolName()` which reuses `TOOL_DISPLAY_NAMES` from `types/modes.ts` + German translations in `telegram-i18n.ts`
- **Error messages**: Technical errors (`ENOENT`, `401 Unauthorized`, `ETIMEDOUT`) are translated to plain language via `friendlyError()`. Unknown errors pass through unchanged
- **File paths**: Only filenames shown (no full paths) to prevent filesystem structure leaks
- **Cost display**: `/cost` shows only the dollar amount — no token counts or cache details
- **Secrets**: `/secret` explains in plain language that the admin configures credentials — no `.env`, `SSH`, or env var names
- **Document size**: Documents checked against `MAX_DOCUMENT_BYTES` (10 MB) before processing
- **Context trimming**: One-time notification when the sliding window drops older messages

## How Context Works

The bot maintains a **sliding conversation window** — the last ~10 exchanges (20 messages) are kept as context. This means you can refer back to recent messages naturally. When older messages are trimmed, the bot sends a one-time notification explaining that key findings are preserved in the Knowledge Graph.

**Short-term context** (conversation window):
- Recent messages, tool results, and decisions from the current conversation
- Dropped automatically when the window fills (oldest messages first)
- Cleared on `/clear` or after 30 minutes of inactivity

**Long-term knowledge** (permanent):
- Facts and preferences you share ("I use PostgreSQL", "our domain is example.com")
- Decisions you confirm ("we decided to use Lucia for auth")
- Business knowledge extracted automatically from your tasks

Use `/clear` to start a fresh conversation while keeping all long-term knowledge.

## Differences from CLI

| Feature | Telegram | CLI |
|---------|----------|-----|
| Conversation context | Sliding window (~10 exchanges) | Full session history |
| Long responses | Split at 4096 chars (auto) | Unlimited |
| Files (send/receive) | Documents, photos, voice | Filesystem |
| Interactive prompts | Inline keyboard buttons | Terminal prompts |
| Changeset review | Not available | Full diff review |
| Commands | `/start`, `/stop`, `/status`, `/help` | 30+ slash commands |
| Autonomy level | Guided (default) | All levels |
| Knowledge/memory | Works (stored per context) | Works |
| Tool execution | Full (bash, files, http, spawn) | Full |
| Multiple users | One task per chat, multiple chats | Single user |

## Rate Limiting

| Mechanism | Value | Purpose |
|-----------|-------|---------|
| Status edit throttle | 3s | Prevent API spam on edits |
| 429 backoff | `retry_after` | Respect Telegram rate limits |
| Stale timeout | 5 min | Abort if no stream events |

## Concurrency

One active run per chat. If you send a message while a task is running, the bot replies with a "busy" message. This keeps the UX simple and avoids resource contention for personal use.

## Background Task Notifications

When the WorkerLoop completes a background task, the `TelegramNotificationChannel` pushes the result to the user's Telegram chat. Notifications include:

- **Task result summary** (success or error)
- **Follow-up buttons** as inline keyboard:
  - **Details** — show full task output
  - **Run again** / **Retry** — re-execute the task (retry on error, run again on success)
  - **Explain** — ask the agent to explain what it did

Follow-up button callbacks use the `'t:'` prefix (e.g., `t:details:<task_id>`).

### Inquiry Handling

When a background task's agent needs user input (via `ask_user`), the question is sent to Telegram as an inline keyboard with the available options. The user taps a button, and the response is routed back to the paused task via `ActiveTask.pendingInput`.

- Inquiry callbacks use the `'q:'` prefix (e.g., `q:<task_id>:<option_index>`)
- The task resumes automatically once the user responds
- If no response is received, the task times out after the configured task timeout

## Source Files

| File | Purpose |
|------|---------|
| `src/integrations/telegram/telegram-bot.ts` | Telegraf setup, message routing, commands, follow-up callbacks |
| `src/integrations/telegram/telegram-runner.ts` | Run lifecycle, rich status edits, follow-up suggestion state |
| `src/integrations/telegram/telegram-formatter.ts` | Markdown→HTML, message splitting, `buildRichStatus`, `toolInputPreview`, `parseFollowUps`, inline keyboards |
| `src/core/telegram-notification.ts` | `TelegramNotificationChannel` — push notifications from background tasks, follow-up buttons (`'t:'` prefix), inquiry responses (`'q:'` prefix) |
