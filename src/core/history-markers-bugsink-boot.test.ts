import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Error reporting starts before the stores open, and reads history.db's copy of the exact
 * marker only on an instance with a control plane (cut S3-E, `exact-debug-refusal.ts`). A
 * self-hosted instance whose history.db is corrupt, predates the copy or carries one from
 * elsewhere still starts it. Counted at the init, as in `exact-bugsink-boot.test.ts`.
 */
const inits: unknown[] = [];
vi.mock('./error-reporting.js', async () => {
  const actual = await vi.importActual<typeof import('./error-reporting.js')>('./error-reporting.js');
  return { ...actual, initErrorReporting: async (dsn?: string) => { inits.push(dsn); return false; } };
});

const { Engine } = await import('./engine.js');
const { RunHistory } = await import('./run-history.js');
const { ExactMirror } = await import('./history-markers.js');
const { reloadConfig } = await import('./config.js');
type LynoxConfig = import('../types/index.js').LynoxConfig;
const DSN = 'https://key@bugs.example.invalid/1';

describe('Engine boot — error reporting and history.db\'s copy of the exact marker', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };

  afterEach(async () => {
    for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    inits.length = 0;
    vi.restoreAllMocks();
    reloadConfig();
  });

  async function bootIn(prepare: (dir: string) => void, managed: boolean | 'id-only'): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s3e-bugsink-'));
    dirs.push(dir);
    for (const k of ['ANTHROPIC_LOG', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_BUGSINK_DSN', DSN);
    if (managed === 'id-only') setEnv('LYNOX_MANAGED_INSTANCE_ID', 'i-boot');
    else if (managed) {
      setEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'http://cp.invalid');
      setEnv('LYNOX_MANAGED_INSTANCE_ID', 'i-boot');
      setEnv('LYNOX_HTTP_SECRET', 's');
    }
    prepare(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
  }

  const corruptHistory = (dir: string): void => { writeFileSync(join(dir, 'history.db'), 'not a database '.repeat(200)); };
  const foreignCopy = (dir: string): void => {
    void dir;
    const h = new RunHistory();
    new ExactMirror(h.getDb(), 'someone-else').set();
    h.close();
  };

  it('self-host, corrupt history.db: starts it', async () => {
    await bootIn(corruptHistory, false);
    expect(inits).toEqual([DSN]);
  });

  it('self-host, history.db carrying another instance\'s copy: starts it', async () => {
    await bootIn(foreignCopy, false);
    expect(inits).toEqual([DSN]);
  });

  it('managed, the same copy: never starts it (the control for both)', async () => {
    await bootIn(foreignCopy, true);
    expect(inits).toEqual([]);
  });

  it('managed, corrupt history.db: never starts it (unreadable counts as held)', async () => {
    await bootIn(corruptHistory, true);
    expect(inits).toEqual([]);
  });

  it('provisioned with the control-plane env incomplete, the same copy: never starts it', async () => {
    await bootIn(foreignCopy, 'id-only');
    expect(inits).toEqual([]);
  });
});
