import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { LynoxHTTPApi } from '../server/http-api.js';

/**
 * Opening engine.db or history.db when the file looks corrupt.
 *
 * The boot must start, so it sets such a file aside as `<file>.corrupt-<ms>` and opens an empty
 * one. Every other opener — an operator script against a live data directory, a restore — edits
 * a database something else then uses; an empty one in its place would pass for the real one, and
 * after a rename under a running engine that engine writes on into the renamed file while the next
 * start begins empty. So the stores keep the file and
 * throw by default, and only the boot asks for the set-aside.
 */

const GARBAGE = 'this is not a sqlite database, it is garbage bytes';
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function corruptDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-store-corrupt-'));
  dirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), GARBAGE);
  return dir;
}

describe('opening a store whose file looks corrupt, outside the boot', () => {
  const STORES = [
    { file: 'engine.db', open: (path: string): { close(): void } => new EngineDb(path, '') },
    { file: 'history.db', open: (path: string): { close(): void } => new RunHistory(path) },
  ] as const;

  it.each(STORES)('$file: throws, says what to do, and leaves the file as it was', ({ file, open }) => {
    const dir = corruptDir(file);
    let thrown: unknown;
    try { open(join(dir, file)).close(); } catch (err) { thrown = err; }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(`${file} looks corrupt`);
    expect(message).toContain('nothing was renamed or replaced');
    expect(message).toContain('the next start moves it aside and begins with an empty database; to keep its data, restore it from a backup');
    expect(message).not.toContain(dir); // the name, not the path: a restore passes this on
    expect((thrown as Error).cause).toBeInstanceOf(Error);

    expect(readdirSync(dir)).toEqual([file]);
    expect(readFileSync(join(dir, file), 'utf8')).toBe(GARBAGE);
  });
});

describe('the boot on a data directory with a corrupt engine.db and history.db', () => {
  it('sets both aside, starts on empty ones, and says ok', async () => {
    const dir = corruptDir('engine.db', 'history.db');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('LYNOX_HTTP_SECRET', 'store-open-test-secret-value');
    vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', undefined);

    const api = new LynoxHTTPApi();
    try {
      await api.init();
      await api.start(0);
      const res = await fetch(`http://127.0.0.1:${String(api.boundPort)}/api/health`);
      const body = (await res.json()) as { status?: unknown };
      // Both stores opened: with either missing the body says `degraded`.
      expect(body.status).toBe('ok');
    } finally {
      await api.shutdown();
    }

    const entries = readdirSync(dir);
    for (const file of ['engine.db', 'history.db']) {
      expect(entries.some((e) => e.startsWith(`${file}.corrupt-`)), `${file} set aside`).toBe(true);
    }
  }, 60_000);
});
