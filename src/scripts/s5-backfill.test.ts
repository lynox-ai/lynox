import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, shouldRefusePlaintextPii } from './s5-backfill.js';

describe('s5-backfill parseArgs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults: dry-run, no json, pageSize 500, no data-dir override, encryption required', () => {
    expect(parseArgs([])).toEqual({ apply: false, json: false, pageSize: 500, dataDir: null, allowPlaintext: false });
  });

  it('parses every flag', () => {
    expect(parseArgs(['--apply', '--json', '--allow-plaintext', '--page-size=50', '--data-dir=/srv/.lynox']))
      .toEqual({ apply: true, json: true, pageSize: 50, dataDir: '/srv/.lynox', allowPlaintext: true });
  });

  it('falls back to pageSize 500 on a non-numeric or zero --page-size', () => {
    expect(parseArgs(['--page-size=abc']).pageSize).toBe(500); // NaN → 500
    expect(parseArgs(['--page-size=0']).pageSize).toBe(500);   // 0 is falsy → 500 fallback
  });

  it('exits 2 on an unknown arg', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    parseArgs(['--nope']);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 0 on --help', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    parseArgs(['--help']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('s5-backfill shouldRefusePlaintextPii (PII at-rest gate)', () => {
  const dirs: string[] = [];
  function tmp(withVault: boolean): string {
    const d = mkdtempSync(join(tmpdir(), 'lynox-s5gate-'));
    dirs.push(d);
    if (withVault) writeFileSync(join(d, 'vault.db'), '');
    return d;
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('REFUSES when vault.db exists but engine.db is unencrypted (would write PII plaintext)', () => {
    expect(shouldRefusePlaintextPii(tmp(true), false, false)).toBe(true);
  });
  it('allows when the tenant is genuinely keyless (no vault.db)', () => {
    expect(shouldRefusePlaintextPii(tmp(false), false, false)).toBe(false);
  });
  it('allows when engine.db IS encrypted (key resolved)', () => {
    expect(shouldRefusePlaintextPii(tmp(true), true, false)).toBe(false);
  });
  it('allows when --allow-plaintext overrides the refusal', () => {
    expect(shouldRefusePlaintextPii(tmp(true), false, true)).toBe(false);
  });
});
