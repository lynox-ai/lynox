/**
 * tests/online/ runs only with LYNOX_ONLINE=1 — the decision, and that vitest.config.ts acts on it.
 *
 * The wiring cases spawn `vitest list`, which collects test files without running them, so no
 * provider is called. Each runs under a throwaway HOME whose ~/.lynox/config.json DOES carry a
 * key: the skip must hold even when a key is there, which is the case this switch exists for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { onlineTestsSkipReason } from '../scripts/vitest-online-opt-in.js';

describe('onlineTestsSkipReason', () => {
  it('skips without LYNOX_ONLINE, and says how to opt in', () => {
    expect(onlineTestsSkipReason({})).toMatch(/LYNOX_ONLINE=1/);
  });

  it('runs with LYNOX_ONLINE=1', () => {
    expect(onlineTestsSkipReason({ LYNOX_ONLINE: '1' })).toBeNull();
  });

  it.each(['', '0', 'true', 'yes'])('skips for LYNOX_ONLINE=%j, like LYNOX_EVAL only 1 counts', (v) => {
    expect(onlineTestsSkipReason({ LYNOX_ONLINE: v })).not.toBeNull();
  });
});

describe('vitest.config.ts leaves tests/online/ out unless asked', { timeout: 120_000 }, () => {
  const root = resolve(__dirname, '..');
  let home = '';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'lynox-online-optin-'));
    mkdirSync(join(home, '.lynox'));
    writeFileSync(join(home, '.lynox', 'config.json'), JSON.stringify({ anthropic_api_key: 'from-config-field' }));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function list(optIn: boolean): string {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'LYNOX_ONLINE' || k === 'ANTHROPIC_API_KEY') delete env[k];
    if (optIn) env['LYNOX_ONLINE'] = '1';
    return execFileSync(join(root, 'node_modules', '.bin', 'vitest'), ['list', 'tests/online/agent.test.ts', '--filesOnly'], {
      cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it('without LYNOX_ONLINE: not collected, and the run says why', () => {
    const out = list(false);
    expect(out).toContain('tests/online/ skipped');
    expect(out).not.toContain('tests/online/agent.test.ts');
  });

  it('with LYNOX_ONLINE=1: collected', () => {
    const out = list(true);
    expect(out).toContain('tests/online/agent.test.ts');
    expect(out).not.toContain('tests/online/ skipped');
  });
});
