import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';
import type { Session } from './session.js';

/**
 * The system prompt names the Shopify preset only while the token exchange is switched on.
 *
 * Read from a REAL engine's session, for the reason `google-visibility-boot.test.ts` gives: the
 * thing under test is the wiring in `Session._createAgent`, which a unit test of the suffix
 * cannot see. One engine for the whole file, and the switch stubbed per session AFTER the import
 * and the boot: a value read at import or captured at boot leaves the later sessions unchanged,
 * and the tests below fail.
 */
function promptOf(session: Session): string {
  const agent = (session as unknown as { agent: { systemPrompt?: string } | null }).agent;
  if (typeof agent?.systemPrompt !== 'string') {
    throw new Error('no system prompt on the session agent — the probe broke, this is not a pass');
  }
  return agent.systemPrompt;
}

// A string of the hint alone; the rest of the prompt never names the preset.
const HINT = 'auth.oauth.preset_id "shopify"';

describe('Session prompt — the Shopify preset follows the exchange switch', () => {
  let dir = '';
  let engine: Engine;
  const savedDataDir = process.env['LYNOX_DATA_DIR'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-shopify-prompt-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    engine = new Engine({} as LynoxConfig);
    await engine.init();
    // A boot under a loaded box outlasts the default hook timeout; a failed hook fails the file.
  }, 60_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    try { await engine.shutdown(); } catch { /* best effort */ }
    if (savedDataDir === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
    reloadConfig();
  });

  it('unset: no hint, and the prompt does not name Shopify at all', () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    const prompt = promptOf(engine.createSession());
    expect(prompt).not.toContain(HINT);
    expect(prompt).not.toMatch(/shopify/i);
  });

  it.each(['1', 'true'])('"%s": the hint is there', (value) => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', value);
    expect(promptOf(engine.createSession())).toContain(HINT);
  });

  it.each(['yes', '0', 'false', 'TRUE', ''])('"%s": no hint, as the exchange refuses', (value) => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', value);
    expect(promptOf(engine.createSession())).not.toContain(HINT);
  });

  it('switches both ways between two sessions of one engine', () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
    expect(promptOf(engine.createSession())).toContain(HINT);
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    expect(promptOf(engine.createSession())).not.toContain(HINT);
  });
});
