import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The engine starts error reporting before engine.db is open. On an instance that holds the
 * exact marker it must not start it at all, so the init is counted here, not its effect.
 */
const inits: unknown[] = [];
vi.mock('./error-reporting.js', async () => {
  const actual = await vi.importActual<typeof import('./error-reporting.js')>('./error-reporting.js');
  return { ...actual, initErrorReporting: async (dsn?: string) => { inits.push(dsn); return false; } };
});

const { Engine } = await import('./engine.js');
const { EngineDb } = await import('./engine-db.js');
const { reloadConfig } = await import('./config.js');
type LynoxConfig = import('../types/index.js').LynoxConfig;

describe('Engine boot — error reporting and the exact marker', { timeout: 30_000 }, () => {
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

  async function bootIn(held: boolean): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), `lynox-bugsink-${held ? 'held' : 'free'}-`));
    dirs.push(dir);
    for (const k of ['ANTHROPIC_LOG', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_BUGSINK_DSN', 'https://key@bugs.example.invalid/1');
    if (held) {
      const db = new EngineDb();
      db.setExactMarker();
      db.close();
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
  }

  it('starts it on an instance without the marker', async () => {
    await bootIn(false);
    expect(inits).toEqual(['https://key@bugs.example.invalid/1']);
  });

  it('never starts it on an instance whose engine.db holds the marker', async () => {
    await bootIn(true);
    expect(inits).toEqual([]);
  });
});
