import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import {
  handleCreateRule,
  handleDeleteRule,
  handleGetCounts,
  handleGetItem,
  handleListItemAudit,
  handleListItems,
  handleListRules,
  handleResolveContact,
  handleSetAction,
  handleSetSnooze,
  type InboxApiDeps,
} from './api.js';
import { InboxContactResolver } from './contact-resolver.js';
import type { CRM, ContactRecord } from '../../core/crm.js';
import type { MailAccountConfig } from '../mail/provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'R',
  address: 'r@x',
  preset: 'custom',
  imap: { host: 'i', port: 1, secure: true },
  smtp: { host: 's', port: 1, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

let mail: MailStateDb;
let state: InboxStateDb;
let deps: InboxApiDeps;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  state = new InboxStateDb(mail.getConnection());
  deps = { state };
});

afterEach(() => {
  mail.close();
});

function insertItem(threadKey = 't1', bucket: 'requires_user' | 'auto_handled' | 'draft_ready' = 'requires_user'): string {
  return state.insertItem({
    accountId: ACCOUNT.id,
    channel: 'email',
    threadKey,
    bucket,
    confidence: 0.9,
    reasonDe: 'r',
    classifiedAt: new Date('2026-05-10'),
    classifierVersion: 'v',
  });
}

describe('handleListItems', () => {
  it('returns items shape', () => {
    insertItem();
    const r = handleListItems(deps, {});
    expect(r.status).toBe(200);
    expect((r.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('rejects an invalid bucket', () => {
    expect(handleListItems(deps, { bucket: 'sponsored' }).status).toBe(400);
  });

  it('parses limit/offset from strings (URLSearchParams source)', () => {
    insertItem('a');
    insertItem('b');
    insertItem('c');
    const r = handleListItems(deps, { limit: '2', offset: '1' });
    expect((r.body as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('handleGetItem / handleListItemAudit', () => {
  it('returns 200 + item when found, 404 when not', () => {
    const id = insertItem();
    expect(handleGetItem(deps, id).status).toBe(200);
    expect(handleGetItem(deps, 'missing').status).toBe(404);
  });

  it('lists audit only when the item exists', () => {
    const id = insertItem();
    state.appendAudit({ itemId: id, action: 'classified', actor: 'classifier', payloadJson: '{}' });
    const r = handleListItemAudit(deps, id);
    expect((r.body as { entries: unknown[] }).entries).toHaveLength(1);
    expect(handleListItemAudit(deps, 'missing').status).toBe(404);
  });
});

describe('handleGetCounts', () => {
  it('zero-fills missing buckets', () => {
    insertItem('a', 'requires_user');
    insertItem('b', 'auto_handled');
    const r = handleGetCounts(deps);
    expect((r.body as { counts: Record<string, number> }).counts).toEqual({
      requires_user: 1,
      draft_ready: 0,
      auto_handled: 1,
    });
  });
});

describe('handleSetAction', () => {
  it('updates the item, audits, and returns 200', () => {
    const id = insertItem();
    const r = handleSetAction(deps, id, { action: 'archived', at: '2026-05-10T12:00:00Z' });
    expect(r.status).toBe(200);
    expect(state.getItem(id)?.userAction).toBe('archived');
    const audit = state.listAuditForItem(id);
    expect(audit.map((e) => e.action)).toContain('archived');
    expect(audit[0]?.actor).toBe('user');
  });

  it('audits with action=undo when reverting via null', () => {
    const id = insertItem();
    handleSetAction(deps, id, { action: 'archived' });
    handleSetAction(deps, id, { action: null });
    const audit = state.listAuditForItem(id);
    expect(audit.map((e) => e.action)).toEqual(['archived', 'undo']);
    expect(state.getItem(id)?.userAction).toBeUndefined();
  });

  it('returns 404 when the item does not exist', () => {
    expect(handleSetAction(deps, 'nope', { action: 'archived' }).status).toBe(404);
  });

  it('rejects an invalid action', () => {
    const id = insertItem();
    expect(handleSetAction(deps, id, { action: 'banished' as never }).status).toBe(400);
  });

  it('rejects a malformed at date', () => {
    const id = insertItem();
    expect(handleSetAction(deps, id, { action: 'archived', at: 'not-a-date' }).status).toBe(400);
  });
});

describe('handleSetSnooze', () => {
  it('sets the snooze, audits, and persists fields', () => {
    const id = insertItem();
    const r = handleSetSnooze(deps, id, { until: '2026-05-15T00:00:00Z', condition: 'if_no_reply' });
    expect(r.status).toBe(200);
    const item = state.getItem(id);
    expect(item?.snoozeUntil?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(item?.snoozeCondition).toBe('if_no_reply');
    const audit = state.listAuditForItem(id);
    expect(audit[0]?.action).toBe('snoozed');
  });

  it('clears the snooze when until=null and audits as undo (not as a fresh snooze)', () => {
    const id = insertItem();
    handleSetSnooze(deps, id, { until: '2026-05-15T00:00:00Z' });
    const r = handleSetSnooze(deps, id, { until: null });
    expect(r.status).toBe(200);
    expect(state.getItem(id)?.snoozeUntil).toBeUndefined();
    const audit = state.listAuditForItem(id);
    expect(audit.map((e) => e.action)).toEqual(['snoozed', 'undo']);
    const undoPayload = JSON.parse(audit[1]!.payloadJson) as Record<string, unknown>;
    expect(undoPayload['intent']).toBe('unsnooze');
  });

  it('rejects malformed until', () => {
    const id = insertItem();
    expect(handleSetSnooze(deps, id, { until: 'never' }).status).toBe(400);
  });

  it('returns 404 for unknown id', () => {
    expect(handleSetSnooze(deps, 'nope', { until: null }).status).toBe(404);
  });
});

describe('handleResolveContact', () => {
  const ROLAND: ContactRecord = { name: 'Roland', email: 'r@war' };
  const fakeCrm = (record: ContactRecord | null): CRM =>
    ({ findContact: () => record, getInteractions: () => [] }) as unknown as CRM;

  it('returns null when no resolver is configured', () => {
    const r = handleResolveContact(deps, 'r@war');
    expect((r.body as { contact: unknown }).contact).toBeNull();
  });

  it('uses the resolver when present', () => {
    const depsWithResolver: InboxApiDeps = {
      state,
      contactResolver: new InboxContactResolver(fakeCrm(ROLAND)),
    };
    const r = handleResolveContact(depsWithResolver, 'r@war');
    expect((r.body as { contact: unknown }).contact).toMatchObject({ name: 'Roland' });
  });
});

describe('rules endpoints', () => {
  it('list requires accountId', () => {
    expect(handleListRules(deps, { accountId: '' }).status).toBe(400);
  });

  it('create -> list -> delete round-trip', () => {
    const created = handleCreateRule(deps, {
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'noreply@stripe.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const list = handleListRules(deps, { accountId: ACCOUNT.id });
    expect((list.body as { rules: unknown[] }).rules).toHaveLength(1);

    const del = handleDeleteRule(deps, id);
    expect(del.status).toBe(204);
    expect(handleDeleteRule(deps, id).status).toBe(404);
  });

  it('rejects each invalid field individually', () => {
    const base = {
      accountId: ACCOUNT.id,
      matcherKind: 'from' as const,
      matcherValue: 'x@y',
      bucket: 'auto_handled' as const,
      action: 'archive' as const,
      source: 'on_demand' as const,
    };
    expect(handleCreateRule(deps, { ...base, accountId: '' }).status).toBe(400);
    expect(handleCreateRule(deps, { ...base, matcherKind: 'wat' as never }).status).toBe(400);
    expect(handleCreateRule(deps, { ...base, matcherValue: '   ' }).status).toBe(400);
    expect(handleCreateRule(deps, { ...base, bucket: 'draft_ready' as never }).status).toBe(400);
    expect(handleCreateRule(deps, { ...base, action: 'nuke' as never }).status).toBe(400);
    expect(handleCreateRule(deps, { ...base, source: 'gut_feeling' as never }).status).toBe(400);
  });
});
