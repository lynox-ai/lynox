---
title: WhatsApp Inbox
description: Connect your WhatsApp Business number to lynox via Meta Coexistence Mode — read, transcribe voice notes, and reply from the Web UI.
sidebar:
  order: 8
---

lynox can read and reply to your WhatsApp Business messages alongside the Mobile App. Voice notes are transcribed automatically; replies can be typed in the lynox Web UI or drafted by the assistant via the `whatsapp` tool.

This is **not** a chat-bot integration. Your contacts always see messages coming from your own number, written by you (or approved by you). The assistant never replies directly on the wire.

## Requirements

Before connecting, make sure the following is in place:

- **WhatsApp Business App** on your phone, version **2.24.17 or newer**. Consumer WhatsApp (the green app) is not supported — Coexistence Mode is only available for WhatsApp Business.
- Your WhatsApp Business account is **linked to a Facebook Page**. If you don't have one, create an unbeworbene Page — it just needs to exist, you never have to post on it.
- A **Meta Business Manager** account (free — [business.facebook.com](https://business.facebook.com)).
- Your phone number is **not yet registered** with another Cloud-API provider (Twilio, 360dialog, etc.).
- Your `LYNOX_VAULT_KEY` is set — credentials are stored encrypted in the vault.

## Coexistence Mode — what changes in the Mobile App

Coexistence activation disables the following in 1:1 chats on your number:

- Disappearing messages (24 h / 7 d / 90 d auto-delete)
- View-once media (photos / videos shown once then deleted)
- Live-location sharing

Additionally, existing broadcast lists become **read-only** (no new lists can be created), and group chats are not synchronized with the Cloud API. If any of these features is part of your current workflow, decide consciously before activating.

## One-time setup (BYOK)

The BYOK path takes about 30–45 minutes the first time — no Meta App Review required on our side because your Meta App stays in Development Mode with you as the only user.

1. **Open [developers.facebook.com](https://developers.facebook.com)** and create a new App (type: *Business*).
2. Add the **WhatsApp** product to your app.
3. In *WhatsApp → API Setup*:
   - Select your WhatsApp Business Account (WABA).
   - Copy the **Phone-Number-ID** and **WABA-ID** shown on that page.
4. Go to *WhatsApp → Configuration* and **activate Coexistence Mode**. Scan the QR code shown on screen using your WhatsApp Business App (*Settings → Linked Devices*).
5. In *Business Settings → Users → System Users*, create a new System User with admin access to your WABA. Generate a **Permanent Access Token** with the scopes `whatsapp_business_messaging` and `whatsapp_business_management`.
6. In *App Settings → Basic*, copy the **App Secret** (click *Show*).
7. Back in *WhatsApp → Configuration*, set the webhook:
   - **Callback URL:** `https://<your-lynox-instance>/api/webhooks/whatsapp` (the lynox settings page copies this exact URL to your clipboard)
   - **Verify Token:** choose any string — you'll paste the same value into lynox
   - Subscribe to events: `messages`, `message_status`, `smb_message_echoes`

In lynox, open *Settings → Integrations → WhatsApp*, paste:

- Access Token (Permanent)
- WABA ID
- Phone-Number-ID
- App Secret
- Webhook Verify Token (the string you picked above)

Save. lynox probes the Meta API once to confirm the credentials are valid.

## How it works after setup

- **Inbox:** *WhatsApp* in the main navigation shows all threads with unread counts and voice-note badges. Click a thread to read, reply, or mark as read.
- **Voice notes:** Automatically transcribed via the same Voxtral pipeline that powers the dictation feature. Transcripts appear inline; the original audio stays in your WhatsApp Business App.
- **Echoes:** When you send a message from the Mobile App instead of lynox, the `smb_message_echoes` webhook mirrors it into the lynox inbox so your conversation history stays consistent.
- **Assistant drafts (optional):** The assistant can draft or send replies on your behalf via the `whatsapp` tool. Every outbound send always pops up a confirmation — nothing leaves your number without an explicit *Send* tap.

## Limits

- Only **service-window** conversations (reactive replies within 24 h of an inbound message) are used in Phase 1. These are **free** at Meta and don't require business verification.
- Proactive messaging (outside 24 h) requires pre-approved template messages and is not yet surfaced in the UI.
- Throughput is capped by Meta at 5 messages / second on Coexistence numbers — more than enough for manual use.

## Privacy

- Credentials live encrypted in your lynox instance's vault (AES-256-GCM).
- Message content transits Meta's infrastructure as with any WhatsApp traffic. lynox stores messages in your per-instance SQLite only.
- Meta retroactively syncs up to 6 months of chat history into the Cloud API when Coexistence is activated. lynox **does not** automatically analyze that history — it sits in your inbox but style-learning extractions require an explicit opt-in (Phase 2).

## Troubleshooting

- **"Verify token mismatch" in Meta's webhook test:** the verify token pasted into lynox must exactly match the one entered in Meta's webhook configuration.
- **"Invalid signature" on inbound events:** the App Secret pasted into lynox doesn't match the one shown in Meta's *App Settings → Basic*. Regenerate via *Show* and paste again.
- **"WhatsApp not configured" on tool calls:** the credentials are missing or incomplete. Open *Settings → Integrations → WhatsApp* and confirm the status pill reads *Verbunden*.
- **Webhooks don't arrive:** check that your lynox instance is reachable on the public internet over HTTPS. Meta's webhook tester in *WhatsApp → Configuration* helps pinpoint whether the problem is DNS, TLS, or the endpoint itself.
