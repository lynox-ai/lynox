import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { buildInboxRunner, scrubErrorMessage, SENSITIVE_WITHHELD_REASON_DE, withheldSensitive, type InboxQueuePayload } from './runner.js';
import { InboxCostBudget } from './cost-budget.js';
import type { LLMCaller } from './classifier/index.js';
import type { MailAccountConfig } from '../mail/provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

let mail: MailStateDb;
let inbox: InboxStateDb;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
});

afterEach(() => {
  mail.close();
});

function payload(overrides: Partial<InboxQueuePayload> = {}): InboxQueuePayload {
  return {
    accountId: 'acct-1',
    threadKey: 'imap:t1',
    classifierInput: {
      accountAddress: 'me@acme.example',
      accountDisplayName: 'Me',
      subject: 'Termin?',
      fromAddress: 'mustermann@example.com',
      fromDisplayName: 'Max',
      body: 'Hi Me, hast du Zeit?',
    },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, iters = 50): Promise<void> {
  for (let i = 0; i < iters; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

describe('buildInboxRunner — happy path', () => {
  it('classifies, persists an inbox_item, and writes an audit entry', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.92,
        one_line_why_de: 'Kunde fragt nach Termin',
      }),
    );
    const queue = buildInboxRunner({ state: inbox, llm });
    queue.enqueue(payload());
    await queue.drain();

    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      accountId: 'acct-1',
      threadKey: 'imap:t1',
      bucket: 'requires_user',
      confidence: 0.92,
      reasonDe: 'Kunde fragt nach Termin',
    });

    const audit = inbox.listAuditForItem(items[0]!.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'classified',
      actor: 'classifier',
    });
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson).toMatchObject({
      bucket: 'requires_user',
      confidence: 0.92,
      fail_reason: null,
    });

    // Snippet is cached at classify time so the draft generator never
    // pays a second provider round-trip — Phase-2 design choice.
    const cached = inbox.getItemBody(items[0]!.id);
    expect(cached?.bodyMd).toBe('Hi Me, hast du Zeit?');
    expect(cached?.source).toBe('email');
  });

  it('skips the body cache when the classifier prompt had no body (sensitive-skip path)', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const queue = buildInboxRunner({ state: inbox, llm });
    queue.enqueue(payload({ classifierInput: { ...payload().classifierInput, body: '' } }));
    await queue.drain();
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(inbox.getItemBody(items[0]!.id)).toBeNull();
  });

  it('caches the masked body verbatim when sensitive-mode = mask substituted the input', async () => {
    // The watcher hook is the one that does the masking; from the
    // runner's view the body in classifierInput is already what should
    // be persisted. Pin the contract that runner.onSuccess does NOT
    // re-sanitise — it stores whatever the prompt builder saw.
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const queue = buildInboxRunner({ state: inbox, llm });
    const masked = 'Hi me, the IBAN is [REDACTED] and the OTP is [REDACTED].';
    queue.enqueue(payload({ classifierInput: { ...payload().classifierInput, body: masked } }));
    await queue.drain();
    const items = inbox.listItems();
    expect(inbox.getItemBody(items[0]!.id)?.bodyMd).toBe(masked);
  });

  it('honors classifierVersionOverride for the persisted version stamp', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      classifierVersionOverride: 'haiku-canary-1',
    });
    queue.enqueue(payload());
    await queue.drain();
    expect(inbox.listItems()[0]?.classifierVersion).toBe('haiku-canary-1');
  });
});

describe('buildInboxRunner — push notifier wire', () => {
  it('fires the notifier on a NEW requires_user classification', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const notifyNewItem = vi.fn(async () => true);
    const queue = buildInboxRunner({ state: inbox, llm, notifier: { notifyNewItem } });
    queue.enqueue(payload());
    await queue.drain();
    expect(notifyNewItem).toHaveBeenCalledTimes(1);
    expect(notifyNewItem.mock.calls[0]?.[0]).toMatchObject({ bucket: 'requires_user' });
  });

  it('does not fire on auto_handled or draft_ready (notifier owns the bucket gate too)', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const notifyNewItem = vi.fn(async () => true);
    const queue = buildInboxRunner({ state: inbox, llm, notifier: { notifyNewItem } });
    queue.enqueue(payload());
    await queue.drain();
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('fires on the dead-letter path (fail-closed → requires_user)', async () => {
    const llm: LLMCaller = vi.fn(async () => { throw new Error('boom'); });
    const notifyNewItem = vi.fn(async () => true);
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      policy: { retryOnce: false },
      notifier: { notifyNewItem },
    });
    queue.enqueue(payload());
    await queue.drain();
    expect(notifyNewItem).toHaveBeenCalledTimes(1);
  });
});

