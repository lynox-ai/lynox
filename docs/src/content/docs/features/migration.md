---
title: Migration to Managed
description: Move a self-hosted lynox instance to managed hosting end-to-end, zero-knowledge — your data never touches a third party.
sidebar:
  order: 9
---

If you've been running lynox self-hosted and want to move to lynox-operated managed hosting, the **Migration Wizard** in the Web UI handles the transfer end-to-end without your data ever passing through a third party. Browser, source engine, and destination engine talk directly; lynox-operated infrastructure only sees the encrypted chunks moving between them.

The wizard ships as part of the Web UI (`/app/migrate`) — no CLI tools, no SSH access required.

## What gets migrated

- Threads and conversation history
- Memory: knowledge graph + entity graph + flat-file memory
- CRM: contacts, deals, DataStore collections
- API Store profiles
- Artefakte (artifacts)
- Vault contents (your encrypted secrets, re-encrypted with the destination key)

What does **not** get migrated:

- The `LYNOX_VAULT_KEY` itself (the destination generates a fresh one — your secrets are re-encrypted on arrival)
- Active sessions (you'll need to log into the destination once)
- Local backups (`backups/` is regenerated on the destination from the new data)

## Wizard steps

1. **Preview** — wizard inspects the source instance, lists data sizes per category. You confirm before anything moves.
2. **Handshake** — source + destination perform an X25519 ECDH handshake, deriving a shared AES-256-GCM key. Handshake message is HMAC-signed against a one-shot migration token (rotated per attempt, expires in 30 minutes).
3. **Encrypted transfer** — data flows in 64 chunks max, 500 MB per chunk, AES-256-GCM-encrypted with the derived key. Browser orchestrates over SSE; chunks stream source → destination directly.
4. **Provisioning poll** — destination provisions the new tenant container, applies migrations, indexes the migrated data. Progress shown live.
5. **Switchover** — you log into the destination with email OTP / Passkey. The source instance stays online (read-only) for 7 days so you can verify nothing is missing before the source is decommissioned.

## Privacy guarantees

The migration is **zero-knowledge** — the lynox-operated control plane never sees plaintext data. Chunks are encrypted client-side at the source with a key derived from the ECDH handshake, and the destination is the only party that holds the matching half of the key pair. Even an attacker with full control plane access can only see encrypted chunks of bounded size moving between two hostnames.

The migration token is single-use, HMAC-signed, and expires in 30 minutes. A second migration attempt requires a fresh token.

## When this is useful

- You started self-hosted but want the operational simplicity of managed hosting (backups, updates, support)
- You're moving from a personal server to a team-shared instance
- Your self-hosted instance has data residency requirements that a managed EU instance now satisfies (Mistral Paris, Hetzner Falkenstein)

For the reverse direction (managed → self-hosted), use the export tooling under **Settings → Data → Export full archive**. The same encryption + chunking applies; you decrypt on your own machine before importing.

## Status

The wizard is in active rollout for new managed signups. Existing customers can request migration via [hello@lynox.ai](mailto:hello@lynox.ai); we run the wizard with you on a call to verify the data carries over cleanly.
