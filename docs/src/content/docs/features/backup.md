---
title: Backups
description: Automatic and manual backups for your lynox data.
sidebar:
  order: 4
---

lynox can back up your data automatically — encrypted with a vault key it generates on first run, and optionally uploaded to Google Drive.

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

⚠ **`backup_schedule` does not schedule anything, and there is no longer a control for it.** The key
is still accepted by the config schema, but nothing in the engine reads it, so no backup is ever
created because of it. The "Backup schedule" select that used to sit in the Backups view was
**removed** rather than wired up: a control that writes a key nobody reads is not a missing feature,
it is a promise the product does not keep.

The key is still *settable* — by hand in `~/.lynox/config.json`, through `PUT /api/config`, or from a
project `.lynox/config.json` (it is on the project-override allowlist). None of those do anything
either. It is kept in the schema rather than deleted because the schema is strict and a config file
it rejects is discarded **whole**: dropping the key would cost everyone who has it their entire
config file, so retiring it properly needs a migration that strips it, not a one-line deletion.

Automatic backups run as a **trigger** with the `backup` effect and a cron schedule. You create one
by asking the agent in chat; Automation Hub → Triggers lists them, and "New trigger" opens a chat
for it. (The Hub's **Tasks** tab is your to-do list, not agent triggers, and Settings has no Tasks
page.)

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
3. **The archive is encrypted.** ⚠ Do not read this as a brake you have to release: lynox
   **generates a vault key on first run** and sets `LYNOX_VAULT_KEY` from it, so this condition is
   normally already true before you touch anything. "I never set a vault key" is not a reason
   uploads will not happen. It fails only if you set `LYNOX_VAULT_KEY=` empty, set `backup_encrypt`
   to `false` (which disables the upload even with a key present), or your `vault.key` file is gone
   while `vault.db` remains.

In the rare case that there is no usable vault key, the local backup still runs and the upload is
skipped, with a line on stderr saying so.

**When a change takes effect** depends on how you make it:

- Through **`PUT /api/config`**, immediately and in both directions. There is no control for this
  setting in Settings — the Backups page covers schedule, encryption and retention only.
- By **editing `~/.lynox/config.json` by hand**, at the **next restart**, or earlier if something
  else happens to call `PUT /api/config` (that route re-reads the whole file, so an unrelated save
  from the Backups page picks up your edit too).

So if you need an upload to stop **now** and you edited the file by hand, restart lynox. Do not
assume the edit is already in effect.

### Turning it off again

Set `backup_gdrive` to `false` (or remove the line). New backups are no longer uploaded.

This does **not** remove copies already in Drive. Turning the setting off only stops new uploads.

### Removing the copies in Drive

**Disconnecting Google** in Settings → Google → Disconnect deletes the backup files this instance
uploaded through the current connection, and then revokes lynox's access. This works even after
`backup_gdrive` is off, because it removes old copies rather than stopping new uploads. The
confirmation names this step. While the disconnect runs, new backups keep their local copy but are
not uploaded.

Over the HTTP API the deletion is opt-in. Send `POST /api/google/revoke` with
`Content-Type: application/json` and the body `{"delete_drive_backups": true}`. Without both, the
route only revokes, and its response says `drive_backups.status: "skipped"`. Switching to the managed Google client never deletes anything.
That path only drops the local grant and leaves both your Drive and the grant at Google as they are.

What is deleted, and what is not:

- **Deleted:** the files inside the backup folders the uploader creates. Those are folders named
  like `2026-10-08T19301234Z`, inside a folder called `lynox-backups`. A file is deleted only if
  Google reports that lynox created both the backup folder and the file itself
  (`isAppAuthorized`), and that the file is yours. Files in Drive's bin count too. A file lynox made for another reason and then
  put into one of those backup folders counts as part of the backup and is deleted with it.
- **Kept:** every folder. Deleting a folder in Drive also deletes everything inside it that you
  own, including a copy you made there with "Make a copy". So lynox leaves the folders standing,
  and you can delete them yourself once they are empty.
- **Kept:** anything lynox did not create, and anything outside those backup folders. That
  includes your own files inside a `lynox-backups` folder, files lynox's Drive, Docs and Sheets
  tools created elsewhere, and anything in a shared drive.
- **Left in place:** backups uploaded through a different Google client. That covers an earlier
  client pair of your own, and the managed client if you switched. Google marks a file as created
  by the client that uploaded it. With the default Drive access lynox cannot see those files at
  all. With full Drive access it sees them, but they do not count as its own. Either way they stay,
  and the page does not mention them. Delete them in Drive yourself.

If something could not be deleted, the disconnect still happens. That covers Google refusing a
delete, the network policy blocking a call, an upload already under way, and the deletion running
past its time limit of about two minutes. The page then says the deletion was incomplete, and the response carries
`drive_backups.status: "degraded"` with the reasons. This instance has no access afterwards, so
delete what is left in the `lynox-backups` folder yourself.

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
