---
title: "Backup & Restore"
description: "Crash-safe backups, encryption, and scheduled backups"
---

lynox can automatically back up everything — your knowledge, history, contacts, and settings — to Google Drive. Backups are encrypted and run on schedule.

**Quick start:** Tell lynox via Telegram: *"Set up a backup to Google Drive"* or use the `/backup` command. Connect Google first with `/google` if you haven't already.

---

## What Gets Backed Up

| Data | Storage | Backup Method |
|------|---------|---------------|
| Run history (`history.db`) | SQLite WAL | `VACUUM INTO` (crash-safe) |
| Secrets vault (`vault.db`) | SQLite WAL | `VACUUM INTO` (crash-safe) |
| Data store (`datastore.db`) | SQLite WAL | `VACUUM INTO` (crash-safe) |
| Knowledge graph (`knowledge-graph/`) | LadybugDB (Kuzu) | Directory copy |
| Memory (`memory/`) | Text files | Recursive copy |
| Config (`config.json`) | JSON | File copy |
| Sessions (`sessions/`) | JSON files | Recursive copy |

**VACUUM INTO** creates an atomic, consistent snapshot of each SQLite database — even while lynox is running with active writes. No data corruption risk.

## CLI Commands

```bash
/backup              # Create a backup now
/backup list         # List all backups with dates and sizes
/backup verify       # Verify integrity of the latest backup
/backup verify NAME  # Verify a specific backup
/backup prune        # Remove old backups (retention policy)
/backup restore      # Restore from the latest backup (with confirmation)
/backup restore NAME # Restore from a specific backup
```

## Configuration

```json
{
  "backup_dir": "~/.lynox/backups",
  "backup_schedule": "0 3 * * *",
  "backup_retention_days": 30,
  "backup_encrypt": true
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `backup_dir` | `~/.lynox/backups` | Where backups are stored |
| `backup_schedule` | `0 3 * * *` | Cron schedule for automatic backups (daily 3 AM) |
| `backup_retention_days` | `30` | Days to keep old backups. `0` = never auto-delete |
| `backup_encrypt` | `true` (if vault key set) | Encrypt backups with AES-256-GCM |

All fields are `PROJECT_SAFE_KEYS` — can be set in project-level `.lynox/config.json`.

## Encryption

When `LYNOX_VAULT_KEY` is set and `backup_encrypt` is not explicitly `false`, backups are encrypted:

- **Algorithm**: AES-256-GCM (same as vault and run history)
- **Key derivation**: HKDF-SHA256 from vault key with backup-specific salt
- **Per-file encryption**: Each file encrypted individually with unique IV
- **File format**: `NBAK` magic header + version + IV + auth tag + ciphertext
- **Manifest stays readable**: Only file contents are encrypted, not the manifest

Without a vault key, backups are unencrypted. The CLI warns about this.

## Backup Structure

```
~/.lynox/backups/
  20260325T030000Z/
    manifest.json       # Metadata, file list, checksums
    history.db          # VACUUM INTO copy (or encrypted)
    vault.db            # VACUUM INTO copy (or encrypted)
    datastore.db        # VACUUM INTO copy (or encrypted)
    knowledge-graph/    # Directory copy
    memory/             # Recursive copy
    config.json         # File copy