describe('buildInboxRunner — fail-closed dead-letter', () => {
  it('inserts a requires_user stub and audits the failure when classification fails', async () => {
    const llm: LLMCaller = vi.fn(async () => {
      throw new Error('rate_limited');
    });
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      policy: { retryOnce: false },
    });
    queue.enqueue(payload());
    await waitFor(() => inbox.listItems().length === 1);
    await queue.drain();

    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.confidence).toBe(0);
    expect(items[0]?.classifierVersion).toMatch(/^dead-letter:/);
    expect(items[0]?.reasonDe).toContain('Klassifizierer');

    const audit = inbox.listAuditForItem(items[0]!.id);
    expect(audit).toHaveLength(1);
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson['dead_letter']).toBe(true);
    expect(payloadJson['error_message']).toBe('rate_limited');
  });
});

describe('scrubErrorMessage', () => {
  it('redacts Bearer tokens (full prefix + payload)', () => {
    const out = scrubErrorMessage('401 Unauthorized: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHgifQ.sig');
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('Bearer eyJ');
    expect(out).toContain('[REDACTED:SECRET]');
  });

  it('redacts bare JWT-shaped tokens (no Bearer prefix)', () => {
    const out = scrubErrorMessage('payload: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c more');
    expect(out).not.toContain('eyJ');
    expect(out).toContain('[REDACTED:SECRET]');
  });

  it('redacts Stripe-style underscore keys', () => {
    // Runtime concat so GitHub's secret scanner does not flag this fixture.
    const out = scrubErrorMessage(`err: sk${'_'}live${'_'}abcdefghijklmnopqrstuv expired`);
    expect(out).not.toContain(`sk${'_'}live${'_'}`);
    expect(out).toContain('[REDACTED:SECRET]');
  });

  it('redacts an AWS access key', () => {
    const out = scrubErrorMessage('AccessKey=AKIAIOSFODNN7EXAMPLE expired');
    expect(out).not.toContain('AKIA');
    expect(out).toContain('[REDACTED:SECRET]');
  });

  it('redacts URL query strings (which often carry tokens)', () => {
    const out = scrubErrorMessage('Got 500 from https://api.example.com/v1?token=secret&id=42');
    expect(out).not.toContain('token=secret');
    expect(out).toContain('[REDACTED-QUERY]');
  });

  it('redacts both a Bearer token and a query string in the same message', () => {
    const out = scrubErrorMessage(
      'GET https://api.example.com/v1?token=xyz failed: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    );
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('token=xyz');
  });

  it('caps at 200 characters', () => {
    const long = 'x'.repeat(500);
    expect(scrubErrorMessage(long).length).toBe(200);
  });

  it('returns empty string on empty input', () => {
    expect(scrubErrorMessage('')).toBe('');
  });
});

describe('buildInboxRunner — budget circuit-breaker', () => {
  it('skips the LLM call and writes a budget_exceeded item once budget is exhausted', async () => {
    const llm: LLMCaller = vi.fn(async () => 'should-not-be-called');
    const budget = new InboxCostBudget({ maxBudgetUSD: 0.0001 });
    budget.recordUsage(1_000_000, 0); // $1 spend > $0.0001 cap → exceeded
    const queue = buildInboxRunner({ state: inbox, llm, budget });
    queue.enqueue(payload());
    await queue.drain();

    expect(llm).not.toHaveBeenCalled();
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.reasonDe).toContain('Tagesbudget');

    const audit = inbox.listAuditForItem(items[0]!.id);
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson['fail_reason']).toBe('budget_exceeded');
  });

  it('lets the LLM call through when the budget has headroom', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.95, one_line_why_de: 'k' }),
    );
    const budget = new InboxCostBudget({ maxBudgetUSD: 5 });
    const queue = buildInboxRunner({ state: inbox, llm, budget });
    queue.enqueue(payload());
    await queue.drain();
    expect(llm).toHaveBeenCalledTimes(1);
    expect(inbox.listItems()[0]?.bucket).toBe('auto_handled');
  });
});

describe('buildInboxRunner — managed credit gate', () => {
  it('blocks the pool-key classify + writes a budget_exceeded item when the CP gate denies', async () => {
    const llm: LLMCaller = vi.fn(async () => 'should-not-be-called');
    const meteredHost = {
      getHooks: () => [{ onBeforeRun: () => { throw new Error('AI budget for this period reached.'); } }],
      getContext: () => undefined,
    };
    const queue = buildInboxRunner({ state: inbox, llm, meteredHost });
    queue.enqueue(payload());
    await queue.drain();

    // A credit-exhausted managed tenant never reaches the pool key.
    expect(llm).not.toHaveBeenCalled();
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.reasonDe).toContain('Guthaben');
    const audit = inbox.listAuditForItem(items[0]!.id);
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson['fail_reason']).toBe('budget_exceeded');
  });

  it('lets the classify through when the CP gate allows (in-credit tenant)', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.95, one_line_why_de: 'k' }),
    );
    const onBeforeRun = vi.fn();
    const meteredHost = { getHooks: () => [{ onBeforeRun }], getContext: () => undefined };
    const queue = buildInboxRunner({ state: inbox, llm, meteredHost });
    queue.enqueue(payload());
    await queue.drain();

    expect(onBeforeRun).toHaveBeenCalledOnce();
    expect(llm).toHaveBeenCalledTimes(1);
    expect(inbox.listItems()[0]?.bucket).toBe('auto_handled');
  });
});

