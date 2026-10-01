---
title: Backups
description: Automatic and manual backups for your lynox data.
sidebar:
  order: 4
---

lynox can back up your data automatically — encrypted when you set a vault key, and optionally uploaded to Google Drive.

## What's Backed Up

- **Memory database** — All memory, knowledge graph, patterns, and insights
- **Thread history** — Your conversation threads
- **Vault** — Encrypted secrets and credentials
- **DataStore** — CRM contacts, deals, and custom collections
- **Inbox & mail state** — Inbox and mail state (`mail-state.db`)
- **Subject graph** — The `engine.db` subject-graph store
- **Sessions** — Active session state
- **Configuration** — Settings and preferences

Backups are stored as SQLite snapshots, encrypted whenever `LYNOX_VAULT_KEY` holds a non-empty value.

## Manual Backup

### Via Web UI

Go to Settings → Backups → **Create Backup**.

### Via API

```bash
curl -X POST http://localhost:3000/api/backups
```

## Scheduled Backups

⚠ **`backup_schedule` does not schedule anything.** The key is declared and documented, and the
Settings UI offers it — but nothing in the engine reads it, so no backup is ever created because of
it. Automatic backups run as a **task**: a trigger with the `backup` effect and a cron condition,
which you create under Settings → Tasks. Until the key is either wired up or removed, treat both it
and the "Backup schedule" control in Settings as having no effect.

The other keys below do work:

```json
{
  "backup_retention_days": 30,
  "backup_encrypt": true
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `backup_retention_days` | 30 | Auto-delete backups older than this |
| `backup_encrypt` | on when `LYNOX_VAULT_KEY` is non-empty | Encrypt backups with your vault key |
| `backup_dir` | `<data dir>/backups/` (`~/.lynox/backups/` by default) | Where to store backup files |
| `backup_gdrive` | `false` | Upload backups to Google Drive — see below |

## Google Drive Upload

Backups can be uploaded to Google Drive. This is off by default: sending a copy of your data
directory to a third party is its own decision, and `backup_gdrive` is where you make it.

```json
{
  "backup_gdrive": true
}
```

**Three things must be true for a backup to be uploaded**, and the instance must not be a managed
or hosted one (those never upload to your Drive — the control plane runs their backups):

1. **Google Workspace is connected with Drive access** (the `drive.file` scope). Without it the
   upload reports a missing scope and nothing is sent.
2. **You opted in** — `backup_gdrive` is `true` in your user config (`~/.lynox/config.json`). The
   default is off. A project-local `.lynox/config.json` cannot set it: the project-config allowlist
   deliberately excludes it, and no environment variable overrides it. It can also be set through
   `PUT /api/config`, so treat API access to the instance as equivalent to config access.
3. **The archive is encrypted** — `LYNOX_VAULT_KEY` is set to a **non-empty** value and you have
   not set `backup_encrypt` to `false`. An empty `LYNOX_VAULT_KEY=` does not count as a key, and
   turning `backup_encrypt` off disables the upload too, even with a key present.

If you opt in without a usable vault key, the local backup still runs and the upload is skipped,
with a line on stderr saying so.

**When a change takes effect** depends on how you make it, and the difference matters in the
direction that protects you:

- Through the API or the Settings UI (`PUT /api/config`), **immediately** — in both directions. Turn
  the upload off and the next backup is no longer uploaded, with no restart.
- By **editing `~/.lynox/config.json` by hand**, at the **next restart**. lynox does not watch the
  file, so a hand-edited `backup_gdrive: false` does not stop uploads until you restart it.

If you need the upload to stop now and you edited the file, restart lynox — or make the same change
through Settings, which applies it at once.

### Turning it off again

Set `backup_gdrive` to `false` (or remove the line). New backups are no longer uploaded.

This does **not** remove copies already in Drive, and lynox has no remote-delete surface, so
delete the `lynox-backups` folder in your Drive yourself if you want them gone.

### What Drive can see

The **contents** of every file in the archive are encrypted with AES-256-GCM under a key derived
from your vault key (HKDF-SHA256, a fresh random IV per file), so Drive cannot read them.

The **structure** is not encrypted. Each file is uploaded under its path inside the backup, and the
archive's `manifest.json` is written after the encryption pass and therefore goes up in the clear.
Drive therefore sees the full file list of your data directory — every name under `memory/`,
`artifacts/`, `apis/`, `workspace/` and `sweeps/`, including your memory scope names — along with
each file's size, the lynox version, and the absolute path of the data directory, which usually
contains your username. It cannot read what is inside any of them. If those names are themselves
sensitive, leave the upload off.

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

When `backup_encrypt` is on — which it is whenever `LYNOX_VAULT_KEY` holds a non-empty value —
backups are encrypted with AES-256-GCM using a key derived from your vault key. Without the vault
key, backup files cannot be read.

Store your vault key separately from your backups — if both are lost, the data is unrecoverable.
