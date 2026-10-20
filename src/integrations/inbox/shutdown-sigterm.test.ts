import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MailStateDb } from '../mail/state.js';

/**
 * A container stop sends SIGTERM and kills the process 10 s later. A mail the inbox has queued is
 * already marked seen, so one that is neither classified nor surfaced by then is gone. This test
 * stops a real process with a backlog while the provider hangs: SIGTERM through the production
 * signal handler, SIGKILL at 10 s as the container runtime does, then the store is reopened and
 * every mail must be either classified or surfaced as drained for the shutdown.
 */

vi.setConfig({ testTimeout: 60_000 });

const CHILD = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'inbox-sigterm-child.ts');
/** Docker's default grace between SIGTERM and SIGKILL; no deploy path sets another. */
const CONTAINER_GRACE_MS = 10_000;
const MAILS = 40;
const ANSWERED = 3;

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-inbox-sigterm-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Stopped { code: number | null; signal: NodeJS.Signals | null; stderr: string }

function stopWithBacklog(dbPath: string): Promise<Stopped> {
  return new Promise((resolve, reject) => {
    // TMPDIR too: the child's tsx keeps its cache there, and it goes with the test's directory.
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1', HOME: dir, LYNOX_DIR: join(dir, '.lynox'), TMPDIR: dir };
    delete env['ANTHROPIC_API_KEY'];
    delete env['MISTRAL_API_KEY'];
    const p = spawn(process.execPath, ['--import', 'tsx', CHILD, dbPath, String(MAILS), String(ANSWERED)], { env });
    let stdout = '';
    let stderr = '';
    let killer: ReturnType<typeof setTimeout> | undefined;
    p.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (killer === undefined && stdout.includes('ready\n')) {
        p.kill('SIGTERM');
        killer = setTimeout(() => p.kill('SIGKILL'), CONTAINER_GRACE_MS);
      }
    });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      clearTimeout(killer);
      if (killer === undefined) { reject(new Error(`child never got ready: ${stdout} ${stderr}`)); return; }
      resolve({ code, signal, stderr });
    });
  });
}

describe('SIGTERM with an inbox backlog and a hung provider', () => {
  it('leaves every queued mail classified or surfaced, and the inbox ends inside the container grace', async () => {
    const dbPath = join(dir, 'mail-state.db');
    const stopped = await stopWithBacklog(dbPath);

    // The process ended on its own, before the container runtime would have killed it. The exit
    // code is 0 either way (the handler exits 0 when the shutdown throws); the proof is the
    // signal, and the rows below. The engine here has no stores or shutdown hooks of its own:
    // this is the inbox's share of the grace, not the whole shutdown's.
    expect(stopped.signal, `killed at the grace: ${stopped.stderr}`).toBeNull();
    expect(stopped.code).toBe(0);

    const mail = new MailStateDb({ path: dbPath });
    try {
      const rows = mail.getConnection()
        .prepare('SELECT thread_key, classifier_version, reason_de FROM inbox_items')
        .all() as Array<{ thread_key: string; classifier_version: string; reason_de: string }>;
      const byThread = new Map(rows.map((r) => [r.thread_key, r]));
      const missing: string[] = [];
      for (let n = 1; n <= MAILS; n++) {
        if (!byThread.has(`imap:t${String(n)}`)) missing.push(`imap:t${String(n)}`);
      }
      expect(missing, 'mails neither classified nor surfaced').toEqual([]);
      expect(rows).toHaveLength(MAILS);

      const surfaced = rows.filter((r) => r.classifier_version === 'shutdown-drain');
      const classified = rows.filter((r) => r.classifier_version !== 'shutdown-drain');
      expect(classified).toHaveLength(ANSWERED);
      expect(classified.every((r) => !r.classifier_version.startsWith('dead-letter'))).toBe(true);
      expect(surfaced).toHaveLength(MAILS - ANSWERED);
      expect(new Set(surfaced.map((r) => r.reason_de))).toEqual(new Set(['Beim Herunterfahren nicht klassifiziert — manuell prüfen.']));
    } finally {
      mail.close();
    }
    // The two running when the provider hung were cut off; the rest were still waiting.
    expect(stopped.stderr).toContain(`inbox on shutdown: ${String(MAILS - ANSWERED)} mails queued, ${String(MAILS - ANSWERED - 2)} surfaced unclassified, 2 cut off while classifying`);
  });
});