describe('buildInboxRunner — policy passthrough', () => {
  it('forwards maxConcurrency to the underlying queue', () => {
    const llm: LLMCaller = vi.fn(async () => '');
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      policy: { maxConcurrency: 1, maxQueueDepth: 3 },
    });
    expect(queue.enqueue(payload({ threadKey: 'a' }))).toBe(true);
    expect(queue.enqueue(payload({ threadKey: 'b' }))).toBe(true);
    expect(queue.enqueue(payload({ threadKey: 'c' }))).toBe(true);
    expect(queue.enqueue(payload({ threadKey: 'd' }))).toBe(false);
  });
});

describe('buildInboxRunner — a mail the sensitive check flagged is never filed as handled', () => {
  // Under `skip` (the default) such a mail never reaches the classifier
  // (watcher-hook.test.ts: "detects an OTP-shaped mail and skips the LLM"). Under `mask` and
  // `allow` it does, and the classifier's verdict is the one path that could file it as handled.
  const handled: LLMCaller = async () =>
    JSON.stringify({ bucket: 'auto_handled', confidence: 0.95, one_line_why_de: 'Newsletter' });

  async function run(sensitive: InboxQueuePayload['sensitive'], llm: LLMCaller = handled) {
    const notifyNewItem = vi.fn(async () => undefined);
    const queue = buildInboxRunner({ state: inbox, llm, notifier: { notifyNewItem } });
    queue.enqueue(payload(sensitive === undefined ? {} : { sensitive }));
    await queue.drain();
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    const audit = JSON.parse(inbox.listAuditForItem(items[0]!.id)[0]!.payloadJson) as Record<string, unknown>;
    return { item: items[0]!, audit, notifyNewItem };
  }

  for (const [mode, sensitive] of [
    ['mask', { categories: ['otp'], masked: true, redactionCount: 1 }],
    ['allow', { categories: ['otp'], masked: false, redactionCount: 0 }],
  ] as const) {
    it(`shows it under ${mode} when the classifier files it as handled, and the audit says why`, async () => {
      const { item, audit, notifyNewItem } = await run(sensitive);
      expect(item.bucket).toBe('requires_user');
      expect(item.reasonDe).toBe(SENSITIVE_WITHHELD_REASON_DE);
      expect(audit).toMatchObject({
        bucket: 'requires_user',
        fail_reason: 'sensitive_content',
        classifier_bucket: 'auto_handled',
        sensitive_categories: ['otp'],
        sensitive_masked: sensitive.masked,
      });
      // Shown like any mail that needs the owner: the notification goes out.
      expect(notifyNewItem).toHaveBeenCalledTimes(1);
    });
  }

  it('keeps the classifier\'s bucket for a mail without the flag (control)', async () => {
    const { item, audit, notifyNewItem } = await run(undefined);
    expect(item.bucket).toBe('auto_handled');
    expect(item.reasonDe).toBe('Newsletter');
    expect(audit).toMatchObject({ bucket: 'auto_handled', fail_reason: null });
    expect(audit).not.toHaveProperty('classifier_bucket');
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('keeps any other verdict on a flagged mail as the classifier gave it', async () => {
    const draft: LLMCaller = async () =>
      JSON.stringify({ bucket: 'draft_ready', confidence: 0.9, one_line_why_de: 'Antwort vorbereitet' });
    const { item, audit } = await run({ categories: ['iban'], masked: true, redactionCount: 1 }, draft);
    expect(item.bucket).toBe('draft_ready');
    expect(item.reasonDe).toBe('Antwort vorbereitet');
    expect(audit).toMatchObject({ fail_reason: null });
    expect(audit).not.toHaveProperty('classifier_bucket');
  });
});

describe('withheldSensitive', () => {
  const verdict = { bucket: 'auto_handled', confidence: 0.9, reasonDe: 'r', failReason: null, classifierVersion: 'v', bodyTruncated: false } as const;
  const flagged = { sensitive: { categories: ['otp'], masked: true, redactionCount: 1 } };

  it('leaves a verdict already held back with its own reason alone', () => {
    const held = { ...verdict, bucket: 'requires_user', reasonDe: 'Budget', failReason: 'budget_exceeded' } as const;
    expect(withheldSensitive(held, flagged)).toBe(held);
  });

  it('returns the very verdict when nothing changes, so the audit adds no classifier bucket', () => {
    expect(withheldSensitive(verdict, {})).toBe(verdict);
  });
});
