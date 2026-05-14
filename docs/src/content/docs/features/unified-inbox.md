---
title: Unified Inbox
description: One inbox for mail and chat — classifier-driven triage, three zones, AI drafts, mail-anchored reminders.
sidebar:
  order: 0
---

The **Unified Inbox** (`/app/inbox`) is lynox's primary email surface. Instead of a flat "all mail" list, every incoming message is classified into one of three zones the moment it arrives, so the inbox you open already reflects what needs you, what doesn't, and what's waiting for a reply.

WhatsApp Business messages join the same inbox when the WhatsApp integration is connected — same zones, same drafts, same reminders. The "Unified" in the name is about merging channels under one triage model, not about a separate WhatsApp UI.

:::tip[Default off — flip the flag]
The Unified Inbox is gated behind a feature flag while the classifier graduates. Set `LYNOX_FEATURE_UNIFIED_INBOX=true` (or flip it in `~/.lynox/config.json`) to enable. Self-hosted users see no UI changes until then; mail still lands in the legacy mail view.
:::

## The three zones

Every new message gets a classifier verdict + a confidence score, then goes into one of three bucket-zones:

| Zone | What lands here | What you do |
|---|---|---|
| **`requires_user`** | Real questions, decisions, action items aimed at you | Read, reply, or snooze |
| **`draft_ready`** | Replies lynox already drafted on your behalf — review and send | Review the draft, edit if needed, send |
| **`auto_handled`** | Confirmed transactional, informational, or zero-action mail | Glance, archive (or ignore) |

Plus a fourth bucket — **snoozed** — for messages you've deferred to a future moment.

Each item shows a **confidence chip** (e.g. "85%") + a short reason ("Stripe-Rechnungsbenachrichtigung ohne Zahlungsaufforderung — kein unmittelbares Handeln erforderlich"). Click any item to open the reading pane.

The zone rail on the left shows live counts. The icon-rail in the AppShell pulses gently when something new lands in `requires_user`.

## Reading pane + Mail-Context-Sidebar

Open an item to see the full thread on the right. On wide screens, a **Mail-Context-Sidebar** docks to the right of the reading pane with four deterministic sections:

- **Thread chain** — every message in the conversation, oldest at top
- **People** — sender + previously involved contacts, with lynox's CRM cards linked when available
- **Related** — other inbox items from the same sender or thread-key, ranked by recency
- **Actions** — quick-fire buttons: archive, snooze (with timestamp picker), unsubscribe (when detectable), open in your mail client

The sidebar collapses with a single click; state is per-user, persists across reloads.

## Drafts + Send Later

When the classifier routes a message to `draft_ready`, lynox produces a draft you can edit inline. The draft pane sits in a vertical split below the thread.

**Send Later** is in the dropdown next to the send button:

- 1 hour / 4 hours / tomorrow morning / Monday morning
- Custom timestamp picker for anything else

Scheduled sends are stored locally and dispatched by a SQLite-polling cron — lynox doesn't need to stay open. You can edit or cancel a scheduled draft up until it fires.

## Reminders + Kopilot

A message you can't handle right now goes to **snooze**. Set a duration (or a specific timestamp) and it vanishes from the active zones until the reminder fires.

Two flavors of unsnooze:

- **Time-based** — fires at the scheduled time. The Kopilot top-card at the top of the inbox surfaces snoozes due today, with the wake-up time + a one-line reason ("Vertrag läuft am 18.05. aus").
- **Reply-based** — if `unsnoozeOnReply` is on (default), the message re-emerges the moment the sender replies. Useful for "ping me if you haven't heard back from them."

Reminders not tied to a specific message live in the **AutomationHub** tab — a flat list you can sort by due-date. The chat surface has slash-commands too: `/erinner mich morgen 10:00 an Roland-Anfrage` creates a standalone reminder; `/erinner mich an diese Mail` inside an open thread anchors one to that thread.

## Push notifications

The inbox optionally pushes a web-push notification when a `requires_user` item lands. Configure on the **Integrations → Push notifications** page:

- **Master toggle** — on/off
- **Per-account** — mute specific mail accounts (e.g. the noisy newsletter inbox)
- **Quiet hours** — start/end + timezone; pushes pause inside the window
- **Throttle** — max per-minute and per-hour, so a 50-message bulk delivery doesn't 50× notify you

Browsers ask for permission the first time you turn the master toggle on. Self-hosted instances need a public HTTPS origin for web-push to work.

## Cold-start

When you first connect a mail account, the inbox is empty until lynox pulls existing messages. Two paths:

- **Auto on connect** — connecting a new account immediately fetches the last 30 days into the inbox + classifies them.
- **Manual fetch button** — for accounts that have been connected longer, the empty-inbox state shows a "Fetch existing mail" button that pulls the last 30 days on demand.

Classified items land directly in their zones — you don't have to scroll through hundreds of "auto_handled" Stripe receipts to find the one ticket that needs you.

## Search

The search bar in the inbox header is full-text + sender + subject + body. Filter by zone, account, or date range. Results respect the same classifier bucket the message lives in — search inside `requires_user` only, or across all zones.

## Status

The Unified Inbox is in active rollout. The classifier (`haiku-2026-05`) handles ~95% of business mail confidently; the rest land in `requires_user` with a low confidence chip and the reason "Klassifizierer-Antwort ungültig — manuell prüfen." Feedback you give (archive, unsubscribe, snooze, mark-as-noise) goes back into the next classifier iteration.

To enable on a self-hosted instance, flip the feature flag:

```bash
LYNOX_FEATURE_UNIFIED_INBOX=true
```

Or in `~/.lynox/config.json`:

```json
{
  "features": {
    "unified-inbox": true
  }
}
```

Managed instances enable the flag once the operator opts in via the Web UI.
