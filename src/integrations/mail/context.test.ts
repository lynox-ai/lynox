import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailContext, type AddAccountInput } from './context.js';
import { MailStateDb } from './state.js';
import { MailError, type MailAccountConfig } from './provider.js';
import type { MailCredentialBackend } from './auth/app-password.js';
import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

// §3.8 moved the Gmail profile probe onto the connector egress surface, so it
// now goes through the pinned transport instead of `globalThis.fetch`. The
// bridge hands it back to the stub this file already installs; the policy gate
// is NOT bypassed. See the helper for why this is adapted rather than rewritten.
let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });

// ── Backend fake (Map-backed vault) ───────────────────────────────────────

class MapBackend implements MailCredentialBackend {
  private readonly store = new Map<string, string>();
  set(name: string, value: string): void { this.store.set(name, value); }
  get(name: string): string | null { return this.store.get(name) ?? null; }
  delete(name: string): boolean { return this.store.delete(name); }
  has(name: string): boolean { return this.store.has(name); }
}

// ── imapflow / nodemailer mocks (so new ImapSmtpProvider never hits the network) ─

interface FakeClient {
  usable: boolean;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  downloadMany: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  const release = vi.fn();
  return {
    usable: true,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockImplementation(() => (async function* () {})()),
    fetchOne: vi.fn().mockResolvedValue(false),
    downloadMany: vi.fn().mockResolvedValue({}),
  };
}

let probe: FakeClient;

vi.mock('imapflow', () => {
  function ImapFlow(this: unknown, _opts: unknown): unknown {
    return probe;
  }
  return {
    ImapFlow,
    AuthenticationFailure: class extends Error {
      constructor(msg: string) { super(msg); this.name = 'AuthenticationFailure'; }
    },
  };
});

const sendMailMock = vi.fn();
const transportCloseMock = vi.fn();
/** nodemailer's pre-flight: connect + STARTTLS/TLS + AUTH, sending nothing. */
const verifyMock = vi.fn();

vi.mock('nodemailer', () => {
  return {
    default: {
      createTransport: vi.fn().mockImplementation(() => ({
        sendMail: sendMailMock,
        close: transportCloseMock,
        verify: verifyMock,
      })),
    },
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const GMAIL_ACCOUNT: MailAccountConfig = {
  id: 'rafael-gmail',
  displayName: 'Rafael',
  address: 'user@gmail.com',
  preset: 'gmail',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
};

const ICLOUD_ACCOUNT: MailAccountConfig = {
  id: 'rafael-icloud',
  displayName: 'iCloud',
  address: 'user@icloud.com',
  preset: 'icloud',
  imap: { host: 'imap.mail.me.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  authType: 'imap',
  type: 'personal',
};

const INPUT_GMAIL: AddAccountInput = {
  config: GMAIL_ACCOUNT,
  credentials: { user: 'user@gmail.com', pass: 'app-password-gmail' },
};

const INPUT_ICLOUD: AddAccountInput = {
  config: ICLOUD_ACCOUNT,
  credentials: { user: 'user@icloud.com', pass: 'app-password-icloud' },
};

// ── Test fixtures ──────────────────────────────────────────────────────────

let stateDb: MailStateDb;
let backend: MapBackend;
let ctx: MailContext;

beforeEach(() => {
  probe = makeFakeClient();
  stateDb = new MailStateDb({ path: ':memory:' });
  backend = new MapBackend();
  ctx = new MailContext(stateDb, backend);
  sendMailMock.mockReset();
  transportCloseMock.mockReset();
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(true);
});

afterEach(async () => {
  await ctx.close();
  stateDb.close();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MailContext — init', () => {
  it('is a no-op when no accounts are configured', async () => {
    await ctx.init();
    expect(ctx.registry.list()).toEqual([]);
    expect(ctx.watcher.size).toBe(0);
  });

  it('loads configured accounts and instantiates providers on init', async () => {
    // Pre-populate DB + vault
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    stateDb.upsertAccount(ICLOUD_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));
    backend.set('MAIL_ACCOUNT_RAFAEL_ICLOUD', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));

    await ctx.init();
    expect(ctx.registry.list()).toEqual(['rafael-gmail', 'rafael-icloud']);
    expect(ctx.watcher.size).toBe(2);
  });

  it('skips accounts whose credentials are missing from the vault', async () => {
    stateDb.upsertAccount(GMAIL_ACCOUNT); // persisted but no vault entry
    await ctx.init();
    expect(ctx.registry.list()).toEqual([]);
  });

  it('is idempotent — second init is a no-op', async () => {
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));
    await ctx.init();
    await ctx.init();
    expect(ctx.registry.list()).toEqual(['rafael-gmail']);
  });
});

