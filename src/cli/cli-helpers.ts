/**
 * CLI helper functions extracted from index.ts.
 *
 * Pricing constants, session management, command history, aliases, git helpers.
 */

import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stdout } from 'node:process';

import type { Nodyn } from '../core/orchestrator.js';
import { getNodynDir } from '../core/config.js';
import { writeFileAtomicSync, ensureDirSync } from '../core/atomic-write.js';

// ── Pricing constants ──────────────────────────────────────────────────

export const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-6':   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4, cacheWrite: 1.00, cacheRead: 0.08 },
};

export const USD_TO_CHF = 0.88;

// ── File paths ─────────────────────────────────────────────────────────

export const SESSIONS_DIR = join(getNodynDir(), 'sessions');
export const HISTORY_FILE = join(getNodynDir(), 'history');
export const ALIASES_FILE = join(getNodynDir(), 'aliases.json');

// ── Pricing display ────────────────────────────────────────────────────

export function printCost(nodyn: Nodyn, model: string, out: NodeJS.WriteStream = stdout): void {
  const u = nodyn.usage;
  const p = PRICING[model];
  if (!p) {
    out.write('Unknown model for pricing.\n');
    return;
  }
  const inputCost = (u.input_tokens / 1_000_000) * p.input;
  const outputCost = (u.output_tokens / 1_000_000) * p.output;
  const cacheWriteCost = (u.cache_creation_input_tokens / 1_000_000) * p.cacheWrite;
  const cacheReadCost = (u.cache_read_input_tokens / 1_000_000) * p.cacheRead;
  const totalUSD = inputCost + outputCost + cacheWriteCost + cacheReadCost;
  const totalCHF = totalUSD * USD_TO_CHF;

  out.write(
    `Tokens: ${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out / ` +
    `${u.cache_creation_input_tokens.toLocaleString()} cache-write / ${u.cache_read_input_tokens.toLocaleString()} cache-read\n` +
    `Cost:   $${totalUSD.toFixed(4)} USD / CHF ${totalCHF.toFixed(4)}\n`,
  );
}

// ── Session management ─────────────────────────────────────────────────

export function saveSession(nodyn: Nodyn): string {
  ensureDirSync(SESSIONS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(SESSIONS_DIR, `${ts}.json`);
  const data = { timestamp: new Date().toISOString(), messages: nodyn.saveMessages() };
  writeFileAtomicSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return filePath;
}

export function loadSessionFile(nodyn: Nodyn, name?: string): boolean {
  if (!existsSync(SESSIONS_DIR)) return false;
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) return false;

  let target: string;
  if (name) {
    const match = files.find(f => f.includes(name));
    if (!match) return false;
    target = match;
  } else {
    target = files[files.length - 1]!;
  }

  try {
    const raw = readFileSync(join(SESSIONS_DIR, target), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('messages' in parsed)) {
      return false;
    }
    const messages = (parsed as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
      return false;
    }
    nodyn.loadMessages(messages);
    return true;
  } catch {
    return false;
  }
}

// ── Command history ────────────────────────────────────────────────────

export function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function appendHistory(line: string): void {
  try {
    appendFileSync(HISTORY_FILE, line + '\n', 'utf-8');
  } catch { /* ignore */ }
}

// ── Aliases ────────────────────────────────────────────────────────────

export function loadAliases(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(ALIASES_FILE, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveAliases(aliases: Record<string, string>): void {
  ensureDirSync(getNodynDir());
  writeFileAtomicSync(ALIASES_FILE, JSON.stringify(aliases, null, 2) + '\n');
}

// ── Git helpers ────────────────────────────────────────────────────────

export function gitExec(cmd: string): string {
  try {
    const args = cmd.split(/\s+/).filter(a => a.length > 0);
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stderr' in err) {
      return String((err as { stderr: unknown }).stderr).trim();
    }
    return 'Git command failed';
  }
}
