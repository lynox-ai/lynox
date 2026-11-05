import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { DEFAULT_TENANT_ID, InboxStateDb } from './state.js';
import { MAX_DESCRIPTION_RULES } from './rule-text.js';
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

  it('excludes items the user has already actioned — counter must match the visible list', () => {
    const a = insertSampleItem({ bucket: 'requires_user', threadKey: 'a' });
    insertSampleItem({ bucket: 'requires_user', threadKey: 'b' });
    inbox.updateUserAction(a, 'archived');
    expect(inbox.countItemsByBucket().requires_user).toBe(1);

    // UNDO restores it to the count
    inbox.updateUserAction(a, null);
    expect(inbox.countItemsByBucket().requires_user).toBe(2);
  });

  // Audit S-AT-02: getItem and the mutation surface (updateUserAction,
  // setSnooze, deleteRule, markReminderNotified, listAuditForItem) must
  // scope to tenant. Without this, a Phase-5 multi-tenant deployment could
  // mutate other tenants' items by id alone.
  describe('tenant isolation (audit S-AT-02)', () => {
    it('getItem returns null when the tenant does not match', () => {
      const id = insertSampleItem();
      expect(inbox.getItem(id, DEFAULT_TENANT_ID)).not.toBeNull();
      expect(inbox.getItem(id, 'other-tenant')).toBeNull();
    });

    it('updateUserAction is a no-op for the wrong tenant', () => {
      const id = insertSampleItem();
      expect(inbox.updateUserAction(id, 'archived', new Date(), 'other-tenant')).toBe(false);
      expect(inbox.getItem(id)?.userAction).toBeUndefined();
      // Default tenant still works
      expect(inbox.updateUserAction(id, 'archived')).toBe(true);
      expect(inbox.getItem(id)?.userAction).toBe('archived');
    });

    it('setSnooze is a no-op for the wrong tenant', () => {
      const id = insertSampleItem();
      const until = new Date('2026-05-15T10:00:00Z');
      expect(inbox.setSnooze(id, until, null, true, false, 'other-tenant')).toBe(false);
      expect(inbox.getItem(id)?.snoozeUntil).toBeUndefined();
    });

    it('deleteRule is a no-op for the wrong tenant', () => {
      const ruleId = inbox.insertRule({
        accountId: TEST_ACCOUNT.id,
        matcherKind: 'from',
        matcherValue: 'noreply@example.com',
        bucket: 'auto_handled',
        action: 'archive',
        source: 'manual',
      });
      expect(inbox.deleteRule(ruleId, 'other-tenant')).toBe(false);
      expect(inbox.deleteRule(ruleId)).toBe(true);
    });

    it('listAuditForItem returns empty for the wrong tenant', () => {
      const itemId = insertSampleItem();
      inbox.appendAudit({
        itemId,
        action: 'archived',
        actor: 'user',
        payloadJson: '{}',
      });
      expect(inbox.listAuditForItem(itemId).length).toBe(1);
      expect(inbox.listAuditForItem(itemId, 'other-tenant').length).toBe(0);
    });

    it('markReminderNotified is a no-op for the wrong tenant', () => {
      const itemId = insertSampleItem();
      expect(inbox.markReminderNotified(itemId, new Date(), 'other-tenant')).toBe(false);
      expect(inbox.markReminderNotified(itemId)).toBe(true);
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

  it('sets and clears snooze atomically — null clears the snooze + condition, preserves unsnooze_on_reply', () => {
    const id = insertSampleItem();
    expect(inbox.setSnooze(id, new Date('2026-05-15'), 'if_no_reply', false)).toBe(true);
    let item = inbox.getItem(id);
    expect(item?.snoozeUntil?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(item?.snoozeCondition).toBe('if_no_reply');
    expect(item?.unsnoozeOnReply).toBe(false);

    // Clear — until=null wipes the snooze fields but deliberately leaves
    // unsnooze_on_reply alone. The flag has no semantic meaning on a
    // cleared row (no snooze to wake from), and previously rewriting it
    // to the default `true` left misleading data that future audit greps
    // would surface as phantom intent.
    expect(inbox.setSnooze(id, null, null)).toBe(true);
    item = inbox.getItem(id);
    expect(item?.snoozeUntil).toBeUndefined();
    expect(item?.snoozeCondition).toBeUndefined();
    expect(item?.unsnoozeOnReply).toBe(false); // preserved from prior set
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

  // The audit row that records a snooze action must commit together with
  // the state change itself — if a caller appends to the audit log AFTER
  // setSnooze without a transaction, a throw between the two leaves the
  // snooze live but unaudited (or vice versa). runInTransaction is the
  // shared wrapper for both pair sites (api.ts setSnooze + watcher-hook
  // unsnooze-on-reply); these tests pin its rollback semantics.
  describe('runInTransaction', () => {
    it('rolls back the state mutation if the audit insert throws', () => {
      const id = insertSampleItem();
      expect(() => {
        inbox.runInTransaction(() => {
          inbox.setSnooze(id, new Date(Date.now() + 3600_000), null, true, false);
          // Force the second op to throw — simulates a corrupt audit
          // payload or a downstream DB constraint kicking in.
          throw new Error('boom');
        });
      }).toThrow('boom');
      // Snooze must NOT have landed.
      const item = inbox.getItem(id);
      expect(item?.snoozeUntil).toBeUndefined();
    });

    it('commits both mutations when the callback returns', () => {
      const id = insertSampleItem();
      const until = new Date(Date.now() + 3600_000);
      const auditId = inbox.runInTransaction(() => {
        inbox.setSnooze(id, until, null, true, false);
        return inbox.appendAudit({
          itemId: id,
          action: 'snoozed',
          actor: 'user',
          payloadJson: '{}',
        });
      });
      expect(auditId).toBeTruthy();
      const entries = inbox.listAuditForItem(id);
      expect(entries.some((e) => e.id === auditId && e.action === 'snoozed')).toBe(true);
    });

    it('returns the callback value through', () => {
      const out = inbox.runInTransaction(() => 'sentinel');
      expect(out).toBe('sentinel');
    });
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

describe('InboxStateDb — rules the agent proposes and the owner confirms', () => {
  const proposal = (over: Partial<Parameters<InboxStateDb['proposeRule']>[0]> = {}) => ({
    accountId: TEST_ACCOUNT.id, matcherKind: 'from' as const, matcherValue: 'kunde@example.com', name: 'Kunde', ...over,
  });

  it('a proposal waits: requires_user, show, source agent, unconfirmed, with its run — and it is not a rule that applies', () => {
    const r = inbox.proposeRule(proposal({ runId: 'run-7' }), 10, new Date(5000));
    expect(r.ok).toBe(true);
    const id = r.ok ? r.id : '';
    const all = inbox.listRulesForAccount(TEST_ACCOUNT.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, bucket: 'requires_user', action: 'show', source: 'agent', name: 'Kunde', runId: 'run-7' });
    expect(all[0]?.confirmedAt).toBeUndefined();
    expect(inbox.listConfirmedRulesForAccount(TEST_ACCOUNT.id)).toHaveLength(0);
  });

  it('confirming makes it apply; again keeps the first time; an unknown or other-tenant id confirms nothing', () => {
    const r = inbox.proposeRule(proposal(), 10);
    const id = r.ok ? r.id : '';
    expect(inbox.confirmRule(id, 'other-tenant')).toBe(false);
    expect(inbox.listConfirmedRulesForAccount(TEST_ACCOUNT.id)).toHaveLength(0);
    expect(inbox.confirmRule('rul_missing')).toBe(false);
    expect(inbox.confirmRule(id, DEFAULT_TENANT_ID, new Date(9000))).toBe(true);
    expect(inbox.confirmRule(id, DEFAULT_TENANT_ID, new Date(12000))).toBe(true);
    const applied = inbox.listConfirmedRulesForAccount(TEST_ACCOUNT.id);
    expect(applied.map((x) => x.id)).toEqual([id]);
    expect(applied[0]?.confirmedAt?.getTime()).toBe(9000);
  });

  it('the eleventh waiting proposal of an account is refused; confirming one frees a place; another account counts apart', () => {
    for (let i = 0; i < 10; i++) {
      expect(inbox.proposeRule(proposal({ matcherValue: `k${String(i)}@example.com` }), 10).ok).toBe(true);
    }
    const eleventh = inbox.proposeRule(proposal({ matcherValue: 'k10@example.com' }), 10);
    expect(eleventh).toEqual({ ok: false, reason: 'limit', pending: 10 });
    expect(inbox.listRulesForAccount(TEST_ACCOUNT.id)).toHaveLength(10);
    mail.upsertAccount({ ...TEST_ACCOUNT, id: 'acct-2', address: 'second@example.com' });
    expect(inbox.proposeRule(proposal({ accountId: 'acct-2' }), 10).ok).toBe(true);
    const first = inbox.listRulesForAccount(TEST_ACCOUNT.id)[0]!;
    expect(inbox.confirmRule(first.id)).toBe(true);
    expect(inbox.proposeRule(proposal({ matcherValue: 'k10@example.com' }), 10).ok).toBe(true);
  });

  it('applies rules in the order they were confirmed, not proposed', () => {
    const p = inbox.proposeRule(proposal({ matcherValue: 'same@x' }), 10, new Date(1000));
    const proposed = p.ok ? p.id : '';
    const owner = inbox.insertRule({
      accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'same@x', bucket: 'auto_handled',
      action: 'archive', source: 'on_demand', createdAt: new Date(2000),
    });
    inbox.confirmRule(proposed, DEFAULT_TENANT_ID, new Date(3000));
    expect(inbox.listConfirmedRulesForAccount(TEST_ACCOUNT.id).map((r) => r.id)).toEqual([owner, proposed]);
  });

  it('lists the open items of one bucket that one rule filed', () => {
    const ruleId = inbox.insertRule({
      accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'a@x', bucket: 'requires_user', action: 'show', source: 'on_demand',
    });
    insertSampleItem({ threadKey: 'r-1', matchedRuleId: ruleId });
    insertSampleItem({ threadKey: 'r-2' });
    const open = (r?: string) => inbox.listOpenItems({ bucket: 'requires_user', limit: 50, offset: 0, ruleId: r }).map((i) => i.threadKey).sort();
    expect(open()).toEqual(['r-1', 'r-2']);
    expect(open(ruleId)).toEqual(['r-1']);
    expect(open('rul_other')).toEqual([]);
  });

  it("an owner's rule is confirmed when it is made, and keeps its name", () => {
    const id = inbox.insertRule({
      accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'a@x', bucket: 'auto_handled',
      action: 'archive', source: 'on_demand', name: 'Belege', createdAt: new Date(4000),
    });
    const [rule] = inbox.listConfirmedRulesForAccount(TEST_ACCOUNT.id);
    expect(rule).toMatchObject({ id, name: 'Belege' });
    expect(rule?.confirmedAt?.getTime()).toBe(4000);
  });

  it('lists the items one rule filed, and deleting the rule clears the mark but not the items', () => {
    const ruleId = inbox.insertRule({
      accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'a@x', bucket: 'requires_user', action: 'show', source: 'on_demand',
    });
    const filed = insertSampleItem({ threadKey: 't-a', matchedRuleId: ruleId, subject: 'Rechnung 4711' });
    insertSampleItem({ threadKey: 't-b', matchedRuleId: ruleId, subject: 'Mahnung', bucket: 'draft_ready' });
    insertSampleItem({ threadKey: 't-c' });
    expect(inbox.getItem(filed)?.matchedRuleId).toBe(ruleId);
    expect(inbox.listItems({ ruleId }).map((i) => i.threadKey).sort()).toEqual(['t-a', 't-b']);
    expect(inbox.listItems({ ruleId, bucket: 'draft_ready' }).map((i) => i.threadKey)).toEqual(['t-b']);
    expect(inbox.listItems({ ruleId, q: '4711' }).map((i) => i.threadKey)).toEqual(['t-a']);
    expect(inbox.listItems({ ruleId, tenantId: 'other-tenant' })).toHaveLength(0);
    expect(inbox.deleteRule(ruleId)).toBe(true);
    expect(inbox.listItems({ ruleId })).toHaveLength(0);
    expect(inbox.getItem(filed)?.matchedRuleId).toBeUndefined();
    expect(inbox.listItems()).toHaveLength(3);
  });
});

describe('InboxStateDb — description rules are capped per account', () => {
  const desc = (i: number, accountId = TEST_ACCOUNT.id) => ({ accountId, matcherKind: 'matches_description' as const, matcherValue: `Beschreibung ${String(i)}`, name: `D${String(i)}` });

  it('refuses the proposal past MAX_DESCRIPTION_RULES, counting confirmed and waiting rules alike', () => {
    for (let i = 0; i < 15; i++) {
      inbox.insertRule({ ...desc(i), bucket: 'requires_user', action: 'show', source: 'on_demand' });
    }
    for (let i = 15; i < MAX_DESCRIPTION_RULES; i++) {
      expect(inbox.proposeRule(desc(i), 100).ok).toBe(true);
    }
    expect(inbox.countRulesOfKind(TEST_ACCOUNT.id, 'matches_description')).toBe(MAX_DESCRIPTION_RULES);
    expect(inbox.proposeRule(desc(99), 100)).toEqual({ ok: false, reason: 'description_limit', descriptions: MAX_DESCRIPTION_RULES });
    expect(inbox.countRulesOfKind(TEST_ACCOUNT.id, 'matches_description')).toBe(MAX_DESCRIPTION_RULES);
  });

  it('the cap is per account and per kind: other kinds and other accounts still propose', () => {
    mail.upsertAccount({ ...TEST_ACCOUNT, id: 'acct-2', address: 'second@example.com' });
    for (let i = 0; i < MAX_DESCRIPTION_RULES; i++) {
      inbox.insertRule({ ...desc(i), bucket: 'requires_user', action: 'show', source: 'on_demand' });
    }
    expect(inbox.proposeRule({ accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'k@example.com', name: 'K' }, 100).ok).toBe(true);
    expect(inbox.proposeRule(desc(0, 'acct-2'), 100).ok).toBe(true);
    expect(inbox.countRulesOfKind(TEST_ACCOUNT.id, 'from')).toBe(1);
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

describe('InboxStateDb — settings KV (v15)', () => {
  it('returns the fallback when a key is absent', () => {
    expect(inbox.getSetting('push.inbox_enabled', 'true')).toBe('true');
    expect(inbox.getSetting('missing')).toBeNull();
  });

  it('round-trips a value via setSetting + getSetting', () => {
    inbox.setSetting('push.inbox_enabled', 'false');
    expect(inbox.getSetting('push.inbox_enabled', 'true')).toBe('false');
  });

  it('upserts on a second set without raising', () => {
    inbox.setSetting('push.inbox_enabled', 'false');
    inbox.setSetting('push.inbox_enabled', 'true');
    expect(inbox.getSetting('push.inbox_enabled')).toBe('true');
  });
});

describe('InboxStateDb — sidebar context queries', () => {
  function seedItemFromAddress(
    fromAddress: string,
    overrides: Partial<Parameters<InboxStateDb['insertItem']>[0]> = {},
  ): string {
    return insertSampleItem({
      threadKey: `imap:thread-${Math.random().toString(36).slice(2, 8)}`,
      fromAddress,
      subject: `Subject from ${fromAddress}`,
      ...overrides,
    });
  }

  it('returns recent items from same sender, newest-first, capped at limit', () => {
    const me = 'sender@acme.example';
    seedItemFromAddress(me, { classifiedAt: new Date('2026-04-01T10:00:00Z') });
    const newer = seedItemFromAddress(me, { classifiedAt: new Date('2026-05-01T10:00:00Z') });
    seedItemFromAddress('other@x.example', { classifiedAt: new Date('2026-05-02T10:00:00Z') });
    const open = seedItemFromAddress(me, { classifiedAt: new Date('2026-05-09T10:00:00Z') });

    const list = inbox.listRecentByFromAddress(me, { excludeItemId: open, limit: 5 });

    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(newer);
    expect(list.every((i) => i.id !== open)).toBe(true);
    expect(list.every((i) => i.fromAddress.toLowerCase() === me)).toBe(true);
  });

  it('matches case-insensitively on from_address (envelope casing not normalised)', () => {
    seedItemFromAddress('Mixed@Acme.Example');
    const list = inbox.listRecentByFromAddress('mixed@acme.example');
    expect(list).toHaveLength(1);
  });

  it('orders reminders by snooze_until ASC and excludes the open item', () => {
    const me = 'sender@acme.example';
    const open = seedItemFromAddress(me);
    const farFuture = new Date(Date.now() + 14 * 86_400_000);
    const nearFuture = new Date(Date.now() + 1 * 86_400_000);
    const far = seedItemFromAddress(me);
    inbox.setSnooze(far, farFuture, null, true, true);
    const near = seedItemFromAddress(me);
    inbox.setSnooze(near, nearFuture, null, true, true);

    const list = inbox.listActiveRemindersByFromAddress(me, { excludeItemId: open, limit: 5 });

    expect(list.map((i) => i.id)).toEqual([near, far]);
  });

  it('returns only active mail-anchored reminders for the sender', () => {
    const me = 'sender@acme.example';
    const future = new Date(Date.now() + 7 * 86_400_000);
    const remind = seedItemFromAddress(me);
    inbox.setSnooze(remind, future, null, true, true);
    seedItemFromAddress(me); // active but no reminder set
    const archived = seedItemFromAddress(me);
    inbox.setSnooze(archived, future, null, true, true);
    inbox.updateUserAction(archived, 'archived');

    const list = inbox.listActiveRemindersByFromAddress(me, { limit: 5 });

    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(remind);
  });
});

describe('getUidByMessageId (uid bridge for the chat reply context)', () => {
  function seedProcessed(accountId: string, messageId: string, uid: number, folder: string): void {
    mail.getConnection()
      .prepare('INSERT INTO processed_mail_messages (account_id, message_id, uid, folder) VALUES (?, ?, ?, ?)')
      .run(accountId, messageId, uid, folder);
  }

  it('resolves uid + folder from a processed message-id', () => {
    seedProcessed(TEST_ACCOUNT.id, '<m-9@acme.example>', 99, 'Archive');
    expect(inbox.getUidByMessageId(TEST_ACCOUNT.id, '<m-9@acme.example>')).toEqual({ uid: 99, folder: 'Archive' });
  });

  it('returns null for unknown id, empty id, and a different account (no cross-account leak)', () => {
    seedProcessed(TEST_ACCOUNT.id, '<known@x>', 1, 'INBOX');
    expect(inbox.getUidByMessageId(TEST_ACCOUNT.id, '<ghost@x>')).toBeNull();
    expect(inbox.getUidByMessageId(TEST_ACCOUNT.id, '')).toBeNull();
    expect(inbox.getUidByMessageId('other-acct', '<known@x>')).toBeNull();
  });
});

describe('findItemByMessageId (outbound-reply reconcile lookup)', () => {
  it('finds the item by message-id regardless of account, empty-guards, and null-misses', () => {
    const id = insertSampleItem({ messageId: '<find-me@x>' });
    expect(inbox.findItemByMessageId('<find-me@x>')?.id).toBe(id);
    expect(inbox.findItemByMessageId('')).toBeNull();
    expect(inbox.findItemByMessageId('<nope@x>')).toBeNull();
  });

  it('returns the newest item when a message-id repeats across rows', () => {
    insertSampleItem({ messageId: '<dup@x>', threadKey: 't-old', classifiedAt: new Date('2026-05-01T00:00:00Z') });
    const newer = insertSampleItem({ messageId: '<dup@x>', threadKey: 't-new', classifiedAt: new Date('2026-06-01T00:00:00Z') });
    expect(inbox.findItemByMessageId('<dup@x>')?.id).toBe(newer);
  });
});

describe('InboxStateDb — the rule withheld on an item (v21)', () => {
  const withheld = { id: 'rul_a', name: 'Newsletter', reason: 'rule_withheld_classifier' as const };

  it('stores the withheld rule with the item and reads it back; an item without one reads null', () => {
    const id = insertSampleItem({ ruleWithheld: withheld });
    expect(inbox.getItem(id)?.ruleWithheld).toEqual({ id: 'rul_a', name: 'Newsletter', reason: 'rule_withheld_classifier' });
    expect(inbox.getItem(id)?.matchedRuleId).toBeUndefined();
    const plain = insertSampleItem({ threadKey: 'imap:thread-2' });
    expect(inbox.getItem(plain)?.ruleWithheld).toBeNull();
    // The list carries it too, as the list route returns it.
    expect(inbox.listItems().map((i) => i.ruleWithheld ?? null)).toEqual(expect.arrayContaining([null, expect.objectContaining({ id: 'rul_a' })]));
  });

  it('stores a rule without a name as name null', () => {
    const id = insertSampleItem({ ruleWithheld: { id: 'rul_a', name: undefined, reason: 'rule_withheld_unchecked' } });
    expect(inbox.getItem(id)?.ruleWithheld).toEqual({ id: 'rul_a', name: null, reason: 'rule_withheld_unchecked' });
  });

  it('refuses an item that is filed by a rule and names one as withheld', () => {
    expect(() => insertSampleItem({ matchedRuleId: 'rul_b', ruleWithheld: withheld })).toThrow(/exclusive/);
    expect(inbox.listItems()).toHaveLength(0);
  });

  it('a second insert on the same thread changes nothing on the first item', () => {
    const id = insertSampleItem({ ruleWithheld: withheld });
    expect(insertSampleItem({ matchedRuleId: 'rul_b' })).toBe(id);
    expect(insertSampleItem()).toBe(id);
    const item = inbox.getItem(id)!;
    expect(item.ruleWithheld).toEqual({ id: 'rul_a', name: 'Newsletter', reason: 'rule_withheld_classifier' });
    expect(item.matchedRuleId).toBeUndefined();
  });

  it('user actions, snooze, reopen, reminders and the envelope backfill leave it as it is', () => {
    const id = insertSampleItem({ ruleWithheld: withheld });
    inbox.updateUserAction(id, 'replied');
    inbox.reopenReplied(id, DEFAULT_TENANT_ID, new Date());
    inbox.updateUserAction(id, 'archived');
    inbox.updateUserAction(id, null);
    inbox.setSnooze(id, new Date(Date.now() + 60_000), null);
    inbox.setSnooze(id, null, null);
    inbox.markReminderNotified(id);
    inbox.updateItemEnvelopeByThreadKey(TEST_ACCOUNT.id, 'imap:thread-1', {
      fromAddress: 'a@b.example', fromName: undefined, subject: 's', mailDate: undefined, snippet: undefined, messageId: undefined, inReplyTo: undefined,
    });
    expect(inbox.getItem(id)?.ruleWithheld).toEqual({ id: 'rul_a', name: 'Newsletter', reason: 'rule_withheld_classifier' });
  });

  it('deleting the rule clears its id and keeps its name and the reason, on its items only', () => {
    const ruleId = inbox.insertRule({ accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'a@b', bucket: 'auto_handled', action: 'archive', source: 'on_demand', name: 'Alt' });
    const otherId = inbox.insertRule({ accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'c@d', bucket: 'auto_handled', action: 'archive', source: 'on_demand', name: 'Andere' });
    const mine = insertSampleItem({ ruleWithheld: { id: ruleId, name: 'Alt', reason: 'rule_withheld_sensitive' } });
    const other = insertSampleItem({ threadKey: 'imap:thread-2', ruleWithheld: { id: otherId, name: 'Andere', reason: 'rule_withheld_sensitive' } });
    const filed = insertSampleItem({ threadKey: 'imap:thread-3', matchedRuleId: ruleId });
    expect(inbox.deleteRule(ruleId)).toBe(true);
    expect(inbox.getItem(mine)?.ruleWithheld).toEqual({ id: null, name: 'Alt', reason: 'rule_withheld_sensitive' });
    expect(inbox.getItem(other)?.ruleWithheld).toEqual({ id: otherId, name: 'Andere', reason: 'rule_withheld_sensitive' });
    expect(inbox.getItem(filed)?.matchedRuleId).toBeUndefined();
    expect(inbox.getItem(filed)?.ruleWithheld).toBeNull();
  });

  it('deleting a rule in another tenant leaves the withheld id alone', () => {
    const ruleId = inbox.insertRule({ accountId: TEST_ACCOUNT.id, matcherKind: 'from', matcherValue: 'a@b', bucket: 'auto_handled', action: 'archive', source: 'on_demand', tenantId: 'other' });
    const mine = insertSampleItem({ ruleWithheld: { id: ruleId, name: 'Alt', reason: 'rule_withheld_sensitive' } });
    expect(inbox.deleteRule(ruleId, 'other')).toBe(true);
    expect(inbox.getItem(mine)?.ruleWithheld?.id).toBe(ruleId);
  });
});

describe('InboxStateDb — countPendingRules', () => {
  it('counts unconfirmed rules over all accounts of the tenant, not confirmed ones nor other tenants', () => {
    mail.upsertAccount({ ...TEST_ACCOUNT, id: 'acct-2', address: 'two@acme.example', isDefault: false });
    expect(inbox.countPendingRules()).toBe(0);
    const a = inbox.proposeRule({ accountId: 'acct-1', matcherKind: 'from', matcherValue: 'a@x', name: 'A' }, 10);
    inbox.proposeRule({ accountId: 'acct-2', matcherKind: 'from', matcherValue: 'b@x', name: 'B' }, 10);
    inbox.proposeRule({ accountId: 'acct-2', matcherKind: 'subject_contains', matcherValue: 'Rechnung', name: 'C' }, 10);
    inbox.proposeRule({ accountId: 'acct-1', matcherKind: 'from', matcherValue: 'z@x', name: 'Z', tenantId: 'other' }, 10);
    inbox.insertRule({ accountId: 'acct-1', matcherKind: 'from', matcherValue: 'own@x', bucket: 'auto_handled', action: 'archive', source: 'on_demand' });
    expect(inbox.countPendingRules()).toBe(3);
    expect(inbox.countPendingRules('other')).toBe(1);
    if (!a.ok) throw new Error('propose failed');
    expect(inbox.confirmRule(a.id)).toBe(true);
    expect(inbox.countPendingRules()).toBe(2);
  });
});