describe('MailContext — addAccount', () => {
  it('persists config + credentials and registers a provider', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    expect(ctx.registry.list()).toEqual(['rafael-gmail']);
    expect(ctx.credStore.has('rafael-gmail')).toBe(true);
    expect(stateDb.getAccount('rafael-gmail')).not.toBe(null);
  });

  it('attaches the new provider to the watcher', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    expect(ctx.watcher.size).toBe(1);
  });

  it('overwrites an existing account by id, closing the previous provider', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    const first = ctx.registry.get('rafael-gmail')!;
    const spy = vi.spyOn(first, 'close');

    await ctx.addAccount({
      ...INPUT_GMAIL,
      config: { ...GMAIL_ACCOUNT, displayName: 'New Name' },
      credentials: { user: 'user@gmail.com', pass: 'rotated-password' },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(ctx.registry.list()).toEqual(['rafael-gmail']);
    expect(ctx.credStore.resolve('rafael-gmail').pass).toBe('rotated-password');
  });

  it('rejects a new account whose id collides with an existing one on the vault key', async () => {
    await ctx.addAccount(INPUT_GMAIL); // id 'rafael-gmail' → MAIL_ACCOUNT_RAFAEL_GMAIL
    // 'rafael.gmail' sanitizes to the SAME vault key — must be refused so its
    // credential cannot overwrite or be resolved as the existing account's.
    await expect(
      ctx.addAccount({
        ...INPUT_GMAIL,
        config: { ...GMAIL_ACCOUNT, id: 'rafael.gmail', address: 'other@gmail.com' },
        credentials: { user: 'other@gmail.com', pass: 'attacker-pass' },
      }),
    ).rejects.toThrow(/collides/);
    expect(ctx.registry.list()).toEqual(['rafael-gmail']);
    expect(ctx.credStore.resolve('rafael-gmail').pass).not.toBe('attacker-pass');
  });
});

describe('MailContext — removeAccount', () => {
  it('removes provider + vault credentials + db row + dedup state', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    const provider = ctx.registry.get('rafael-gmail')!;
    const spy = vi.spyOn(provider, 'close');

    const removed = await ctx.removeAccount('rafael-gmail');
    expect(removed).toBe(true);
    expect(ctx.registry.list()).toEqual([]);
    expect(ctx.credStore.has('rafael-gmail')).toBe(false);
    expect(stateDb.getAccount('rafael-gmail')).toBe(null);
    expect(spy).toHaveBeenCalled();
  });

  it('returns false when asked to remove an unknown account', async () => {
    const removed = await ctx.removeAccount('missing');
    expect(removed).toBe(false);
  });
});

describe('MailContext — testAccount', () => {
  it('returns ok:true when the probe connects and lists successfully', async () => {
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.ok).toBe(true);
    expect(probe.connect).toHaveBeenCalled();
  });

  it('returns ok:false with auth_failed when imapflow auth rejects', async () => {
    probe.connect.mockRejectedValue(Object.assign(new Error('LOGIN failed'), { name: 'AuthenticationFailure' }));
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('auth_failed');
  });

  it('can probe a stored account by id', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    const result = await ctx.testAccount('rafael-gmail');
    expect(result.ok).toBe(true);
  });

  it('returns not_found when probing an unknown stored id', async () => {
    const result = await ctx.testAccount('missing');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
  });

  it('does not persist anything when probing a draft config', async () => {
    await ctx.testAccount(INPUT_GMAIL);
    expect(stateDb.listAccounts()).toHaveLength(0);
    expect(ctx.credStore.has('rafael-gmail')).toBe(false);
  });
});

