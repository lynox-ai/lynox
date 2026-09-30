---
title: Backups
description: Automatic and manual backups for your lynox data.
sidebar:
  order: 4
---

lynox can back up your data automatically — encrypted and optionally uploaded to Google Drive.

## What's Backed Up

- **Memory database** — All memory, knowledge graph, patterns, and insights
- **Thread history** — Your conversation threads
- **Vault** — Encrypted secrets and credentials
- **DataStore** — CRM contacts, deals, and custom collections
- **Inbox & mail state** — Inbox and mail state (`mail-state.db`)
- **Subject graph** — The `engine.db` subject-graph store
- **Sessions** — Active session state
- **Configuration** — Settings and preferences

Backups are stored as encrypted SQLite snapshots.

## Manual Backup

### Via Web UI

Go to Settings → Backups → **Create Backup**.

### Via API

```bash
curl -X POST http://localhost:3000/api/backups
```

## Scheduled Backups

Configure automatic backups in your config:

```json
{
  "backup_schedule": "0 3 * * *",
  "backup_retention_days": 30,
  "backup_encrypt": true
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `backup_schedule` | — | Cron expression (e.g., `0 3 * * *` = daily at 3 AM) |
| `backup_retention_days` | 30 | Auto-delete backups older than this |
| `backup_encrypt` | on when `LYNOX_VAULT_KEY` is set | Encrypt backups with your vault key |
| `backup_dir` | `~/.lynox/backups/` | Where to store backup files |
| `backup_gdrive` | `false` | Upload backups to Google Drive — needs `LYNOX_VAULT_KEY` |

## Google Drive Upload

Off by default, and separate from connecting Google: sending a copy of your data directory to a
third party is its own decision, and `backup_gdrive` is where you make it.

```json
{
  "backup_gdrive": true
}
```

Two things must be true for a backup to be uploaded:

1. **You opted in** — `backup_gdrive` is `true` in `~/.lynox/config.json`. The default is off, and
   a project-local `.lynox/config.json` cannot turn it on; this setting is read from your user
   config only.
2. **The archive is encrypted** — which means `LYNOX_VAULT_KEY` is set and you have not set
   `backup_encrypt` to `false`.

If you opt in without a vault key, the local backup still runs and the upload is skipped, with a
line on stderr saying so.

### What Drive can see

The **contents** of every file in the archive are encrypted with AES-256-GCM under a key derived
from your vault key, so Drive cannot read them. The **structure** is not encrypted: each file is
uploaded under its path inside the backup, and the archive's `manifest.json` lists those paths
with sizes and checksums plus the data directory it came from. Drive therefore sees how your
data directory is laid out — including the names of your memory scopes — even though it cannot
read what is in it. If those names are themselves sensitive, keep the upload off.

## Restore

### Via Web UI

Go to Settings → Backups, find the backup you want, and click **Restore**.

### Via API

```bash
# List backups
curl http://localhost:3000/api/backups

# Restore a specific backup
curl -X POST http://localhost:3000/api/backups/{id}/restore
```

:::caution
Restoring a backup replaces your current data. Make sure to create a fresh backup before restoring an older one.
:::

## Encryption

When `backup_encrypt` is enabled (default), backups are encrypted with AES-256-GCM using your vault key. Without the vault key, backup files cannot be read.

Store your vault key separately from your backups — if both are lost, the data is unrecoverable.
