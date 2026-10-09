import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';

/**
 * The security audit trail starts at boot whether or not RunHistory opened.
 *
 * SecurityAudit opens its own connection and creates its own table; it needs nothing from
 * RunHistory. When RunHistory fails for a reason of its own, the engine keeps running without
 * history, and the audit trail must keep recording. When the audit trail itself cannot start,
 * the engine says so instead of running without it in silence. Both are init-ORDER properties,
 * so this boots a real Engine (the shape of egress-policy-boot.test.ts).
 */
const runHistoryOpen = vi.hoisted(() => ({ fail: false }));
const auditOpen = vi.hoisted(() => ({ fail: false }));

vi.mock('./run-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-history.js')>();
  class RunHistoryThatMayNotOpen extends actual.RunHistory {
    constructor(...args: ConstructorParameters<typeof actual.RunHistory>) {
      if (runHistoryOpen.fail) throw new Error('run history unavailable');
      super(...args);
    }
  }
  return { ...actual, RunHistory: RunHistoryThatMayNotOpen };
});

vi.mock('./security-audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./security-audit.js')>();
  class SecurityAuditThatMayNotOpen extends actual.SecurityAudit {
    constructor(...args: ConstructorParameters<typeof actual.SecurityAudit>) {
      if (auditOpen.fail) throw new Error('audit store unavailable');
      super(...args);
    }
  }
  return { ...actual, SecurityAudit: SecurityAuditThatMayNotOpen };
});

const { Engine } = await import('./engine.js');
const { reloadConfig } = await import('./config.js');

interface EngineInternals { runHistory: unknown; getSecurityAudit(): unknown }

describe('Engine boot — the security audit trail does not depend on run history', () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  let savedDataDir: string | undefined;

  afterEach(async () => {
    runHistoryOpen.fail = false;
    auditOpen.fail = false;
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (savedDataDir === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = savedDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function boot(historyOpens: boolean): Promise<{ engine: EngineInternals; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-auditboot-'));
    dirs.push(dir);
    savedDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    runHistoryOpen.fail = !historyOpens;
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await engine.init();
    } finally {
      spy.mockRestore();
    }
    return { engine: engine as unknown as EngineInternals, stderr: lines.join('') };
  }

  it('starts the audit trail when run history opened', async () => {
    const { engine } = await boot(true);
    expect(engine.runHistory).not.toBeNull();
    expect(engine.getSecurityAudit()).not.toBeNull();
  });

  it('starts the audit trail when run history is unavailable', async () => {
    const { engine } = await boot(false);
    // The case under test is real: the engine booted without its history.
    expect(engine.runHistory).toBeNull();
    expect(engine.getSecurityAudit()).not.toBeNull();
  });

  it('says so when the audit trail itself cannot start', async () => {
    auditOpen.fail = true;
    const { engine, stderr } = await boot(true);
    expect(engine.getSecurityAudit()).toBeNull();
    expect(stderr).toMatch(/security audit/i);
    expect(stderr).toContain('audit store unavailable');
  });
});