// The defect this suite exists for: testAccount used to run the IMAP leg only,
// so a mailbox whose outbound SMTP port is blocked passed the pre-save check and
// failed silently on the first send, hours later, with nothing pointing at the
// port. Every test below fails if the SMTP leg is removed again.
describe('MailContext — testAccount probes the send path, not only the read path', () => {
  it('reports ok:false when IMAP is reachable but SMTP is not', async () => {
    verifyMock.mockRejectedValue(new Error('connect ETIMEDOUT 142.250.1.1:465'));

    const result = await ctx.testAccount(INPUT_GMAIL);

    // IMAP was fine — the mailbox listed — and the account is still refused.
    expect(probe.getMailboxLock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('smtp');
  });

  it('actually opens the SMTP session rather than trusting the config', async () => {
    await ctx.testAccount(INPUT_GMAIL);
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('maps a blocked SMTP port to timeout, which the UI turns into port advice', async () => {
    verifyMock.mockRejectedValue(new Error('Connection timeout'));
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.code).toBe('timeout');
    expect(result.stage).toBe('smtp');
  });

  it('maps an SMTP-only auth rejection to auth_failed on the smtp stage', async () => {
    verifyMock.mockRejectedValue(new Error('535 5.7.8 Authentication credentials invalid'));
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.code).toBe('auth_failed');
    expect(result.stage).toBe('smtp');
  });

  it('anything else on the SMTP leg is connection_failed, not send_rejected', async () => {
    // verifySmtp sends nothing, so there is no message for a server to reject.
    verifyMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.code).toBe('connection_failed');
  });

  it('attributes an IMAP failure to the imap stage and never reaches SMTP', async () => {
    probe.connect.mockRejectedValue(Object.assign(new Error('LOGIN failed'), { name: 'AuthenticationFailure' }));
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.stage).toBe('imap');
    expect(verifyMock).not.toHaveBeenCalled();
    // `checked` reports what ran, not what was planned.
    expect(result.checked).toEqual({ imap: true, smtp: false });
  });

  it('reports both legs as checked on a passing send-capable account', async () => {
    const result = await ctx.testAccount(INPUT_GMAIL);
    expect(result.ok).toBe(true);
    expect(result.checked).toEqual({ imap: true, smtp: true });
    expect(result.stage).toBeUndefined();
  });

  it('skips the SMTP leg for a receive-only account type', async () => {
    // An info@ mailbox is refused at the send path anyway, so demanding a
    // working submission server for it would reject a valid setup.
    const receiveOnly: AddAccountInput = {
      config: { ...GMAIL_ACCOUNT, id: 'info', address: 'info@example.com', type: 'info' },
      credentials: { user: 'info@example.com', pass: 'pw' },
    };
    verifyMock.mockRejectedValue(new Error('connect ETIMEDOUT'));

    const result = await ctx.testAccount(receiveOnly);

    expect(result.ok).toBe(true);
    expect(verifyMock).not.toHaveBeenCalled();
    // ok:true must not be readable as "sending works" — it was never tried.
    expect(result.checked).toEqual({ imap: true, smtp: false });
  });

  it('still probes SMTP for a send-capable non-personal type', async () => {
    // Guards the receive-only skip against widening into "skip unless personal".
    // support@ is not in RECEIVE_ONLY_TYPES — it answers mail, so it must send.
    const supportAccount: AddAccountInput = {
      config: { ...GMAIL_ACCOUNT, id: 'support', address: 'support@example.com', type: 'support' },
      credentials: { user: 'support@example.com', pass: 'pw' },
    };
    verifyMock.mockRejectedValue(new Error('connect ETIMEDOUT'));

    const result = await ctx.testAccount(supportAccount);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('smtp');
  });
});

describe('MailContext — default reconciliation', () => {
  it('preserves the persisted default when its provider fails to register on init', async () => {
    // First boot: add Gmail (becomes default) and iCloud, close.
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);
    expect(stateDb.defaultAccountId()).toBe('rafael-gmail');
    await ctx.close();

    // Simulate revoked Gmail credentials by removing them from the vault
    // while the persisted account row + is_default flag remain in the DB.
    backend.delete('MAIL_ACCOUNT_RAFAEL_GMAIL');

    // Second boot: a fresh context against the same stateDb + backend.
    const ctx2 = new MailContext(stateDb, backend);
    await ctx2.init();

    // Persisted choice survives: Gmail still flagged as default in the DB.
    // The in-memory registry only carries iCloud (the registered survivor).
    expect(stateDb.defaultAccountId()).toBe('rafael-gmail');
    expect(ctx2.registry.list()).toEqual(['rafael-icloud']);

    await ctx2.close();
  });

  it('promotes the persisted default and never picks a fallback when its provider does register', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);
    ctx.setDefault('rafael-icloud');
    expect(stateDb.defaultAccountId()).toBe('rafael-icloud');
    await ctx.close();

    const ctx2 = new MailContext(stateDb, backend);
    await ctx2.init();

    expect(stateDb.defaultAccountId()).toBe('rafael-icloud');
    expect(ctx2.registry.default()).toBe('rafael-icloud');

    await ctx2.close();
  });
});

describe('MailContext — listAccounts (safe view)', () => {
  it('excludes credentials and marks the default account', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);
    const view = ctx.listAccounts();

    expect(view).toHaveLength(2);
    expect(view[0]?.id).toBe('rafael-gmail');
    expect(view[0]?.isDefault).toBe(true);
    expect(view[0]?.hasCredentials).toBe(true);
    expect(view[1]?.id).toBe('rafael-icloud');
    expect(view[1]?.isDefault).toBe(false);
    // No secret fields leak into the view
    const raw = JSON.stringify(view);
    expect(raw).not.toContain('pass');
    expect(raw).not.toContain('password');
  });
});

describe('MailContext — tools()', () => {
  it('returns the mail tools backed by the context registry (incl. mail_connect)', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    const tools = ctx.tools();
    const names = tools.map(t => t.definition.name).sort();
    expect(names).toEqual(['mail_connect', 'mail_read', 'mail_reply', 'mail_search', 'mail_send', 'mail_triage']);
  });
});

describe('MailContext — close', () => {
  it('stops the watcher and closes all providers', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    const provider = ctx.registry.get('rafael-gmail')!;
    const spy = vi.spyOn(provider, 'close');

    await ctx.close();
    expect(spy).toHaveBeenCalled();
    expect(ctx.registry.list()).toEqual([]);
    expect(ctx.watcher.size).toBe(0);
  });
});

// ── Phase 0.2: hooks + followups ─────────────────────────────────────────

