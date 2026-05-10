// === Engine boot with the unified-inbox flag ===
//
// Direct verification that the engine.ts integration block actually
// constructs the InboxRuntime when LYNOX_FEATURE_UNIFIED_INBOX is on
// and skips it when off. Catches wiring drift that the in-process
// bootstrap.test.ts cannot see (it never calls into engine.init).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../src/core/engine.js';

let tmp: string;
let priorEnv: Record<string, string | undefined>;
let engine: Engine | null = null;

const INBOX_ENV_VARS = [
  'LYNOX_FEATURE_UNIFIED_INBOX',
  'LYNOX_HOME',
  'LYNOX_INBOX_LLM_REGION',
  'LYNOX_INBOX_MISTRAL_API_KEY',
  'LYNOX_INBOX_SENSITIVE_MODE',
  'LYNOX_INBOX_FOLDER_BLACKLIST',
  'LYNOX_INBOX_DISABLED_ACCOUNTS',
  'LYNOX_INBOX_PRIVACY_ACK',
  'LYNOX_INBOX_REQUIRE_PRIVACY_ACK',
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lynox-inbox-flag-'));
  priorEnv = {};
  for (const k of INBOX_ENV_VARS) {
    priorEnv[k] = process.env[k];
    if (k !== 'LYNOX_HOME') delete process.env[k];
  }
  process.env['LYNOX_HOME'] = tmp;
});

afterEach(async () => {
  if (engine) {
    await engine.shutdown().catch(() => {});
    engine = null;
  }
  for (const k of INBOX_ENV_VARS) {
    const v = priorEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('Engine boot — unified-inbox flag', () => {
  it('flag off: getInboxRuntime() returns null', async () => {
    delete process.env['LYNOX_FEATURE_UNIFIED_INBOX'];
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).toBeNull();
  });

  it('flag on: bootstrap succeeds, getInboxRuntime() returns a wired runtime', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    engine = new Engine({});
    await engine.init();
    const runtime = engine.getInboxRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    expect(runtime.state).toBeDefined();
    expect(runtime.rules).toBeDefined();
    expect(runtime.budget).toBeDefined();
    expect(runtime.queue).toBeDefined();
    expect(runtime.hook).toBeInstanceOf(Function);
    // Schema migrations ran (the v8 unique index lives in mail-state.db)
    expect(runtime.state.listItems()).toEqual([]);
    expect(runtime.budget.snapshot().exceeded).toBe(false);
  });

  it('flag on: shutdown drains the inbox runtime cleanly', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).not.toBeNull();
    await engine.shutdown();
    // After shutdown the engine's inbox handle is cleared (idempotent).
    expect(engine.getInboxRuntime()).toBeNull();
    engine = null;
  });

  it('LYNOX_INBOX_LLM_REGION=eu requires a Mistral API key to bootstrap', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['LYNOX_INBOX_LLM_REGION'] = 'eu';
    // No MISTRAL_API_KEY set — bootstrapInbox throws and engine swallows.
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).toBeNull();
  });

  it('LYNOX_INBOX_LLM_REGION=eu + MISTRAL_API_KEY bootstraps the runtime', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['LYNOX_INBOX_LLM_REGION'] = 'eu';
    process.env['LYNOX_INBOX_MISTRAL_API_KEY'] = 'test-eu-key';
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).not.toBeNull();
  });

  it('LYNOX_INBOX_REQUIRE_PRIVACY_ACK=1 without ack refuses to bootstrap (US default)', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['LYNOX_INBOX_REQUIRE_PRIVACY_ACK'] = '1';
    // ack not set
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).toBeNull();
  });

  it('LYNOX_INBOX_REQUIRE_PRIVACY_ACK=1 + PRIVACY_ACK=1 bootstraps the runtime', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['LYNOX_INBOX_REQUIRE_PRIVACY_ACK'] = '1';
    process.env['LYNOX_INBOX_PRIVACY_ACK'] = '1';
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).not.toBeNull();
  });
});
