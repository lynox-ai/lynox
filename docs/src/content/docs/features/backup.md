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
| `backup_encrypt` | `true` | Encrypt backups with your vault key |
| `backup_dir` | `~/.lynox/backups/` | Where to store backup files |
| `backup_gdrive` | `false` | Upload backups to Google Drive |

## Google Drive Upload

If you've connected Google Workspace with Drive access, backups can be automatically uploaded:

```json
{
  "backup_gdrive": true
}
```

Backups are uploaded after creation. This gives you an off-site copy without any additional setup.

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
