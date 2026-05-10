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
let priorFlag: string | undefined;
let priorHome: string | undefined;
let engine: Engine | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lynox-inbox-flag-'));
  priorFlag = process.env['LYNOX_FEATURE_UNIFIED_INBOX'];
  priorHome = process.env['LYNOX_HOME'];
  process.env['LYNOX_HOME'] = tmp;
});

afterEach(async () => {
  if (engine) {
    await engine.shutdown().catch(() => {});
    engine = null;
  }
  if (priorFlag === undefined) delete process.env['LYNOX_FEATURE_UNIFIED_INBOX'];
  else process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = priorFlag;
  if (priorHome === undefined) delete process.env['LYNOX_HOME'];
  else process.env['LYNOX_HOME'] = priorHome;
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
});