```

## Manifest

Every backup includes a `manifest.json` with:

```json
{
  "version": "1.0.0",
  "created_at": "2026-03-25T03:00:00.000Z",
  "lynox_dir": "/home/user/.lynox",
  "encrypted": true,
  "files": [
    {
      "path": "history.db",
      "size_bytes": 524288,
      "checksum_sha256": "a1b2c3...",
      "type": "sqlite"
    }
  ],
  "checksum": "overall-sha256..."
}
```

## Verification

`/backup verify` checks:

1. Every file in the manifest exists
2. File sizes match
3. SHA-256 checksums match
4. SQLite databases pass `PRAGMA integrity_check` (unencrypted backups only)

## Restore Safety

Restore **always creates a safety backup first** before overwriting any data:

1. Safety backup of current state → `~/.lynox/backups/<timestamp>/`
2. If encrypted: decrypt each file
3. Replace current files with backup contents
4. Prompt user to restart lynox

If restore fails mid-way, the safety backup allows recovery. The safety backup path is shown in the output.

## Pre-Update Backup

lynox automatically creates a backup when it detects a version change on startup. This protects against update regressions — if a new version breaks something, the pre-update backup is already there.

```
[lynox] Version changed (1.0.0 → 1.1.0) — creating pre-update backup...
[lynox] Pre-update backup created: /home/lynox/.lynox/backups/20260326T030000Z
```

**How it works:**
- On `Engine.init()`, the current version is compared with `~/.lynox/.last_version`
- If the version changed → backup before anything else runs
- The version file is updated after the check
- First-ever run writes the version file without triggering a backup
- If Google Drive is configured, the pre-update backup is also uploaded

No configuration needed — this is always active when the backup manager is initialized.

## Scheduled Backups

When `backup_schedule` is configured and the WorkerLoop is running (Telegram, MCP server modes), backups run automatically as background tasks:

- **Task type**: `backup` (no LLM call — direct BackupManager operation)
- **Auto-prune**: Old backups are pruned after each scheduled backup
- **Failure notification**: Failed backups are reported via NotificationRouter (high priority)

## Retention Policy

- Backups older than `backup_retention_days` are auto-deleted
- The **most recent backup is never deleted** regardless of age
- `0` disables auto-deletion
- Manual pruning: `/backup prune`

## SDK Usage

```typescript
import { BackupManager } from '@lynox-ai/core';
import { getLynoxDir } from '@lynox-ai/core';

const manager = new BackupManager(getLynoxDir(), {
  backupDir: '/path/to/backups',
  retentionDays: 30,
  encrypt: true,
}, process.env['LYNOX_VAULT_KEY'] ?? null);

// Create
const result = await manager.createBackup();
console.log(result.success, result.path);

// List
const backups = manager.listBackups();

// Verify
const check = manager.verifyBackup(backups[0].path);

// Restore (creates safety backup first)
const restore = await manager.restoreBackup(backupPath);

// Prune
const pruned = manager.pruneBackups(30);
```

## Google Drive Backup

When Google auth is configured with `drive.file` scope, backups are automatically uploaded to Google Drive after each local backup.

### Setup

1. Configure Google OAuth: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
2. Run `/google auth` in the CLI and grant the `drive.file` scope
3. Backups will auto-upload to a `lynox-backups` folder on your Google Drive

### CLI Commands

```bash
/backup gdrive list      # List remote backups on Google Drive
/backup gdrive upload    # Force upload latest local backup
/backup gdrive restore   # Download and restore from Google Drive
```

### How It Works

- A `lynox-backups` folder is auto-created in your Google Drive root
- Each backup gets a subfolder named by timestamp
- All files (encrypted or not) are uploaded as binary
- Upload failures are logged but never fail the local backup
- Manifests are used to list remote backups without downloading full data

### Configuration

```json
{
  "backup_gdrive": true
}
```

Set `backup_gdrive: false` to disable Google Drive upload while keeping Google auth active for other features.

### Off-Site Safety

This is the recommended setup for pilots and production:
1. **Local backup** → fast restore, survives container restart
2. **Google Drive** → survives server failure, off-site disaster recovery
3. **Separate backup volume** (Docker) → survives data volume corruption

## Docker

Mount a backup volume for persistent storage:

```bash
docker run -d \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e LYNOX_VAULT_KEY=... \
  -v ~/.lynox:/home/lynox/.lynox \
  -v /mnt/backups:/home/lynox/.lynox/backups \
  lynox
```

Or configure `backup_dir` to an external path in config.
