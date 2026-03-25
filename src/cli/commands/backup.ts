/**
 * Backup CLI commands: /backup create, list, verify, prune, restore
 */

import type { Session } from '../../core/session.js';
import { BOLD, DIM, GREEN, RED, YELLOW, RESET } from '../ui.js';
import type { CLICtx } from './types.js';

export async function handleBackup(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const engine = session.engine;
  const backupManager = engine.getBackupManager();

  if (!backupManager) {
    ctx.stdout.write(`${RED}Backup manager not initialized.${RESET}\n`);
    return true;
  }

  const sub = parts[1];

  // /backup or /backup create
  if (!sub || sub === 'create') {
    ctx.stdout.write(`${DIM}Creating backup...${RESET}\n`);
    const result = await backupManager.createBackup();
    if (result.success) {
      const fileCount = result.manifest.files.filter(f => f.type !== 'directory' && f.type !== 'kuzu_dir').length;
      const totalBytes = result.manifest.files.reduce((sum, f) => sum + f.size_bytes, 0);
      const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
      ctx.stdout.write(
        `${GREEN}${BOLD}Backup created${RESET}\n`
        + `  Path: ${result.path}\n`
        + `  Files: ${String(fileCount)} | Size: ${sizeMB} MB | Time: ${String(result.duration_ms)}ms\n`
        + `  Encrypted: ${result.manifest.encrypted ? 'yes' : 'no'}\n`
        + `  Checksum: ${result.manifest.checksum.slice(0, 16)}...\n`,
      );
    } else {
      ctx.stdout.write(`${RED}${BOLD}Backup failed:${RESET} ${result.error ?? 'unknown'}\n`);
    }
    return true;
  }

  // /backup list
  if (sub === 'list') {
    const backups = backupManager.listBackups();
    if (backups.length === 0) {
      ctx.stdout.write(`${DIM}No backups found.${RESET}\n`);
      return true;
    }
    ctx.stdout.write(`${BOLD}Backups (${String(backups.length)}):${RESET}\n`);
    for (const b of backups) {
      const fileCount = b.files.filter(f => f.type !== 'directory' && f.type !== 'kuzu_dir').length;
      const totalBytes = b.files.reduce((sum, f) => sum + f.size_bytes, 0);
      const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
      const enc = b.encrypted ? ' [encrypted]' : '';
      const date = new Date(b.created_at).toLocaleString();
      ctx.stdout.write(`  ${date} — v${b.version} — ${String(fileCount)} files — ${sizeMB} MB${enc}\n`);
    }
    return true;
  }

  // /backup verify [name]
  if (sub === 'verify') {
    const backups = backupManager.listBackups();
    if (backups.length === 0) {
      ctx.stdout.write(`${DIM}No backups to verify.${RESET}\n`);
      return true;
    }

    // Find the backup to verify
    const target = parts[2];
    let backupPath: string;
    if (target) {
      backupPath = `${backupManager.getBackupDir()}/${target}`;
    } else {
      // Verify the most recent
      const ts = backups[0]!.created_at.replace(/[:.]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
      backupPath = `${backupManager.getBackupDir()}/${ts}`;
    }

    ctx.stdout.write(`${DIM}Verifying backup...${RESET}\n`);
    const result = backupManager.verifyBackup(backupPath);
    if (result.valid) {
      ctx.stdout.write(`${GREEN}${BOLD}Backup valid${RESET} — ${String(result.files_checked)} files checked\n`);
    } else {
      ctx.stdout.write(`${RED}${BOLD}Backup invalid:${RESET}\n`);
      for (const err of result.errors) {
        ctx.stdout.write(`  ${RED}- ${err}${RESET}\n`);
      }
    }
    return true;
  }

  // /backup prune
  if (sub === 'prune') {
    const config = session.getUserConfig();
    const days = config.backup_retention_days ?? 30;
    const pruned = backupManager.pruneBackups(days);
    ctx.stdout.write(
      pruned > 0
        ? `${GREEN}Pruned ${String(pruned)} old backup(s) (retention: ${String(days)} days)${RESET}\n`
        : `${DIM}No backups to prune (retention: ${String(days)} days)${RESET}\n`,
    );
    return true;
  }

  // /backup restore [name]
  if (sub === 'restore') {
    const backups = backupManager.listBackups();
    if (backups.length === 0) {
      ctx.stdout.write(`${RED}No backups found.${RESET}\n`);
      return true;
    }

    // Find backup to restore
    const target = parts[2];
    let backupPath: string;
    if (target) {
      backupPath = `${backupManager.getBackupDir()}/${target}`;
    } else {
      const ts = backups[0]!.created_at.replace(/[:.]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
      backupPath = `${backupManager.getBackupDir()}/${ts}`;
    }

    // Confirmation prompt
    ctx.stdout.write(`${YELLOW}${BOLD}WARNING:${RESET} This will overwrite your current data with the backup.\n`);
    ctx.stdout.write(`A safety backup of your current state will be created first.\n`);

    if (ctx.cliPrompt) {
      const answer = await ctx.cliPrompt('Proceed with restore?', ['Yes', 'No']);
      if (!['y', 'yes'].includes(answer.toLowerCase())) {
        ctx.stdout.write(`${DIM}Restore cancelled.${RESET}\n`);
        return true;
      }
    }

    ctx.stdout.write(`${DIM}Restoring...${RESET}\n`);
    const result = await backupManager.restoreBackup(backupPath);
    if (result.success) {
      ctx.stdout.write(
        `${GREEN}${BOLD}Restore complete${RESET}\n`
        + `  Files restored: ${String(result.files_restored)}\n`
        + `  Safety backup: ${result.pre_restore_backup_path}\n`
        + `  ${YELLOW}Please restart nodyn to apply restored data.${RESET}\n`,
      );
    } else {
      ctx.stdout.write(
        `${RED}${BOLD}Restore failed:${RESET} ${result.error ?? 'unknown'}\n`
        + (result.pre_restore_backup_path ? `  Safety backup: ${result.pre_restore_backup_path}\n` : ''),
      );
    }
    return true;
  }

  // /backup gdrive [subcommand]
  if (sub === 'gdrive' || sub === 'drive') {
    const gdriveSub = parts[2];
    const uploader = backupManager.getGDriveUploader();

    if (!uploader) {
      ctx.stdout.write(`${RED}Google Drive not configured.${RESET} Set up Google auth first: /google auth\n`);
      return true;
    }

    // /backup gdrive list
    if (!gdriveSub || gdriveSub === 'list') {
      ctx.stdout.write(`${DIM}Fetching remote backups...${RESET}\n`);
      const remotes = await uploader.list();
      if (remotes.length === 0) {
        ctx.stdout.write(`${DIM}No remote backups found on Google Drive.${RESET}\n`);
        return true;
      }
      ctx.stdout.write(`${BOLD}Google Drive Backups (${String(remotes.length)}):${RESET}\n`);
      for (const r of remotes) {
        const date = new Date(r.created_at).toLocaleString();
        const ver = r.manifest?.version ?? '?';
        const enc = r.manifest?.encrypted ? ' [encrypted]' : '';
        ctx.stdout.write(`  ${date} — v${ver} — ${r.name}${enc}\n`);
      }
      return true;
    }

    // /backup gdrive upload — force upload latest local backup
    if (gdriveSub === 'upload') {
      const backups = backupManager.listBackups();
      if (backups.length === 0) {
        ctx.stdout.write(`${RED}No local backups to upload. Run /backup first.${RESET}\n`);
        return true;
      }
      const latest = backups[0]!;
      const ts = latest.created_at.replace(/[:.]/g, '').slice(0, 19) + 'Z';
      const backupPath = `${backupManager.getBackupDir()}/${ts}`;
      ctx.stdout.write(`${DIM}Uploading to Google Drive...${RESET}\n`);
      const result = await uploader.upload(backupPath, latest);
      if (result.success) {
        ctx.stdout.write(`${GREEN}${BOLD}Uploaded${RESET} — ${String(result.filesUploaded)} files\n`);
      } else {
        ctx.stdout.write(`${RED}${BOLD}Upload failed:${RESET} ${result.error ?? 'unknown'}\n`);
      }
      return true;
    }

    // /backup gdrive restore
    if (gdriveSub === 'restore') {
      const remotes = await uploader.list();
      if (remotes.length === 0) {
        ctx.stdout.write(`${RED}No remote backups found.${RESET}\n`);
        return true;
      }
      const target = remotes[0]!;
      ctx.stdout.write(`${YELLOW}${BOLD}WARNING:${RESET} Downloading backup "${target.name}" from Google Drive and restoring.\n`);
      ctx.stdout.write(`A safety backup of your current state will be created first.\n`);

      if (ctx.cliPrompt) {
        const answer = await ctx.cliPrompt('Proceed?', ['Yes', 'No']);
        if (!['y', 'yes'].includes(answer.toLowerCase())) {
          ctx.stdout.write(`${DIM}Cancelled.${RESET}\n`);
          return true;
        }
      }

      // Download to temp dir, then restore
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempDir = mkdtempSync(join(tmpdir(), 'nodyn-gdrive-restore-'));

      ctx.stdout.write(`${DIM}Downloading...${RESET}\n`);
      const dlResult = await uploader.download(target.id, tempDir);
      if (!dlResult.success) {
        ctx.stdout.write(`${RED}${BOLD}Download failed:${RESET} ${dlResult.error ?? 'unknown'}\n`);
        return true;
      }

      ctx.stdout.write(`${DIM}Restoring ${String(dlResult.filesDownloaded)} files...${RESET}\n`);
      const restoreResult = await backupManager.restoreBackup(tempDir);
      if (restoreResult.success) {
        ctx.stdout.write(
          `${GREEN}${BOLD}Restore complete${RESET}\n`
          + `  Files restored: ${String(restoreResult.files_restored)}\n`
          + `  Safety backup: ${restoreResult.pre_restore_backup_path}\n`
          + `  ${YELLOW}Please restart nodyn to apply restored data.${RESET}\n`,
        );
      } else {
        ctx.stdout.write(`${RED}${BOLD}Restore failed:${RESET} ${restoreResult.error ?? 'unknown'}\n`);
      }
      return true;
    }

    ctx.stdout.write(
      `${BOLD}Google Drive commands:${RESET}\n`
      + `  /backup gdrive list     List remote backups\n`
      + `  /backup gdrive upload   Upload latest local backup\n`
      + `  /backup gdrive restore  Download and restore from Drive\n`,
    );
    return true;
  }

  // Unknown subcommand
  ctx.stdout.write(
    `${BOLD}Usage:${RESET}\n`
    + `  /backup              Create a backup now\n`
    + `  /backup list         List all local backups\n`
    + `  /backup verify       Verify the latest backup\n`
    + `  /backup prune        Remove old backups (retention policy)\n`
    + `  /backup restore      Restore from the latest local backup\n`
    + `  /backup gdrive       Google Drive backup commands\n`,
  );
  return true;
}
