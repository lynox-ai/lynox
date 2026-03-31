/**
 * Basic CLI commands: /clear, /compact, /save, /load, /export, /history, /help, /exit, /quit
 */

import { resolve } from 'node:path';
import { stderr } from 'node:process';

import type { Session } from '../../core/session.js';
import { writeFileAtomicSync } from '../../core/atomic-write.js';
import { getErrorMessage } from '../../core/utils.js';
import { renderError, GREEN, DIM, RESET } from '../ui.js';
import { state, spinner } from '../cli-state.js';
import { saveSession, loadSessionFile, loadHistory as loadHistoryFile } from '../cli-helpers.js';
import { HELP_TEXT_BASICS, HELP_TEXT_FULL } from '../help-text.js';
import type { CLICtx } from './types.js';

export async function handleClear(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  session.reset();
  state.lastResponse = '';
  ctx.stdout.write('Conversation reset. Memory preserved.\n');
  return true;
}

export async function handleCompact(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const focus = parts.slice(1).join(' ') || undefined;
  try {
    spinner.start('Compacting conversation...');
    const result = await session.compact(focus);
    spinner.stop();
    state.lastResponse = '';
    if (result.success) {
      ctx.stdout.write(`${GREEN}✓${RESET} Conversation compacted.${focus ? ` Focus: ${focus}` : ''}\n`);
    } else {
      ctx.stdout.write('Conversation reset (compaction failed).\n');
    }
  } catch {
    spinner.stop();
    state.lastResponse = '';
    ctx.stdout.write('Conversation reset (compaction failed).\n');
  }
  return true;
}

export async function handleSave(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const path = saveSession(session);
  ctx.stdout.write(`${GREEN}✓${RESET} Session saved: ${path}\n`);
  return true;
}

export async function handleLoad(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const sessionName = parts[1];
  if (loadSessionFile(session, sessionName)) {
    ctx.stdout.write(`${GREEN}✓${RESET} Session loaded.\n`);
  } else {
    ctx.stdout.write(renderError('No session found.'));
  }
  return true;
}

export async function handleExport(parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  const format = parts[1];
  if (!state.lastResponse) {
    ctx.stdout.write('No response to export.\n');
    return true;
  }
  try {
    if (format === 'file' && parts[2]) {
      const exportTarget = resolve(parts[2]);
      writeFileAtomicSync(exportTarget, state.lastResponse);
      ctx.stdout.write(`${GREEN}✓${RESET} Exported to ${exportTarget}\n`);
    } else {
      const exportPath = `lynox-export-${Date.now()}.md`;
      writeFileAtomicSync(exportPath, state.lastResponse);
      ctx.stdout.write(`${GREEN}✓${RESET} Exported to ${exportPath}\n`);
    }
  } catch (err: unknown) {
    stderr.write(renderError(getErrorMessage(err)));
  }
  return true;
}

export async function handleHistory(parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  const history = loadHistoryFile();
  const searchTerm = parts[1] === 'search'
    ? parts.slice(2).join(' ').toLowerCase()
    : parts.slice(1).join(' ').toLowerCase();

  if (searchTerm) {
    const matches = history.filter(h => h.toLowerCase().includes(searchTerm));
    if (matches.length === 0) {
      ctx.stdout.write('No matching history entries.\n');
    } else {
      for (const m of matches.slice(-20)) {
        ctx.stdout.write(`  ${DIM}${m}${RESET}\n`);
      }
    }
  } else {
    const last = history.slice(-20);
    if (last.length === 0) {
      ctx.stdout.write('No command history.\n');
    } else {
      for (const h of last) {
        ctx.stdout.write(`  ${DIM}${h}${RESET}\n`);
      }
    }
  }
  return true;
}

export async function handleHelp(parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  ctx.stdout.write(parts[1] === 'all' ? HELP_TEXT_FULL : HELP_TEXT_BASICS);
  return true;
}

export async function handleExit(_parts: string[], _session: Session, _ctx: CLICtx): Promise<boolean> {
  return false;
}
