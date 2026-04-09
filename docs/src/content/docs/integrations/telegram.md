---
title: Telegram
description: Access lynox from your phone via Telegram.
sidebar:
  order: 1
---

Telegram gives you mobile access to lynox. Send messages, voice notes, photos, and documents — lynox processes them and responds directly in the chat.

## Setup

### 1. Create a Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqr...`)

### 2. Get Your Chat ID

1. Send any message to your new bot
2. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id":12345678}` in the response — that's your chat ID

### 3. Configure lynox

**Via Web UI:** Go to Settings → Integrations → Telegram. Enter the bot token and follow the guided setup.

**Via environment variables:**

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
export TELEGRAM_ALLOWED_CHAT_IDS=12345678
```

**Via config file** (`~/.lynox/config.json`):

```json
{
  "telegram_bot_token": "123456789:ABCdefGHI...",
  "telegram_allowed_chat_ids": [12345678]
}
```

Multiple chat IDs are supported — separate with commas (env) or as an array (config).

### 4. Restart

Restart lynox for the changes to take effect. The bot will send a welcome message to confirmed chats.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/clear` | Reset conversation context |
| `/status` | Check if a task is running |
| `/stop` | Abort active background task |
| `/help` | Show available commands |
| `/cost` | Token usage (redirects to Web UI) |
| `/google` | Google auth setup (redirects to Web UI) |
| `/bug` | Report a bug (sends diagnostic info via Bugsink) |

## Supported Inputs

- **Text** — Processed as a task, same as the Web UI chat
- **Voice notes** — Transcribed automatically, then processed as text
- **Photos** — Analyzed using Claude's vision capabilities
- **Documents** — Downloaded and analyzed (up to 10 MB)

## Follow-Up Suggestions

After each response, lynox may suggest follow-up actions as inline buttons. Tap to execute them directly.

## Background Tasks

If a task takes time, lynox runs it in the background. You get a notification when it's done — with the result and follow-up options.

If lynox needs your input during a background task, it sends an inline question you can answer with a tap.

## Security

- **Chat ID restriction** — Only whitelisted chat IDs can interact with the bot
- **Rate limiting** — Built-in protection against excessive requests
- **No admin operations** — Setup and configuration always redirect to the Web UI

## Tips

- Telegram is best for quick tasks, status checks, and receiving notifications
- For complex work (configuration, reviewing memory, managing workflows), use the Web UI
- Voice notes are great for hands-free task input on the go
