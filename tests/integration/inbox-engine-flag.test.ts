// === Engine boot with the unified-inbox flag ===
//
// Direct verification that the engine.ts integration block actually
// constructs the InboxRuntime when LYNOX_FEATURE_UNIFIED_INBOX is on
// and skips it when off. Catches wiring drift that the in-process
// bootstrap.test.ts cannot see (it never calls into engine.init).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../src/core/engine.js';

// The options each real bootstrap was called with, so a test can read what the cold boot chose
// for the classifier's key and meter. The bootstrap itself still runs.
const bootCalls = vi.hoisted(() => [] as Array<{ mistralApiKey?: string; meteredHost?: unknown; confirmAutoReply?: unknown }>);
vi.mock('../../src/integrations/inbox/bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/inbox/bootstrap.js')>();
  return {
    ...actual,
    bootstrapInbox: (opts: Parameters<typeof actual.bootstrapInbox>[0]) => {
      bootCalls.push(opts);
      return actual.bootstrapInbox(opts);
    },
  };
});

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
  'LYNOX_BILLING_TIER',
  'LYNOX_MANAGED_MODE',
  'MISTRAL_API_KEY',
  'LYNOX_MANAGED_CONTROL_PLANE_URL',
  'LYNOX_MANAGED_INSTANCE_ID',
  'LYNOX_HTTP_SECRET',
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lynox-inbox-flag-'));
  bootCalls.length = 0;
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

  // 1070: the cold boot wires the classifier's verdict lookup for mail_triage.
  it('flag on: the cold boot wires the inbox verdict lookup into the mail context', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    engine = new Engine({});
    await engine.init();
    const runtime = engine.getInboxRuntime();
    const mailContext = (engine as unknown as { _mailContext: { hooks: { inboxLabelOf?: unknown; inboxReader?: unknown } } | null })._mailContext;
    expect(runtime).not.toBeNull();
    expect(mailContext, 'the boot made a mail context, so the check below is not vacuous').not.toBeNull();
    expect(mailContext!.hooks.inboxLabelOf).toBe(runtime!.inboxLabelOf);
    // inbox_read reads the store through the same wiring.
    expect(mailContext!.hooks.inboxReader).toBe(runtime!.inboxReader);
  });

  // 801 part 1b: a Graph envelope from the watch carries no headers, so the hook asks the mail
  // registry for the full message before a follow-up reopens a replied item.
  it('flag on: the cold boot gives the inbox a lookup that reads the message through the mail registry', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    engine = new Engine({});
    await engine.init();
    const confirm = (bootCalls.at(-1) as { confirmAutoReply?: (id: string, env: unknown) => Promise<boolean> } | undefined)?.confirmAutoReply;
    expect(confirm).toBeInstanceOf(Function);
    const mailContext = (engine as unknown as { _mailContext: { registry: { add(p: unknown): void } } | null })._mailContext;
    expect(mailContext, 'the boot made a mail context').not.toBeNull();
    const fetch = vi.fn(async () => ({ envelope: { isAutoReply: true }, text: '' }));
    mailContext!.registry.add({ accountId: 'acct-graph', authType: 'oauth_microsoft', fetch });
    await expect(confirm!('acct-graph', { uid: 7, folder: 'INBOX' })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith({ uid: 7, folder: 'INBOX' });
    await expect(confirm!('acct-missing', { uid: 7, folder: 'INBOX' })).rejects.toThrow();

    // End to end through the runtime's hook: a Graph account's follow-up on a replied item stays
    // closed when the fetched message is an automatic reply, and opens when it is not.
    const runtime = engine.getInboxRuntime()!;
    const mailDb = (engine as unknown as { _mailStateDb: { upsertAccount(a: unknown): void } })._mailStateDb;
    mailDb.upsertAccount({
      id: 'acct-graph', displayName: 'M365', address: 'me@m365.example', preset: 'custom',
      imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
      authType: 'oauth_microsoft', type: 'personal', isDefault: false,
    });
    const itemId = runtime.state.insertItem({
      accountId: 'acct-graph', channel: 'email', threadKey: 'graph:conv-1', bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'r', classifiedAt: new Date('2026-11-03T08:00:00Z'), classifierVersion: 'v1', messageId: '<first@m365>',
    });
    runtime.state.updateUserAction(itemId, 'replied', new Date('2026-11-03T09:00:00Z'));
    const env = (messageId: string) => ({
      uid: 7, messageId, folder: 'INBOX', threadKey: 'graph:conv-1', inReplyTo: '<first@m365>',
      from: [{ address: 'kunde@example.com' }], to: [], cc: [], replyTo: [], subject: 'Re', date: new Date('2026-11-04T09:00:00Z'),
      flags: [], snippet: 'x', hasAttachments: false, attachmentCount: 0, sizeBytes: 0, isAutoReply: false,
    });
    await runtime.hook('acct-graph', env('<ooo@m365>'));
    expect(runtime.state.getItem(itemId)!.userAction).toBe('replied');
    fetch.mockResolvedValue({ envelope: { isAutoReply: false }, text: '' });
    await runtime.hook('acct-graph', env('<real@m365>'));
    expect(runtime.state.getItem(itemId)!.userAction).toBeUndefined();
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

  // The cold boot chooses the classifier's key and meter through the same method as the
  // rebootstrap, but only the rebootstrap had a test for the meter. A cold boot that dropped it
  // would run the pool's Mistral key without debiting the instance.
  it('on a pool tier the cold boot gives the EU classifier the pool\'s key and debits the instance', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['LYNOX_INBOX_LLM_REGION'] = 'eu';
    process.env['LYNOX_BILLING_TIER'] = 'managed';
    process.env['MISTRAL_API_KEY'] = 'pool-mistral-key';
    // A pool tier boots the managed hook, which needs these; nothing listens on the port, so its
    // status sync fails and leaves the boot alone.
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'http://127.0.0.1:9';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-inbox-test';
    process.env['LYNOX_HTTP_SECRET'] = 'inbox-test-secret';
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).not.toBeNull();
    expect(bootCalls).toHaveLength(1);
    expect(bootCalls[0]!.mistralApiKey).toBe('pool-mistral-key');
    expect(bootCalls[0]!.meteredHost).toBe(engine);
  });

  it('off a pool tier the cold boot debits nothing for the same key (control)', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['LYNOX_INBOX_LLM_REGION'] = 'eu';
    process.env['MISTRAL_API_KEY'] = 'own-mistral-key';
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).not.toBeNull();
    expect(bootCalls).toHaveLength(1);
    expect(bootCalls[0]!.mistralApiKey).toBe('own-mistral-key');
    expect(bootCalls[0]!.meteredHost).toBeUndefined();
  });

  it('off a pool tier the cold boot debits nothing for the US classifier either (control)', async () => {
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    engine = new Engine({});
    await engine.init();
    expect(engine.getInboxRuntime()).not.toBeNull();
    expect(bootCalls).toHaveLength(1);
    expect(bootCalls[0]!.meteredHost).toBeUndefined();
  });
});
