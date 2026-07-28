import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendUntrustedCauseLog, UNTRUSTED_CAUSE_LOG_FILE } from './untrusted-cause-log.js';

/**
 * The point of this file is the PII assertion. The emit sites sit next to the full memory body,
 * so the ONE way this telemetry becomes a liability is a future field that carries the text
 * along "just for context". A structural assertion catches that; a comment does not — and the
 * sibling sink (`memory-write-decision-log.ts`) claims an "acceptance grep" in its header that
 * exists nowhere in the repo, which is exactly how such a rule quietly stops being one.
 */
describe('untrusted-cause log', () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lynox-cause-log-'));
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dir;
  });
  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const readLines = async (): Promise<Array<Record<string, unknown>>> => {
    for (let i = 0; i < 40; i++) {
      try {
        const raw = await readFile(join(dir, UNTRUSTED_CAUSE_LOG_FILE), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        if (lines.length > 0) return lines.map(l => JSON.parse(l) as Record<string, unknown>);
      } catch { /* not yet flushed */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 25));
    }
    return [];
  };

  it('records the cause, the site and the verdict', async () => {
    await appendUntrustedCauseLog({
      ts: 1, site: 'remember', cause: 'conversation', untrusted: true,
      threadId: 'th-1', runId: 'run-1',
    });
    const [row] = await readLines();
    expect(row?.['site']).toBe('remember');
    expect(row?.['cause']).toBe('conversation');
    expect(row?.['untrusted']).toBe(true);
    expect(row?.['threadId']).toBe('th-1');
  });

  // MUTATION: add a `text`/`body`/`content` field to the entry to "make review easier" → this
  // fails. That is the whole guard: the record must never be able to carry the memory body,
  // because a `secret:`-resolved value or PII would then land in a plain file next to the db.
  it('carries NO field that could hold the memory body', async () => {
    await appendUntrustedCauseLog({
      ts: 2, site: 'auto-extract', cause: 'external-tool', untrusted: true, threadId: 'th-2',
    });
    const [row] = await readLines();
    const keys = Object.keys(row ?? {});
    for (const forbidden of ['text', 'body', 'content', 'fact', 'entry', 'snippet', 'preview']) {
      expect(keys, `record must not carry a "${forbidden}" key`).not.toContain(forbidden);
    }
    expect(keys.sort()).toEqual(['cause', 'site', 'threadId', 'ts', 'untrusted']);
  });

  // The sink must never be able to break a durable write. MUTATION: drop the try/catch in
  // `appendBoundedJsonl` → an unwritable data dir rejects here and the `void`-ed call at the
  // write site becomes an unhandled rejection.
  it('never rejects, even when the data dir is unwritable', async () => {
    process.env['LYNOX_DATA_DIR'] = join(dir, 'does', 'not', 'exist', 'and-is-a-file\0bad');
    await expect(appendUntrustedCauseLog({
      ts: 3, site: 'memory-store', cause: 'marker', untrusted: true,
    })).resolves.toBeUndefined();
  });
});
