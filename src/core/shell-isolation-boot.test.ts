import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { createToolContext } from './tool-context.js';
import { resetShellIsolationForTest, setShellIsolationForTest, type ShellIsolation } from './shell-isolation.js';
import type { LynoxConfig } from '../types/index.js';

/** A process in sidecar mode, as `shellIsolation()` holds it after a boot that passed its checks. */
const SIDECAR = { kind: 'sidecar', socket: '/run/lynox-exec/exec.sock', root: { mode: 'sidecar', anchor: {}, label: '/workspace' } } as unknown as ShellIsolation;

/**
 * The mode reaches what the engine builds at boot: a unit test that hands the mode in itself cannot
 * see that the engine passes it on (fb_boot_wiring_test), so it is measured on a booted engine.
 */
describe('Engine boot in sidecar mode', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = process.env['LYNOX_DATA_DIR'];

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (saved === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = saved;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    resetShellIsolationForTest();
    reloadConfig();
  });

  it('gives the tool context the process\'s mode and the context the label from the constant (D0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sidecar-boot-'));
    dirs.push(dir);
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    setShellIsolationForTest(SIDECAR);
    const engine = new Engine({ context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' } } as unknown as LynoxConfig);
    engines.push(engine);
    // The start stops before any workspace site that still reaches the tree by name (D3), and
    // creates nothing there: the data directory holds no workspace afterwards.
    await expect(engine.init()).rejects.toThrow(/Shell sidecar start check \(D3\) failed: the workspace is still reached by name/);
    expect(existsSync(join(dir, 'workspace'))).toBe(false);
    expect(engine.getToolContext().shellIsolation).toBe(SIDECAR);
    expect(engine.getContext()?.workspaceDir).toBe('/workspace/http-api');
  });

  it('gives a context made without an engine the process\'s mode, not "local"', () => {
    setShellIsolationForTest(SIDECAR);
    expect(createToolContext({}).shellIsolation).toBe(SIDECAR);
  });
});