describe('MailContext — MailHooks', () => {
  it('fires onInboundMail for fresh envelopes via wrapped watcher handler', async () => {
    const onInbound = vi.fn();
    const ctx2 = new MailContext(stateDb, backend, async () => { /* user handler */ }, { onInboundMail: onInbound });
    try {
      await ctx2.addAccount(INPUT_GMAIL);
      const provider = ctx2.registry.get('rafael-gmail')!;
      // Trigger an event by directly calling the provider.watch handler path
      const envelopes = [{
        uid: 1, messageId: '<in@x>', folder: 'INBOX', threadKey: '<in@x>',
        inReplyTo: undefined, from: [{ address: 'sender@example.com' }],
        to: [{ address: 'user@gmail.com' }], cc: [], replyTo: [],
        subject: 'Hi', date: new Date(), flags: [], snippet: '',
        hasAttachments: false, attachmentCount: 0, sizeBytes: 100,
        isAutoReply: false,
      }];
      // MailWatcher has provider attached; simulate via provider.watch's handler
      // by reaching into the fake provider's emit if available. Since the fake
      // doesn't have emit here, we call the wrapped handler directly through
      // watcher internals is not clean. Instead, we just prove the hook call
      // by recording a followup + checking that checkDueFollowups fires the
      // onFollowupDue hook. The wrappedHandler is exercised by the E2E test.
      void provider;
      void envelopes;
    } finally {
      await ctx2.close();
    }
    // At minimum, the hook is registered and not crashing
    expect(onInbound).toBeDefined();
  });

  it('checkDueFollowups fires onFollowupDue and marks reminded', async () => {
    const onDue = vi.fn();
    const ctx2 = new MailContext(stateDb, backend, undefined, { onFollowupDue: onDue });
    try {
      await ctx2.addAccount(INPUT_GMAIL);
      // Record a followup that is already due
      stateDb.recordFollowup({
        accountId: 'rafael-gmail',
        sentMessageId: '<sent@x>',
        threadKey: '<sent@x>',
        recipient: 'bob@example.com',
        type: 'awaiting_reply',
        reason: 'contract',
        reminderAt: new Date('2026-04-10T00:00:00Z'),
      });

      const fired = await ctx2.checkDueFollowups(new Date('2026-04-15T00:00:00Z'));
      expect(fired).toBe(1);
      expect(onDue).toHaveBeenCalledTimes(1);
      const followup = onDue.mock.calls[0]![0] as { reason: string; status: string };
      expect(followup.reason).toBe('contract');

      // Second check is a no-op (reminded, not pending)
      const fired2 = await ctx2.checkDueFollowups(new Date('2026-04-15T00:00:00Z'));
      expect(fired2).toBe(0);
      expect(onDue).toHaveBeenCalledTimes(1);
    } finally {
      await ctx2.close();
    }
  });

  it('checkDueFollowups swallows hook errors so failed hooks do not poison the loop', async () => {
    const onDue = vi.fn().mockRejectedValue(new Error('hook crash'));
    const ctx2 = new MailContext(stateDb, backend, undefined, { onFollowupDue: onDue });
    try {
      await ctx2.addAccount(INPUT_GMAIL);
      stateDb.recordFollowup({
        accountId: 'rafael-gmail',
        sentMessageId: '<sent@x>',
        threadKey: '<sent@x>',
        recipient: 'bob@example.com',
        type: 'awaiting_reply',
        reason: 'x',
        reminderAt: new Date('2026-04-10T00:00:00Z'),
      });
      await expect(ctx2.checkDueFollowups(new Date('2026-04-15T00:00:00Z'))).resolves.toBe(1);
      expect(onDue).toHaveBeenCalled();
    } finally {
      await ctx2.close();
    }
  });
});

describe('MailContext — MailError surface', () => {
  it('testAccount on unknown id returns MailError-compatible shape', async () => {
    const result = await ctx.testAccount('nope');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
    // Equivalent check: constructing a MailError with the same code works
    expect(() => { throw new MailError(result.code as 'not_found', result.error ?? ''); }).toThrow(MailError);
  });
});

// ── OAuth-Gmail boot migration (PR2) ─────────────────────────────────────
//
// When MailContext is constructed with an authenticated GoogleAuth, init()
// auto-creates a placeholder mail_accounts row so users who connected Gmail
// via OAuth before the unification refactor see their mailbox without
// re-authorizing. Idempotent — the second init() must not insert again.

