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

  it('hides snoozed items from listItems until snooze_until has passed', () => {
    const live = insertSampleItem({ threadKey: 'live' });
    const future = insertSampleItem({ threadKey: 'future' });
    const past = insertSampleItem({ threadKey: 'past' });

    inbox.setSnooze(future, new Date(Date.now() + 60 * 60 * 1000)); // +1h
    inbox.setSnooze(past, new Date(Date.now() - 60 * 60 * 1000));   // -1h

    const visibleIds = inbox.listItems({ bucket: 'requires_user' }).map((it) => it.id);
    expect(visibleIds).toContain(live);
    expect(visibleIds).toContain(past);
    expect(visibleIds).not.toContain(future);
  });

  it('excludes currently-snoozed items from countItemsByBucket', () => {
    insertSampleItem({ bucket: 'requires_user', threadKey: 'a' });
    insertSampleItem({ bucket: 'requires_user', threadKey: 'b' });
    const snoozed = insertSampleItem({ bucket: 'requires_user', threadKey: 'c' });
    inbox.setSnooze(snoozed, new Date(Date.now() + 60 * 60 * 1000));

    expect(inbox.countItemsByBucket()).toEqual({
      requires_user: 2,
      draft_ready: 0,
      auto_handled: 0,
    });
  });

  it('clearing the snooze re-surfaces the item in list and counts', () => {
    const id = insertSampleItem({ bucket: 'requires_user' });
    inbox.setSnooze(id, new Date(Date.now() + 60 * 60 * 1000));
    expect(inbox.listItems({ bucket: 'requires_user' })).toHaveLength(0);
    expect(inbox.countItemsByBucket().requires_user).toBe(0);

    inbox.setSnooze(id, null);
    expect(inbox.listItems({ bucket: 'requires_user' }).map((it) => it.id)).toEqual([id]);
    expect(inbox.countItemsByBucket().requires_user).toBe(1);
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

  it('getItemBody returns null until a body is cached, then echoes the saved fields', () => {
    const itemId = insertSampleItem();
    expect(inbox.getItemBody(itemId)).toBeNull();
    inbox.saveItemBody(itemId, 'Hi Max,\n\n…full body…', 'imap', new Date('2026-05-12T10:00:00Z'));
    const row = inbox.getItemBody(itemId);
    expect(row?.bodyMd).toBe('Hi Max,\n\n…full body…');
    expect(row?.source).toBe('imap');
    expect(row?.fetchedAt.toISOString()).toBe('2026-05-12T10:00:00.000Z');
  });

  it('saveItemBody is upsert — a refetch replaces the cached row', () => {
    const itemId = insertSampleItem();
    inbox.saveItemBody(itemId, 'v1', 'imap', new Date('2026-05-12T10:00:00Z'));
    inbox.saveItemBody(itemId, 'v2', 'imap', new Date('2026-05-12T11:00:00Z'));
    const row = inbox.getItemBody(itemId);
    expect(row?.bodyMd).toBe('v2');
    expect(row?.fetchedAt.toISOString()).toBe('2026-05-12T11:00:00.000Z');
  });

  it('inbox_item_bodies cascades on inbox_items delete', () => {
    const itemId = insertSampleItem();
    inbox.saveItemBody(itemId, 'body', 'imap');
    expect(inbox.getItemBody(itemId)).not.toBeNull();
    mail.getConnection().prepare('DELETE FROM inbox_items WHERE id = ?').run(itemId);
    expect(inbox.getItemBody(itemId)).toBeNull();
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

describe('InboxStateDb — v11 envelope metadata', () => {
  it('round-trips envelope columns on insert', () => {
    const id = inbox.insertItem({
      accountId: TEST_ACCOUNT.id,
      channel: 'email',
      threadKey: 'imap:thread-v11',
      bucket: 'requires_user',
      confidence: 0.8,
      reasonDe: 'v11 envelope test',
      classifiedAt: new Date('2026-05-12T08:30:00Z'),
      classifierVersion: 'haiku-2026-05',
      fromAddress: 'sender@example.com',
      fromName: 'Sender Display',
      subject: 'Envelope-preserving subject',
      mailDate: new Date('2026-05-11T17:00:00Z'),
      snippet: 'short preview',
      messageId: '<v11msg@example.com>',
      inReplyTo: '<parent@example.com>',
    });
    const item = inbox.getItem(id);
    expect(item).toMatchObject({
      fromAddress: 'sender@example.com',
      fromName: 'Sender Display',
      subject: 'Envelope-preserving subject',
      mailDate: new Date('2026-05-11T17:00:00Z'),
      snippet: 'short preview',
      messageId: '<v11msg@example.com>',
      inReplyTo: '<parent@example.com>',
    });
  });

  it('pre-v11 callers (no envelope fields) get DEFAULT \'\' / undefined', () => {
    const id = insertSampleItem();
    const item = inbox.getItem(id);
    expect(item?.fromAddress).toBe('');
    expect(item?.fromName).toBeUndefined();
    expect(item?.subject).toBe('');
    expect(item?.mailDate).toBeUndefined();
    expect(item?.snippet).toBeUndefined();
    expect(item?.messageId).toBeUndefined();
    expect(item?.inReplyTo).toBeUndefined();
  });

  it('updateItemEnvelopeByThreadKey fills metadata in place by thread_key', () => {
    insertSampleItem({ threadKey: 'imap:thread-backfill' });
    const updated = inbox.updateItemEnvelopeByThreadKey(
      TEST_ACCOUNT.id,
      'imap:thread-backfill',
      {
        fromAddress: 'backfilled@example.com',
        fromName: 'Backfilled Sender',
        subject: 'Backfilled subject',
        mailDate: new Date('2026-05-09T10:00:00Z'),
        snippet: 'backfilled snippet',
        messageId: '<bf@example.com>',
        inReplyTo: undefined,
      },
    );
    expect(updated).toBe(true);
    const list = inbox.listItems({ bucket: 'requires_user' });
    expect(list[0]).toMatchObject({
      fromAddress: 'backfilled@example.com',
      fromName: 'Backfilled Sender',
      subject: 'Backfilled subject',
      mailDate: new Date('2026-05-09T10:00:00Z'),
    });
  });

  it('listItemsByThreadKey returns the single thread row (v8 UNIQUE constraint)', () => {
    // v8's UNIQUE(tenant_id, account_id, thread_key) means each thread maps
    // to exactly one inbox_items row — sibling messages collapse via
    // ON CONFLICT DO NOTHING. So local-SQL "thread history" is always 0
    // or 1 row; full provider-side thread walk is a Phase 5 follow-up.
    const id = inbox.insertItem({
      accountId: TEST_ACCOUNT.id,
      channel: 'email',
      threadKey: 'imap:thr-lookup',
      bucket: 'requires_user',
      confidence: 0.5,
      reasonDe: 'single',
      classifiedAt: new Date('2026-05-10T12:00:00Z'),
      classifierVersion: 'v',
      fromAddress: 'a@x',
      subject: 'single thread row',
    });
    const messages = inbox.listItemsByThreadKey(TEST_ACCOUNT.id, 'imap:thr-lookup');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(id);
  });

  it('listItemsByThreadKey returns empty for an unknown thread_key', () => {
    insertSampleItem();
    const messages = inbox.listItemsByThreadKey(TEST_ACCOUNT.id, 'imap:no-such');
    expect(messages).toHaveLength(0);
  });

  it('listItemsByThreadKey isolates by tenant', () => {
    inbox.insertItem({
      accountId: TEST_ACCOUNT.id,
      tenantId: 'tenant-a',
      channel: 'email',
      threadKey: 'imap:cross-tenant',
      bucket: 'requires_user',
      confidence: 0.5,
      reasonDe: 'a',
      classifiedAt: new Date('2026-05-10T12:00:00Z'),
      classifierVersion: 'v',
      fromAddress: 'a@x',
      subject: 'a',
    });
    inbox.insertItem({
      accountId: TEST_ACCOUNT.id,
      tenantId: 'tenant-b',
      channel: 'email',
      threadKey: 'imap:cross-tenant',
      bucket: 'requires_user',
      confidence: 0.5,
      reasonDe: 'b',
      classifiedAt: new Date('2026-05-10T12:00:00Z'),
      classifierVersion: 'v',
      fromAddress: 'b@x',
      subject: 'b',
    });
    const a = inbox.listItemsByThreadKey(TEST_ACCOUNT.id, 'imap:cross-tenant', { tenantId: 'tenant-a' });
    const b = inbox.listItemsByThreadKey(TEST_ACCOUNT.id, 'imap:cross-tenant', { tenantId: 'tenant-b' });
    expect(a).toHaveLength(1);
    expect(a[0]?.reasonDe).toBe('a');
    expect(b).toHaveLength(1);
    expect(b[0]?.reasonDe).toBe('b');
  });

  it('insertThreadMessage round-trips an inbound message', () => {
    const id = inbox.insertThreadMessage({
      accountId: TEST_ACCOUNT.id,
      threadKey: 'thr-1',
      messageId: '<msg-1@example.com>',
      fromAddress: 'sender@example.com',
      fromName: 'Sender',
      subject: 'subject',
      mailDate: new Date('2026-05-10T10:00:00Z'),
      snippet: 'a snippet',
      direction: 'inbound',
      bodyMd: 'the body',
    });
    expect(id.startsWith('itm_')).toBe(true);
    const list = inbox.listThreadMessages(TEST_ACCOUNT.id, 'thr-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.subject).toBe('subject');
    expect(list[0]?.direction).toBe('inbound');
    expect(list[0]?.bodyMd).toBe('the body');
  });

  it('insertThreadMessage is idempotent on (tenant, account, message_id) dedup', () => {
    const first = inbox.insertThreadMessage({
      accountId: TEST_ACCOUNT.id,
      threadKey: 'thr-dup',
      messageId: '<dup@example.com>',
      fromAddress: 'a@x',
      subject: 'first',
      direction: 'inbound',
    });
    const second = inbox.insertThreadMessage({
      accountId: TEST_ACCOUNT.id,
      threadKey: 'thr-dup-different',
      messageId: '<dup@example.com>',
      fromAddress: 'a@x',
      subject: 'second-attempt',
      direction: 'inbound',
    });
    expect(second).toBe(first);
    const list = inbox.listThreadMessages(TEST_ACCOUNT.id, 'thr-dup');
    expect(list).toHaveLength(1);
    expect(list[0]?.subject).toBe('first');
  });

  it('listThreadMessages orders newest-first by mail_date', () => {
    inbox.insertThreadMessage({
      accountId: TEST_ACCOUNT.id,
      threadKey: 'thr-order',
      messageId: '<m1@x>',
      fromAddress: 'a@x',
      subject: 'older',
      direction: 'inbound',
      mailDate: new Date('2026-05-08T10:00:00Z'),
    });
    inbox.insertThreadMessage({
      accountId: TEST_ACCOUNT.id,
      threadKey: 'thr-order',
      messageId: '<m2@x>',
      fromAddress: 'a@x',
      subject: 'newer',
      direction: 'inbound',
      mailDate: new Date('2026-05-10T10:00:00Z'),
    });
    const list = inbox.listThreadMessages(TEST_ACCOUNT.id, 'thr-order');
    expect(list).toHaveLength(2);
    expect(list[0]?.subject).toBe('newer');
    expect(list[1]?.subject).toBe('older');
  });

  it('getThreadMessageByMessageId returns null on miss, row on hit', () => {
    inbox.insertThreadMessage({
      accountId: TEST_ACCOUNT.id,
      threadKey: 'thr-lookup-msg',
      messageId: '<find@x>',
      fromAddress: 'a@x',
      subject: 'looked-up',
      direction: 'inbound',
    });
    expect(inbox.getThreadMessageByMessageId(TEST_ACCOUNT.id, '<missing@x>')).toBeNull();
    const found = inbox.getThreadMessageByMessageId(TEST_ACCOUNT.id, '<find@x>');
    expect(found?.subject).toBe('looked-up');
  });

  it('updateItemEnvelopeByThreadKey returns false when no row matches', () => {
    const updated = inbox.updateItemEnvelopeByThreadKey(
      TEST_ACCOUNT.id,
      'imap:no-such-thread',
      {
        fromAddress: 'x@y',
        fromName: undefined,
        subject: 's',
        mailDate: undefined,
        snippet: undefined,
        messageId: undefined,
        inReplyTo: undefined,
      },
    );
    expect(updated).toBe(false);
  });
});

describe('InboxStateDb — bulk action log + UNDO', () => {
  it('insertBulkActionLog round-trips a per-id row keyed by bulk_id', () => {
    const itemId = insertSampleItem();
    const id = inbox.insertBulkActionLog({
      bulkId: 'bulk-1',
      itemId,
      priorUserAction: null,
      priorUserActionAt: null,
      action: 'archived',
    });
    expect(id.startsWith('iul_')).toBe(true);
    const recent = inbox.listRecentBulks();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.bulkId).toBe('bulk-1');
    expect(recent[0]?.itemCount).toBe(1);
    expect(recent[0]?.action).toBe('archived');
  });

  it('undoBulkAction reverts each item to its prior_user_action', () => {
    const a = insertSampleItem({ threadKey: 'thr-a' });
    const b = insertSampleItem({ threadKey: 'thr-b' });
    // Pre-existing state: `a` was already archived; `b` was untouched.
    inbox.updateUserAction(a, 'archived', new Date('2026-05-01T00:00:00Z'));
    // Bulk action: snooze both.
    inbox.insertBulkActionLog({ bulkId: 'b-undo', itemId: a, priorUserAction: 'archived', priorUserActionAt: new Date('2026-05-01T00:00:00Z'), action: 'snoozed' });
    inbox.insertBulkActionLog({ bulkId: 'b-undo', itemId: b, priorUserAction: null, priorUserActionAt: null, action: 'snoozed' });
    inbox.updateUserAction(a, 'snoozed');
    inbox.updateUserAction(b, 'snoozed');
    expect(inbox.getItem(a)?.userAction).toBe('snoozed');
    expect(inbox.getItem(b)?.userAction).toBe('snoozed');
    // Undo: a returns to archived (its prior state), b returns to null.
    const reverted = inbox.undoBulkAction('b-undo');
    expect(reverted).toBe(2);
    expect(inbox.getItem(a)?.userAction).toBe('archived');
    expect(inbox.getItem(b)?.userAction).toBeUndefined();
    // Second call is a no-op.
    expect(inbox.undoBulkAction('b-undo')).toBe(0);
  });

  it('undoBulkAction refuses rows older than the window', () => {
    const itemId = insertSampleItem();
    inbox.insertBulkActionLog({
      bulkId: 'b-old',
      itemId,
      priorUserAction: null,
      priorUserActionAt: null,
      action: 'archived',
      performedAt: new Date(Date.now() - 120_000), // 2 minutes ago
    });
    inbox.updateUserAction(itemId, 'archived');
    const reverted = inbox.undoBulkAction('b-old', new Date(), 60_000);
    expect(reverted).toBe(0);
    expect(inbox.getItem(itemId)?.userAction).toBe('archived');
  });

  it('listRecentBulks returns groups newest-first, capped at limit', () => {
    for (let i = 0; i < 7; i += 1) {
      const id = insertSampleItem({ threadKey: `thr-r-${i}` });
      inbox.insertBulkActionLog({
        bulkId: `b-${i}`,
        itemId: id,
        priorUserAction: null,
        priorUserActionAt: null,
        action: 'archived',
        performedAt: new Date(Date.now() - i * 1000),
      });
    }
    const recent = inbox.listRecentBulks(undefined, 60_000, 5);
    expect(recent).toHaveLength(5);
    // Newest first
    expect(recent[0]?.bulkId).toBe('b-0');
  });

  it('pruneOldBulkActionLog deletes rows older than the window', () => {
    const itemId = insertSampleItem();
    inbox.insertBulkActionLog({
      bulkId: 'b-prune',
      itemId,
      priorUserAction: null,
      priorUserActionAt: null,
      action: 'archived',
      performedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    });
    const deleted = inbox.pruneOldBulkActionLog(5 * 60 * 1000);
    expect(deleted).toBe(1);
  });
});

describe('InboxStateDb — listItems with ?q= search', () => {
  function seedFor(subject: string, fromAddress: string, snippet: string | undefined, threadKey: string): string {
    return inbox.insertItem({
      accountId: TEST_ACCOUNT.id,
      channel: 'email',
      threadKey,
      bucket: 'requires_user',
      confidence: 0.5,
      reasonDe: 'noise',
      classifiedAt: new Date('2026-05-10T12:00:00Z'),
      classifierVersion: 'v',
      fromAddress,
      subject,
      snippet,
    });
  }

  it('matches subject', () => {
    seedFor('Rechnung Mai', 'biller@example.com', undefined, 'thr-q-1');
    seedFor('Newsletter', 'news@example.com', undefined, 'thr-q-2');
    const list = inbox.listItems({ q: 'Rechnung' });
    expect(list).toHaveLength(1);
    expect(list[0]?.subject).toBe('Rechnung Mai');
  });

  it('matches from_address case-insensitively', () => {
    seedFor('Hi', 'roland@example.com', undefined, 'thr-q-a');
    seedFor('Hi', 'alice@example.com', undefined, 'thr-q-b');
    const list = inbox.listItems({ q: 'ROLAND' });
    expect(list.map((i) => i.fromAddress)).toContain('roland@example.com');
    expect(list.some((i) => i.fromAddress === 'alice@example.com')).toBe(false);
  });

  it('matches snippet', () => {
    seedFor('S', 'a@x', 'Termin am Montag', 'thr-q-s1');
    seedFor('S', 'a@x', 'Anderes Thema', 'thr-q-s2');
    const list = inbox.listItems({ q: 'Termin' });
    expect(list).toHaveLength(1);
  });

  it('escapes wildcard chars in user input (no false-match on %)', () => {
    seedFor('30 off', 'a@x', undefined, 'thr-q-w1');
    seedFor('Anything', 'b@x', undefined, 'thr-q-w2');
    // The pattern is `%${escaped}%`; without escape `%` in input would match all.
    const list = inbox.listItems({ q: '30%' });
    expect(list).toHaveLength(0); // No subject contains literal "30%"
  });
});
