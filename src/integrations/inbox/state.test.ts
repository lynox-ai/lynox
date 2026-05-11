import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { DEFAULT_TENANT_ID, InboxStateDb } from './state.js';
import type { MailAccountConfig } from '../mail/provider.js';

let mail: MailStateDb;
let inbox: InboxStateDb;

const TEST_ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(TEST_ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
});

afterEach(() => {
  mail.close();
});

function insertSampleItem(overrides: Partial<Parameters<InboxStateDb['insertItem']>[0]> = {}): string {
  return inbox.insertItem({
    accountId: TEST_ACCOUNT.id,
    channel: 'email',
    threadKey: 'imap:thread-1',
    bucket: 'requires_user',
    confidence: 0.9,
    reasonDe: 'Kunde fragt nach Termin',
    classifiedAt: new Date('2026-05-10T12:00:00Z'),
    classifierVersion: 'haiku-2026-05',
    ...overrides,
  });
}

describe('InboxStateDb — items', () => {
  it('round-trips an inserted item with all default fields', () => {
    const id = insertSampleItem();
    const item = inbox.getItem(id);
    expect(item).not.toBeNull();
    expect(item).toMatchObject({
      id,
      tenantId: DEFAULT_TENANT_ID,
      accountId: 'acct-1',
      channel: 'email',
      threadKey: 'imap:thread-1',
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'Kunde fragt nach Termin',
      classifierVersion: 'haiku-2026-05',
      unsnoozeOnReply: true,
    });
    expect(item?.classifiedAt.toISOString()).toBe('2026-05-10T12:00:00.000Z');
    expect(item?.userAction).toBeUndefined();
    expect(item?.draftId).toBeUndefined();
    expect(item?.snoozeUntil).toBeUndefined();
  });

  it('finds the latest item for an (accountId, threadKey) pair', () => {
    insertSampleItem({ classifiedAt: new Date('2026-01-01') });
    const newer = insertSampleItem({ classifiedAt: new Date('2026-05-01') });
    const found = inbox.findItemByThread('acct-1', 'imap:thread-1');
    expect(found?.id).toBe(newer);
  });

  it('returns null for an unknown thread', () => {
    expect(inbox.findItemByThread('acct-1', 'never')).toBeNull();
  });

  it('collapses a duplicate insert on (account_id, thread_key) and returns the existing id', () => {
    // Simulates the watcher-hook dedup race: two parallel classify jobs
    // for the same thread both reach insertItem after each passed the
    // pre-check. The v8 UNIQUE index plus ON CONFLICT DO NOTHING make
    // the second call a no-op that still returns the canonical id.
    const first = insertSampleItem({ threadKey: 'race-1', bucket: 'requires_user' });
    const second = insertSampleItem({ threadKey: 'race-1', bucket: 'auto_handled' });
    expect(second).toBe(first);
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    // Original verdict wins; later racer cannot overwrite bucket via insert.
    expect(items[0]?.bucket).toBe('requires_user');
  });

  it('lists items newest-first and filters by bucket', () => {
    const a = insertSampleItem({ bucket: 'requires_user', classifiedAt: new Date('2026-05-01'), threadKey: 't1' });
    insertSampleItem({ bucket: 'auto_handled', classifiedAt: new Date('2026-05-02'), threadKey: 't2' });
    const c = insertSampleItem({ bucket: 'requires_user', classifiedAt: new Date('2026-05-03'), threadKey: 't3' });

    const requiresUser = inbox.listItems({ bucket: 'requires_user' });
    expect(requiresUser.map((it) => it.id)).toEqual([c, a]);

    const all = inbox.listItems();
    expect(all).toHaveLength(3);
    // Newest first
    expect(all[0]?.id).toBe(c);
  });

  it('paginates via limit + offset', () => {
    for (let i = 0; i < 5; i++) {
      insertSampleItem({ threadKey: `t${String(i)}`, classifiedAt: new Date(2_000_000_000_000 + i * 1000) });
    }
    const page1 = inbox.listItems({ limit: 2 });
    const page2 = inbox.listItems({ limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    // No overlap
    const ids = new Set([...page1, ...page2].map((it) => it.id));
    expect(ids.size).toBe(4);
  });

  it('caps oversized list limits without throwing', () => {
    insertSampleItem();
    const items = inbox.listItems({ limit: 10_000 });
    expect(items).toHaveLength(1);
  });

  it('counts items per bucket and zero-fills missing buckets', () => {
    insertSampleItem({ bucket: 'requires_user', threadKey: 'a' });
    insertSampleItem({ bucket: 'requires_user', threadKey: 'b' });
    insertSampleItem({ bucket: 'auto_handled', threadKey: 'c' });
    expect(inbox.countItemsByBucket()).toEqual({
      requires_user: 2,
      draft_ready: 0,
      auto_handled: 1,
    });
  });

  it('hasAnyItemForAccount returns false for an empty account and true after one insert', () => {
    expect(inbox.hasAnyItemForAccount(TEST_ACCOUNT.id)).toBe(false);
    insertSampleItem();
    expect(inbox.hasAnyItemForAccount(TEST_ACCOUNT.id)).toBe(true);
    expect(inbox.hasAnyItemForAccount('other-acct')).toBe(false);
  });
});

describe('InboxStateDb — user actions and snooze', () => {
  it('records a user action with timestamp and reverts on null', () => {
    const id = insertSampleItem();
    expect(inbox.updateUserAction(id, 'archived', new Date('2026-05-10T13:00:00Z'))).toBe(true);
    let item = inbox.getItem(id);
    expect(item?.userAction).toBe('archived');
    expect(item?.userActionAt?.toISOString()).toBe('2026-05-10T13:00:00.000Z');

    // UNDO path — null action clears the timestamp too
    expect(inbox.updateUserAction(id, null)).toBe(true);
    item = inbox.getItem(id);
    expect(item?.userAction).toBeUndefined();
    expect(item?.userActionAt).toBeUndefined();
  });

  it('returns false when the item id is unknown', () => {
    expect(inbox.updateUserAction('missing', 'archived')).toBe(false);
  });

  it('sets and clears snooze atomically — null clears all three fields', () => {
    const id = insertSampleItem();
    expect(inbox.setSnooze(id, new Date('2026-05-15'), 'if_no_reply', false)).toBe(true);
    let item = inbox.getItem(id);
    expect(item?.snoozeUntil?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(item?.snoozeCondition).toBe('if_no_reply');
    expect(item?.unsnoozeOnReply).toBe(false);

    // Clear — until=null wipes condition too
    expect(inbox.setSnooze(id, null, null)).toBe(true);
    item = inbox.getItem(id);
    expect(item?.snoozeUntil).toBeUndefined();
    expect(item?.snoozeCondition).toBeUndefined();
    expect(item?.unsnoozeOnReply).toBe(true); // default restored
  });

  it('attaches and detaches a draft id', () => {
    const id = insertSampleItem();
    expect(inbox.attachDraft(id, 'drf_x')).toBe(true);
    expect(inbox.getItem(id)?.draftId).toBe('drf_x');
    expect(inbox.attachDraft(id, null)).toBe(true);
    expect(inbox.getItem(id)?.draftId).toBeUndefined();
  });
});

describe('InboxStateDb — audit log', () => {
  it('appends entries and returns them in chronological order', () => {
    const itemId = insertSampleItem();
    const a = inbox.appendAudit({
      itemId,
      action: 'classified',
      actor: 'classifier',
      payloadJson: '{"bucket":"requires_user"}',
      createdAt: new Date('2026-05-10T12:00:00Z'),
    });
    const b = inbox.appendAudit({
      itemId,
      action: 'archived',
      actor: 'user',
      payloadJson: '{"prev":"requires_user"}',
      createdAt: new Date('2026-05-10T13:00:00Z'),
    });
    const entries = inbox.listAuditForItem(itemId);
    expect(entries.map((e) => e.id)).toEqual([a, b]);
    expect(entries[1]?.action).toBe('archived');
    expect(entries[1]?.payloadJson).toBe('{"prev":"requires_user"}');
  });

  it('exposes no UPDATE/DELETE method for audit entries', () => {
    // PRD requires append-only at the repository layer. Surface check: the
    // class shape itself must not advertise mutation methods. Anyone who
    // bypasses this with raw SQL has gone out of their way.
    const surface = Object.getOwnPropertyNames(InboxStateDb.prototype);
    for (const name of surface) {
      expect(name).not.toMatch(/^(update|delete|remove|clear)Audit/);
    }
  });
});

describe('InboxStateDb — drafts', () => {
  it('inserts and reads a draft', () => {
    const itemId = insertSampleItem();
    const id = inbox.insertDraft({
      itemId,
      bodyMd: 'Hi Max,\n\nDanke für die Nachricht.',
      generatedAt: new Date('2026-05-10T12:30:00Z'),
      generatorVersion: 'gen-2026-05',
    });
    const draft = inbox.getDraftById(id);
    expect(draft).toMatchObject({
      id,
      itemId,
      bodyMd: 'Hi Max,\n\nDanke für die Nachricht.',
      generatorVersion: 'gen-2026-05',
      userEditsCount: 0,
      supersededBy: undefined,
    });
  });

  it('marks the previous draft as superseded inside one transaction', () => {
    const itemId = insertSampleItem();
    const first = inbox.insertDraft({
      itemId,
      bodyMd: 'v1',
      generatedAt: new Date('2026-05-10T12:00:00Z'),
      generatorVersion: 'g1',
    });
    const second = inbox.insertDraft({
      itemId,
      bodyMd: 'v2',
      generatedAt: new Date('2026-05-10T12:05:00Z'),
      generatorVersion: 'g1',
      supersededDraftId: first,
    });
    expect(inbox.getDraftById(first)?.supersededBy).toBe(second);
    // Active draft = the new one
    expect(inbox.getActiveDraftForItem(itemId)?.id).toBe(second);
  });

  it('returns null when an item has no draft', () => {
    const itemId = insertSampleItem();
    expect(inbox.getActiveDraftForItem(itemId)).toBeNull();
  });

  it('increments edit count', () => {
    const itemId = insertSampleItem();
    const id = inbox.insertDraft({
      itemId,
      bodyMd: 'x',
      generatedAt: new Date(),
      generatorVersion: 'g',
    });
    inbox.incrementDraftEdits(id);
    inbox.incrementDraftEdits(id);
    expect(inbox.getDraftById(id)?.userEditsCount).toBe(2);
  });

  it('updateDraftBody writes the body and increments the counter atomically', () => {
    const itemId = insertSampleItem();
    const id = inbox.insertDraft({
      itemId,
      bodyMd: 'initial body',
      generatedAt: new Date('2026-05-10T12:00:00Z'),
      generatorVersion: 'g',
    });
    expect(inbox.updateDraftBody(id, 'edited body')).toBe(true);
    const draft = inbox.getDraftById(id);
    expect(draft?.bodyMd).toBe('edited body');
    expect(draft?.userEditsCount).toBe(1);
    expect(inbox.updateDraftBody(id, 'edited again')).toBe(true);
    expect(inbox.getDraftById(id)?.userEditsCount).toBe(2);
  });

  it('updateDraftBody returns false for an unknown id', () => {
    expect(inbox.updateDraftBody('drf_missing', 'x')).toBe(false);
  });

  it('insertDraftAndAttach atomically inserts the draft and writes inbox_items.draft_id', () => {
    const itemId = insertSampleItem();
    const id = inbox.insertDraftAndAttach({
      itemId,
      bodyMd: 'x',
      generatedAt: new Date('2026-05-10T12:00:00Z'),
      generatorVersion: 'g',
    });
    expect(inbox.getDraftById(id)?.itemId).toBe(itemId);
    expect(inbox.getItem(itemId)?.draftId).toBe(id);
  });
});

describe('InboxStateDb — rules', () => {
  it('inserts and lists rules per account in creation order', () => {
    const a = inbox.insertRule({
      accountId: TEST_ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'noreply@stripe.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
      createdAt: new Date('2026-05-10T10:00:00Z'),
    });
    const b = inbox.insertRule({
      accountId: TEST_ACCOUNT.id,
      matcherKind: 'list_id',
      matcherValue: 'newsletter@example.com',
      bucket: 'auto_handled',
      action: 'mark_read',
      source: 'proactive_threshold',
      createdAt: new Date('2026-05-10T11:00:00Z'),
    });
    const rules = inbox.listRulesForAccount(TEST_ACCOUNT.id);
    expect(rules.map((r) => r.id)).toEqual([a, b]);
    expect(rules[0]?.matcherKind).toBe('from');
    expect(rules[1]?.action).toBe('mark_read');
  });

  it('isolates rules across accounts', () => {
    mail.upsertAccount({ ...TEST_ACCOUNT, id: 'acct-2', address: 'second@example.com' });
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'from',
      matcherValue: 'a@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    inbox.insertRule({
      accountId: 'acct-2',
      matcherKind: 'from',
      matcherValue: 'b@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    expect(inbox.listRulesForAccount('acct-1')).toHaveLength(1);
    expect(inbox.listRulesForAccount('acct-2')).toHaveLength(1);
  });

  it('deletes rules and returns false on a missing id', () => {
    const id = inbox.insertRule({
      accountId: TEST_ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'x@y',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    expect(inbox.deleteRule(id)).toBe(true);
    expect(inbox.deleteRule(id)).toBe(false);
    expect(inbox.listRulesForAccount(TEST_ACCOUNT.id)).toHaveLength(0);
  });
});