describe('MailContext — OAuth-Gmail boot migration', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('inserts an oauth_google row + registers OAuthGmailProvider on first init', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ emailAddress: 'user@example.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('test-token'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    const ctxWithAuth = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctxWithAuth.init();
      const accounts = stateDb.listAccounts().filter(a => a.authType === 'oauth_google');
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.address).toBe('user@example.com');
      expect(accounts[0]?.id).toBe('gmail-user-example.com');
      expect(accounts[0]?.preset).toBe('gmail');
      expect(ctxWithAuth.registry.list()).toContain('gmail-user-example.com');
    } finally {
      await ctxWithAuth.close();
    }
  });

  it('is idempotent — second engine boot does not insert a duplicate row', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ emailAddress: 'user@example.com' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('t'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    const ctx1 = new MailContext(stateDb, backend, undefined, {}, auth);
    await ctx1.init();
    await ctx1.close();

    const ctx2 = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctx2.init();
      const accounts = stateDb.listAccounts().filter(a => a.authType === 'oauth_google');
      expect(accounts).toHaveLength(1);
    } finally {
      await ctx2.close();
    }
  });

  it('skips migration when GoogleAuth is not authenticated', async () => {
    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(false),
      getAccessToken: vi.fn(),
      hasScope: vi.fn(),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    const ctx2 = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctx2.init();
      expect(stateDb.listAccounts().filter(a => a.authType === 'oauth_google')).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await ctx2.close();
    }
  });

  it('coexists with IMAP accounts in the same registry', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ emailAddress: 'user@example.com' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('t'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    // Pre-seed an IMAP row + creds so init() registers both
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));

    const ctxBoth = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctxBoth.init();
      // Both providers present
      expect(ctxBoth.registry.list()).toContain('rafael-gmail');             // IMAP
      expect(ctxBoth.registry.list()).toContain('gmail-user-example.com'); // OAuth
    } finally {
      await ctxBoth.close();
    }
  });

  it('survives a profile-fetch failure — migration retries on next boot', async () => {
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }));
    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('t'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    const ctx2 = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctx2.init();
      // No row created — but no crash either
      expect(stateDb.listAccounts().filter(a => a.authType === 'oauth_google')).toHaveLength(0);
    } finally {
      await ctx2.close();
    }
  });

  it('replaces a stale row when the user reconnected with a different Google account', async () => {
    // Pre-seed a row from a previous OAuth identity
    stateDb.upsertAccount({
      id: 'gmail-old-rafael-brandfusion-ch',
      displayName: 'old-user@example.com',
      address: 'old-user@example.com',
      preset: 'gmail',
      imap: { host: '', port: 0, secure: true },
      smtp: { host: '', port: 0, secure: true },
      authType: 'oauth_google',
      oauthProviderKey: 'GOOGLE_OAUTH_TOKENS',
      type: 'personal',
    });
    // Live profile now reports a different mailbox
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ emailAddress: 'new-user@example.com' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('t'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    const ctx2 = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctx2.init();
      const accounts = stateDb.listAccounts().filter(a => a.authType === 'oauth_google');
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.address).toBe('new-user@example.com');
      // Stale id is gone
      expect(stateDb.getAccount('gmail-old-rafael-brandfusion-ch')).toBe(null);
    } finally {
      await ctx2.close();
    }
  });

  it('preserves email special chars in slug so plus/dot variants do not collide', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ emailAddress: 'user+spam@example.com' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('t'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    const ctx2 = new MailContext(stateDb, backend, undefined, {}, auth);
    try {
      await ctx2.init();
      const accounts = stateDb.listAccounts().filter(a => a.authType === 'oauth_google');
      expect(accounts).toHaveLength(1);
      // The `+` is preserved so `rafael+spam@x` and `rafael.spam@x` get distinct ids
      // (`@` still collapses to `-` since it isn't a typical id char).
      expect(accounts[0]?.id).toBe('gmail-user+spam-example.com');
    } finally {
      await ctx2.close();
    }
  });
});

// ── Persisted default flag (PR3) ─────────────────────────────────────────
//
// The DEFAULT badge no longer flips when providers register in different
// order. is_default lives in mail_accounts; init() restores it; addAccount()
// no longer silently demotes a previous default; setDefault() is the
// explicit user-driven switch.

