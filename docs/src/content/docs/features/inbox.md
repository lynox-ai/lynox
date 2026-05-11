---
title: Inbox
description: Decision Queue for your email — auto-classified, draft-prepared, reviewed in one place.
sidebar:
  order: 8
---

The Inbox at `/app/inbox` is not an email client. It's a **Decision Queue**: everything that needs *you* in one list, with a reply already drafted. Newsletters, receipts, and noise have been classified out of the way before you arrive.

If you live in lynox all day, the Inbox is the surface you spend the most time in.

## How it works

Every incoming email is classified the moment it lands. Classification produces one of two buckets:

- **Needs you** — a decision, a question, a reply only you can write. Goes to the Decision Queue.
- **Auto-handled** — newsletters, receipts, automated notifications. Filed away. Counted but not surfaced.

For items in *Needs you*, a draft reply is prepared in the background. By the time you open the Inbox, you're reviewing — not writing from scratch.

## The view

Three columns when there's space, stacked on mobile:

1. **List** (left) — items in the bucket, newest first by envelope date. Sender, subject, one-line preview.
2. **Context** (middle, optional) — the email body, with previous-thread history.
3. **Draft** (right) — the prepared reply. Editable inline. Tone-buttons above the editor.

Click an item to open it. The draft pane fills with whatever has already been generated.

## Drafts

Drafts are generated on first triage and re-generated on demand. Three tone buttons sit above the editor:

- **Kürzer** — same content, fewer sentences.
- **Förmlicher** — formal register, no contractions.
- **Wärmer** — softer opener, warmer close.

Each click supersedes the previous draft instead of overwriting it — the previous text is preserved in the audit trail. The chain is visible in the item's audit view (`/api/inbox/items/:id/audit`).

You can also edit directly. Editing pauses generation; the next tone-button click starts a new branch from your edited version.

When you're ready, hit **Send**. The draft goes out through the same `mail_send` flow the assistant uses — including the same secret-store credentials, the same SMTP server, the same audit trail.

## Cold-start backfill

When you first open the Inbox after connecting a mail account, there's nothing classified yet. A banner offers a one-time backfill: it pulls the recent N threads from each connected account and classifies them in a single batch.

The backfill is operator-driven — it does not run automatically — because it incurs a one-time LLM cost (roughly $0.10–$0.20 for ~100 threads). You see the estimated cost before you click.

Once complete, ongoing classification happens in the background as new mail arrives (every 120 s via `MailWatcher`).

## Snooze, archive, mark handled

Each item has three actions:

- **Snooze** — pick "Later today / Tomorrow / Monday / custom date". The item drops from the list and re-appears at that time, back in *Needs you*.
- **Archive** — files the item; it stays searchable but leaves the Decision Queue. Use for "I read it, no action needed."
- **Mark handled** — explicit close. Used by the assistant when a reply was sent via the chat-mediated flow, so the Inbox stays in sync.

Snoozed items are filtered from both list and badge counts until their snooze time elapses.

## Multi-account

If you have several mail accounts connected, the Inbox merges them into one queue. The sender card shows which account received each item. There's no per-account toggle — the design is "everything in one place" by intent. If you need per-account filtering, ask the assistant.

## What it does not do

- **No folders, labels, or rule editor** — classification is learned from the items you archive, snooze, or send. The assistant proposes rules; you confirm them in chat.
- **No compose-from-scratch button** — new mails are written by asking the assistant. The Inbox is for things that arrived, not for things you initiate.
- **No auto-send** — drafts always require your confirmation. The assistant never replies on the wire on your behalf.

These boundaries are deliberate. The Inbox replaces the *decision* part of email, not the *email client* part.

## Privacy and storage

Item metadata (sender, subject, envelope date, classification) is stored locally in your lynox database. Bodies are cached at classification time so the draft generator has context without re-fetching — the cache lives in the same encrypted-at-rest store as your threads and is wiped when you delete the item or run a GDPR export-and-delete cycle.

Classification and draft generation run through your configured LLM provider. No third-party email-AI services are involved.

## API

The Inbox is fully accessible via the HTTP API — see [Inbox endpoints](/developers/http-api/#inbox) in the API reference. If you want to build a CLI, a mobile companion, or an integration, those endpoints are stable.