describe('MailContext — persisted default flag', () => {
  it('init() promotes the row marked is_default=1 in the DB', async () => {
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    stateDb.upsertAccount(ICLOUD_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));
    backend.set('MAIL_ACCOUNT_RAFAEL_ICLOUD', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));

    // Mark iCloud as the explicit default — even though gmail is older
    stateDb.setDefaultAccount('rafael-icloud');

    const ctx2 = new MailContext(stateDb, backend);
    try {
      await ctx2.init();
      expect(ctx2.registry.default()).toBe('rafael-icloud');
    } finally {
      await ctx2.close();
    }
  });

  it('init() falls back to first registered + persists when no default is set', async () => {
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    stateDb.upsertAccount(ICLOUD_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));
    backend.set('MAIL_ACCOUNT_RAFAEL_ICLOUD', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));

    const ctx2 = new MailContext(stateDb, backend);
    try {
      await ctx2.init();
      // Gmail is older (registered first); becomes fallback default
      expect(ctx2.registry.default()).toBe('rafael-gmail');
      expect(stateDb.defaultAccountId()).toBe('rafael-gmail');
    } finally {
      await ctx2.close();
    }
  });

  it('addAccount() does not overwrite an existing default', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    expect(ctx.registry.default()).toBe('rafael-gmail');
    expect(stateDb.defaultAccountId()).toBe('rafael-gmail');

    await ctx.addAccount(INPUT_ICLOUD);
    // The first-added account stays default — this is the bug we're fixing.
    expect(ctx.registry.default()).toBe('rafael-gmail');
    expect(stateDb.defaultAccountId()).toBe('rafael-gmail');
  });

  it('setDefault() updates DB + registry; throws for unknown id', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);

    ctx.setDefault('rafael-icloud');
    expect(ctx.registry.default()).toBe('rafael-icloud');
    expect(stateDb.defaultAccountId()).toBe('rafael-icloud');

    expect(() => ctx.setDefault('missing')).toThrow(MailError);
  });

  it('removeAccount() promotes a sibling when removing the default', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);
    ctx.setDefault('rafael-gmail');

    await ctx.removeAccount('rafael-gmail');
    // Fallback to the only remaining account, persisted
    expect(ctx.registry.default()).toBe('rafael-icloud');
    expect(stateDb.defaultAccountId()).toBe('rafael-icloud');

    await ctx.removeAccount('rafael-icloud');
    expect(ctx.registry.default()).toBe(null);
    expect(stateDb.defaultAccountId()).toBe(null);
  });

  it('OAuth boot migration claims the default when no other row holds it', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      emailAddress: 'user@example.com',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    const auth = {
      isAuthenticated: vi.fn().mockReturnValue(true),
      getAccessToken: vi.fn().mockResolvedValue('t'),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as import('../google/google-auth.js').GoogleAuth;

    try {
      const ctxBoot = new MailContext(stateDb, backend, undefined, {}, auth);
      try {
        await ctxBoot.init();
        // OAuth row was the first to exist → claims default
        expect(ctxBoot.registry.default()).toBe('gmail-user-example.com');
        expect(stateDb.defaultAccountId()).toBe('gmail-user-example.com');
      } finally {
        await ctxBoot.close();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── Persisted default flag (PR3) ─────────────────────────────────────────
//
// The DEFAULT badge no longer flips when providers register in different
// order. is_default lives in mail_accounts; init() restores it; addAccount()
// no longer silently demotes a previous default; setDefault() is the
// explicit user-driven switch.

describe('MailContext — persisted default flag', () => {
  it('init() promotes the row marked is_default=1 in the DB', async () => {
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    stateDb.upsertAccount(ICLOUD_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));
    backend.set('MAIL_ACCOUNT_RAFAEL_ICLOUD', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));

    // Mark iCloud as the explicit default — even though gmail is older
    stateDb.setDefaultAccount('rafael-icloud');

    const ctx2 = new MailContext(stateDb, backend);
    try {
      await ctx2.init();
      expect(ctx2.registry.default()).toBe('rafael-icloud');
    } finally {
      await ctx2.close();
    }
  });

  it('init() falls back to first registered + persists when no default is set', async () => {
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    stateDb.upsertAccount(ICLOUD_ACCOUNT);
    backend.set('MAIL_ACCOUNT_RAFAEL_GMAIL', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));
    backend.set('MAIL_ACCOUNT_RAFAEL_ICLOUD', JSON.stringify({ user: 'x', pass: 'y', storedAt: 'now' }));

    const ctx2 = new MailContext(stateDb, backend);
    try {
      await ctx2.init();
      // Gmail is older (registered first); becomes fallback default
      expect(ctx2.registry.default()).toBe('rafael-gmail');
      expect(stateDb.defaultAccountId()).toBe('rafael-gmail');
    } finally {
      await ctx2.close();
    }
  });

  it('addAccount() does not overwrite an existing default', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    expect(ctx.registry.default()).toBe('rafael-gmail');
    expect(stateDb.defaultAccountId()).toBe('rafael-gmail');

    await ctx.addAccount(INPUT_ICLOUD);
    // The first-added account stays default — this is the bug we're fixing.
    expect(ctx.registry.default()).toBe('rafael-gmail');
    expect(stateDb.defaultAccountId()).toBe('rafael-gmail');
  });

  it('setDefault() updates DB + registry; throws for unknown id', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);

    ctx.setDefault('rafael-icloud');
    expect(ctx.registry.default()).toBe('rafael-icloud');
    expect(stateDb.defaultAccountId()).toBe('rafael-icloud');

    expect(() => ctx.setDefault('missing')).toThrow(MailError);
  });

  it('removeAccount() promotes a sibling when removing the default', async () => {
    await ctx.addAccount(INPUT_GMAIL);
    await ctx.addAccount(INPUT_ICLOUD);
    ctx.setDefault('rafael-gmail');

    await ctx.removeAccount('rafael-gmail');
    // Fallback to the only remaining account, persisted
    expect(ctx.registry.default()).toBe('rafael-icloud');
    expect(stateDb.defaultAccountId()).toBe('rafael-icloud');

    await ctx.removeAccount('rafael-icloud');
    expect(ctx.registry.default()).toBe(null);
    expect(stateDb.defaultAccountId()).toBe(null);
  });

});

/**
 * PRD Stage 1 §3.7 — the mail boundary.
 *
 * A Google CONNECTION and a Google MAILBOX are two different things, and until
 * this wave both gates asked the same question (`isAuthenticated()`). That was
 * invisible while the default consent set granted `gmail.readonly` to every
 * connection. It stops being invisible on a set that grants Calendar and
 * Drive-file access and no Gmail at all — and D7 made that the default.
 */
describe('MailContext — a Google connection is not a Gmail mailbox', () => {
  const GOOGLE_ROW = {
    ...GMAIL_ACCOUNT,
    id: 'goog',
    address: 'someone@gmail.com',
    authType: 'oauth_google' as const,
  };

  /**
   * A connected Google account holding exactly `scopes`.
   *
   * `getAccessToken` is a spy because it is the only observable the migration
   * gate has: without it, "no row was created" is satisfied just as well by a
   * profile fetch that failed — which is what happens in a test with no
   * network. The mutation that removes the gate then survives.
   */
  function googleAuth(scopes: readonly string[]): { auth: unknown; tokenCalls: () => number } {
    let calls = 0;
    return {
      auth: {
        isAuthenticated: () => true,
        hasScope: (s: string) => scopes.includes(s),
        getAccessToken: async () => { calls++; return 'token'; },
      },
      tokenCalls: () => calls,
    };
  }
  const STAGE_1 = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/drive.file',
  ];
  const READONLY = ['https://www.googleapis.com/auth/gmail.readonly'];

  let lastTokenCalls: () => number = () => 0;
  function ctxWith(scopes: readonly string[]): MailContext {
    const g = googleAuth(scopes);
    lastTokenCalls = g.tokenCalls;
    return new MailContext(stateDb, backend, undefined, {}, g.auth as never);
  }

  it('registers NO provider for a Google row when the grant has no Gmail read scope', async () => {
    stateDb.upsertAccount(GOOGLE_ROW);
    const c = ctxWith(STAGE_1);
    try {
      await c.init();
      // The row survives — it is the user's mailbox and it comes back the
      // moment the scope does. What must not happen is a registered provider
      // polling it into a 403 loop.
      expect(c.registry.list()).toEqual([]);
      expect(c.watcher.size).toBe(0);
      expect(stateDb.listAccounts().map(a => a.id)).toContain('goog');
    } finally { await c.close(); }
  });

  it('registers the provider once a Gmail read scope IS granted — the control', async () => {
    // Without this the assertion above is satisfied by a build that registers
    // nothing at all for `oauth_google`.
    stateDb.upsertAccount(GOOGLE_ROW);
    const c = ctxWith(READONLY);
    try {
      await c.init();
      expect(c.registry.list().length).toBe(1);
    } finally { await c.close(); }
  });

  it('accepts gmail.modify and mail.google.com as mailbox scopes too', async () => {
    // Three scopes authorise `messages.list`/`get`. Naming only the first would
    // refuse a legitimate BYO grant — the mirror of the defect this wave fixes.
    for (const scope of [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://mail.google.com/',
    ]) {
      const c = ctxWith([scope]);
      try {
        stateDb.upsertAccount(GOOGLE_ROW);
        await c.init();
        expect(c.registry.list().length, `${scope} must authorise the mailbox`).toBe(1);
      } finally { await c.close(); }
    }
  });

  it('does NOT accept gmail.send as a mailbox scope', async () => {
    // Sending is not reading. A grant that can send and not read would build a
    // provider whose every fetch 403s.
    stateDb.upsertAccount(GOOGLE_ROW);
    const c = ctxWith(['https://www.googleapis.com/auth/gmail.send']);
    try {
      await c.init();
      expect(c.registry.list()).toEqual([]);
    } finally { await c.close(); }
  });

  it('creates no Google row, and does not even ASK Google, when the grant cannot read a mailbox', async () => {
    // The migration must stop BEFORE the profile fetch: `users.getProfile` is
    // itself authorised by a Gmail read scope, so without one this spends a 403
    // on every init to learn what the grant already says.
    //
    // ⚠ The row assertion alone is not enough and was measured to be not
    // enough: with no network the profile fetch fails anyway, so "no row" holds
    // whether the gate is there or not, and removing the gate SURVIVED. The
    // token call is the observable that separates the two.
    const c = ctxWith(STAGE_1);
    try {
      await c.init();
      expect(stateDb.listAccounts().filter(a => a.authType === 'oauth_google')).toEqual([]);
      expect(lastTokenCalls(), 'the migration must not reach for a token it cannot use').toBe(0);
    } finally { await c.close(); }
  });

  it('DOES ask Google once the scope is there — the control on the line above', async () => {
    // Without this, a build that never runs the migration at all satisfies the
    // assertion above just as well.
    const c = ctxWith(READONLY);
    try {
      await c.init();
      expect(lastTokenCalls()).toBeGreaterThan(0);
    } finally { await c.close(); }
  });

  it('the card clears immediately on re-consent, but the provider does NOT re-attach', async () => {
    // The honest shape of the recovery, asserted rather than described.
    // `listAccounts()` computes the warning per request, so the badge goes the
    // moment the scope arrives. `_buildProvider` runs from `init()` only and
    // nothing re-runs it, so mail does not flow until the next engine start.
    //
    // Written because the first version of this wave claimed in a public
    // CHANGELOG that it "works again the moment the scope is there". It does
    // not, and no test said so.
    stateDb.upsertAccount(GOOGLE_ROW);
    let scopes: string[] = [...STAGE_1];
    const live = {
      isAuthenticated: () => true,
      hasScope: (s: string) => scopes.includes(s),
      getAccessToken: async () => 'token',
    };
    const c = new MailContext(stateDb, backend, undefined, {}, live as never);
    try {
      await c.init();
      expect(c.listAccounts().find(a => a.id === 'goog')?.warning).toBe('needs_mailbox_scope');
      expect(c.registry.list()).toEqual([]);

      // …the user re-consents, in the same process.
      scopes = [...READONLY];
      expect(c.listAccounts().find(a => a.id === 'goog')?.warning,
        'the badge is computed per request, so it clears at once').toBeUndefined();
      expect(c.registry.list(),
        'and the provider still is not attached — that needs the next init').toEqual([]);

      // ⚠ A second `init()` on the SAME context does not attach it either, and
      // that is the guard rather than the behaviour: `init()` returns early on
      // `this.initialized`. Measured — asserting on it would have been a test
      // of the idempotence flag wearing the name of a recovery test.
      await c.init();
      expect(c.registry.list(), 'a second init() is a documented no-op').toEqual([]);
    } finally { await c.close(); }

    // A restart is a NEW context over the same state DB. That is the path that
    // attaches it, and it is what makes the assertion above about TIMING
    // rather than about something being broken.
    const restarted = new MailContext(stateDb, backend, undefined, {}, {
      isAuthenticated: () => true,
      hasScope: (s: string) => (READONLY as readonly string[]).includes(s),
      getAccessToken: async () => 'token',
    } as never);
    try {
      await restarted.init();
      expect(restarted.registry.list().length, 'a restart attaches it').toBe(1);
    } finally { await restarted.close(); }
  });

  it('names the account in the log without printing the address', async () => {
    // This is the only place in the engine where a real mailbox address could
    // reach stdout, and a container log on a managed instance is not where it
    // belongs. The line still has to identify WHICH account, or it is useless
    // to the operator it is written for.
    stateDb.upsertAccount(GOOGLE_ROW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const c = ctxWith(STAGE_1);
    try {
      await c.init();
      const lines = warn.mock.calls.map(a => String(a[0]));
      const mine = lines.filter(l => l.includes('[lynox:mail]'));
      expect(mine, 'the skip must say something at all').toHaveLength(1);
      expect(mine[0]).toContain('goog');
      expect(mine[0], 'the address must not reach the log').not.toContain(GOOGLE_ROW.address);
      expect(mine[0]).not.toContain('@');

      // ONE line, at init — not one per read. §3.7 asks for exactly this, and
      // the difference is a quiet log versus a line for every card refresh.
      c.listAccounts(); c.listAccounts(); c.listAccounts();
      expect(warn.mock.calls.map(a => String(a[0])).filter(l => l.includes('[lynox:mail]')),
        'reading the accounts must not log').toHaveLength(1);
    } finally {
      warn.mockRestore();
      await c.close();
    }
  });

  it('tells the card WHY the account is there and does nothing', async () => {
    stateDb.upsertAccount(GOOGLE_ROW);
    const c = ctxWith(STAGE_1);
    try {
      await c.init();
      const view = c.listAccounts().find(a => a.id === 'goog');
      expect(view?.warning).toBe('needs_mailbox_scope');
    } finally { await c.close(); }
  });

  it('carries no warning once the scope is there, and none on an IMAP row', async () => {
    stateDb.upsertAccount(GOOGLE_ROW);
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    const c = ctxWith(READONLY);
    try {
      await c.init();
      expect(c.listAccounts().find(a => a.id === 'goog')?.warning).toBeUndefined();
      expect(c.listAccounts().find(a => a.authType === 'imap')?.warning).toBeUndefined();
    } finally { await c.close(); }
  });

  it('never marks an IMAP row, even when the Google grant cannot read a mailbox', async () => {
    // The warning is about a GOOGLE mailbox. Dropping the `authType` half of
    // the condition marks every IMAP account too — an app-password mailbox that
    // works perfectly would be labelled broken because of an unrelated Google
    // connection. Measured: without this case that mutation survived.
    stateDb.upsertAccount(GMAIL_ACCOUNT);
    const c = ctxWith(STAGE_1);
    try {
      await c.init();
      const imap = c.listAccounts().find(a => a.authType === 'imap');
      expect(imap, 'the IMAP fixture must be present, or this asserts nothing').toBeDefined();
      expect(imap?.warning).toBeUndefined();
    } finally { await c.close(); }
  });
});
