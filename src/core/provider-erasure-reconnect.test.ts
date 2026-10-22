import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { RunHistory } from './run-history.js';
import { AuditLog } from './audit-log.js';
import { CP_ADMIN_PRINCIPAL, OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import * as erasure from './connection-erasure.js';

/**
 * Who may cancel a provider's erasure still held, what each cancel writes to the audit log, when
 * an owner's delete supersedes it, and which erasures the owner is told about on the profile.
 *
 * A new consent cancels when its actor is the owner, or the mandate that connected the refused
 * grant (the same address and the same mandate). The owner's consent ends every held erasure of
 * the connection; a mandate's only the one of the grant it replaces. A lift (the same grant works
 * again) cancels whoever saves. A delete supersedes only when the owner's own record is an erasure.
 */

const DAY = 24 * 3600 * 1000;
const T0 = new Date(Date.now() - DAY);
const profile = (): ApiProfile => ({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
const mandate = (email: string, mandateId: string): RequestPrincipal => ({ kind: 'mandate', email, mandateId });
const HELPER = mandate('helper@example.com', 'm-1');

let dir: string;
let db: EngineDb;
let conn: ConnectionStore;
let store: ApiStore;
let history: RunHistory;
let restore: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-provider-reconnect-'));
  db = new EngineDb(join(dir, 'engine.db'));
  conn = new ConnectionStore(db);
  store = new ApiStore();
  store.loadFromConnections(conn);
  store.setConnectionStore(conn);
  store.setGrantLedger(new GrantLedger(db.getDb()));
  store.setAuditLog(new AuditLog(db.getDb()));
  history = new RunHistory(join(dir, 'history.db'));
  restore = [erasure.setProviderErasureForTests(true), erasure.setErasureOnDeleteForTests(true)];
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  history.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const markRevoked = (at: Date = T0): string => store.markRevokedWithRecord('shop', 'fp-refused', at, true);
const grantOf = (): string => store.get('shop')!.oauth_grant!.grant_id!;
/** What the OAuth callback saves: a new grant naming the session that connected (http-api.ts). */
const reconnectAs = (actor: RequestPrincipal | undefined): string => {
  const current = store.get('shop')!;
  const grant = actor?.kind === 'mandate'
    ? { connected_by: `mandate:${actor.email}`, connected_mandate_id: actor.mandateId, state: 'connected' as const }
    : { connected_by: 'owner', state: 'connected' as const };
  expect(store.save({ ...current, oauth_grant: grant }, undefined, { newConsent: true, actor }).ok).toBe(true);
  return grantOf();
};
const providerRecords = (): readonly erasure.StoredConnectionRecord[] => erasure.erasureRecords(db.getDb(), 'shop').filter((r) => r.cause === 'provider_revoked');
const stateOf = (grant: string): string | undefined => providerRecords().find((r) => r.revokedGrant === grant)?.historyState;
interface AuditRow { actor_kind: string; actor_email: string | null; mandate_id: string | null; target: string; phase: string; correlation_id: string }
const cancelRows = (): AuditRow[] => db.getDb().prepare("SELECT actor_kind, actor_email, mandate_id, target, phase, correlation_id FROM audit_log WHERE action = 'connection.erasure.cancel' ORDER BY id").all() as AuditRow[];
const notices = (now: Date): readonly erasure.ProviderNotice[] => erasure.providerNotices(db.getDb(), now, (id) => {
  const g = store.get(id)?.oauth_grant;
  return g === undefined ? undefined : { grantId: g.grant_id, revoked: g.state === 'revoked' };
});

describe('who may cancel by a new consent', () => {
  it('the owner on a grant a mandate connected cancels', () => {
    store.save(profile());
    const b = reconnectAs(HELPER);
    markRevoked();
    reconnectAs(OWNER_PRINCIPAL);
    expect(stateOf(b)).toBe('cancelled');
  });

  it('a mandate on the owner\'s grant does not cancel, and its audit trail stays empty', () => {
    store.save(profile());
    const a = grantOf();
    markRevoked();
    reconnectAs(HELPER);
    expect(stateOf(a)).toBe('pending');
    expect(cancelRows()).toEqual([]);
  });

  it('a mandate on a grant it connected itself cancels', () => {
    store.save(profile());
    const b = reconnectAs(HELPER);
    markRevoked();
    reconnectAs(HELPER);
    expect(stateOf(b)).toBe('cancelled');
  });

  it('a later mandate for the same address is another mandate: it does not cancel', () => {
    store.save(profile());
    const b = reconnectAs(HELPER);
    markRevoked();
    reconnectAs(mandate('helper@example.com', 'm-2'));
    expect(stateOf(b)).toBe('pending');
  });

  it('a consent saved without an actor cancels nothing', () => {
    store.save(profile());
    const a = grantOf();
    markRevoked();
    reconnectAs(undefined);
    expect(stateOf(a)).toBe('pending');
  });

  it('a mandate\'s consent cancels only the erasure of the grant it replaces; the owner\'s held one stays', () => {
    store.save(profile());
    const a = grantOf();
    markRevoked();
    const b = reconnectAs(HELPER);
    expect(stateOf(a)).toBe('pending');
    markRevoked();
    reconnectAs(HELPER);
    expect(stateOf(b)).toBe('cancelled');
    expect(stateOf(a)).toBe('pending');
    // The owner's consent ends what is still held.
    reconnectAs(OWNER_PRINCIPAL);
    expect(stateOf(a)).toBe('cancelled');
  });

  it('the rule itself: owner yes; the connecting mandate yes; another mandate, the control plane, no actor: no', () => {
    const byHelper = { connected_by: 'mandate:helper@example.com', connected_mandate_id: 'm-1' };
    expect(erasure.mayCancelProviderErasure(OWNER_PRINCIPAL, byHelper)).toBe(true);
    expect(erasure.mayCancelProviderErasure(HELPER, byHelper)).toBe(true);
    expect(erasure.mayCancelProviderErasure(mandate('helper@example.com', 'm-2'), byHelper)).toBe(false);
    expect(erasure.mayCancelProviderErasure(mandate('other@example.com', 'm-1'), byHelper)).toBe(false);
    expect(erasure.mayCancelProviderErasure({ kind: 'mandate', email: 'helper@example.com' }, byHelper)).toBe(false);
    expect(erasure.mayCancelProviderErasure(CP_ADMIN_PRINCIPAL, byHelper)).toBe(false);
    expect(erasure.mayCancelProviderErasure(undefined, byHelper)).toBe(false);
    // A grant that names no connecter is the owner's.
    expect(erasure.mayCancelProviderErasure(HELPER, {})).toBe(false);
    expect(erasure.mayCancelProviderErasure(OWNER_PRINCIPAL, undefined)).toBe(true);
  });
});

describe('every cancel writes an audit row naming its actor and reason', () => {
  it('the owner\'s consent', () => {
    store.save(profile());
    markRevoked();
    reconnectAs(OWNER_PRINCIPAL);
    const id = providerRecords()[0]!.id;
    expect(cancelRows()).toEqual([{ actor_kind: 'owner', actor_email: null, mandate_id: null, target: `shop ${id} consent`, phase: 'done', correlation_id: `connection-erasure-${id}` }]);
  });

  it('a mandate\'s consent names the mandate', () => {
    store.save(profile());
    reconnectAs(HELPER);
    markRevoked();
    reconnectAs(HELPER);
    const id = providerRecords()[0]!.id;
    expect(cancelRows()).toEqual([{ actor_kind: 'mandate', actor_email: 'helper@example.com', mandate_id: 'm-1', target: `shop ${id} consent`, phase: 'done', correlation_id: `connection-erasure-${id}` }]);
  });

  it('a lift names whoever saved it', () => {
    store.save(profile());
    markRevoked();
    const current = store.get('shop')!;
    const grant = { ...current.oauth_grant };
    delete grant.state; delete grant.revoked_fp; delete grant.revoked_at;
    expect(store.save({ ...current, oauth_grant: grant }, undefined, { actor: HELPER }).ok).toBe(true);
    const id = providerRecords()[0]!.id;
    expect(providerRecords()[0]!.historyState).toBe('cancelled');
    expect(cancelRows()).toEqual([{ actor_kind: 'mandate', actor_email: 'helper@example.com', mandate_id: 'm-1', target: `shop ${id} lift`, phase: 'done', correlation_id: `connection-erasure-${id}` }]);
  });

  it('a lift saved without an actor cancels nothing', () => {
    store.save(profile());
    markRevoked();
    const current = store.get('shop')!;
    const grant = { ...current.oauth_grant };
    delete grant.state; delete grant.revoked_fp; delete grant.revoked_at;
    expect(store.save({ ...current, oauth_grant: grant }).ok).toBe(true);
    expect(providerRecords()[0]!.historyState).toBe('pending');
  });

  it('the owner\'s erasure delete names the owner', () => {
    store.save(profile());
    markRevoked();
    const id = providerRecords()[0]!.id;
    expect(store.remove('shop', undefined, { record: 'erasure' })).toBe(true);
    expect(cancelRows()).toEqual([{ actor_kind: 'owner', actor_email: null, mandate_id: null, target: `shop ${id} owner_delete`, phase: 'done', correlation_id: `connection-erasure-${id}` }]);
  });

  it('a cancel whose audit row cannot be written does not happen', () => {
    store.save(profile());
    const a = grantOf();
    markRevoked();
    db.getDb().exec("CREATE TRIGGER no_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect(() => reconnectAs(OWNER_PRINCIPAL)).toThrow();
    expect(stateOf(a)).toBe('pending');
    expect(grantOf()).toBe(a);
  });
});

describe('an owner\'s delete supersedes a held provider erasure only with an erasure of its own', () => {
  it('a closing delete (the settings route) leaves the provider erasure held, and it erases after the hold', () => {
    store.save(profile());
    const a = grantOf();
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    history.insertToolCall({ runId: run, toolName: 'http_request', inputJson: '{}', outputJson: '', durationMs: 1, sequenceOrder: 0, connectionId: 'shop', grantId: a });
    history.updateRun(run, { status: 'completed' });
    markRevoked();
    expect(store.remove('shop', undefined, { record: 'closing' })).toBe(true);
    expect(stateOf(a)).toBe('pending');
    expect(cancelRows()).toEqual([]);
    erasure.runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(T0.getTime() + erasure.PROVIDER_HOLD_MS));
    const left = (history.getDb().prepare('SELECT COUNT(*) AS n FROM run_tool_calls WHERE grant_id = ?').get(a) as { n: number }).n;
    expect(left).toBe(0);
  });

  it('an erasure delete cancels it', () => {
    store.save(profile());
    const a = grantOf();
    markRevoked();
    store.remove('shop', undefined, { record: 'erasure' });
    expect(stateOf(a)).toBe('cancelled');
  });
});

describe('the erasures the owner is told about', () => {
  const at = (ms: number): Date => new Date(T0.getTime() + ms);

  it('a held erasure of the refused grant: told, with its hold and deadline', () => {
    store.save(profile());
    markRevoked();
    const r = providerRecords()[0]!;
    expect(notices(at(DAY))).toEqual([{ recordId: r.id, connectionId: 'shop', holdUntil: r.holdUntil, deadline: r.deadline }]);
  });

  it('also between the end of the hold and the deadline, and no longer after it', () => {
    store.save(profile());
    markRevoked();
    expect(notices(at(erasure.PROVIDER_HOLD_MS + DAY))).toHaveLength(1);
    expect(notices(at(erasure.ERASURE_DEADLINE_MS))).toEqual([]);
  });

  it('after a reconnect inside the hold: none (cancelled)', () => {
    store.save(profile());
    markRevoked();
    reconnectAs(OWNER_PRINCIPAL);
    expect(notices(at(DAY))).toEqual([]);
  });

  it('after a reconnect past the hold, which does not cancel: none, the profile is connected again', () => {
    store.save(profile());
    const past = new Date(Date.now() - 20 * DAY);
    markRevoked(past);
    expect(notices(new Date())).toHaveLength(1);
    reconnectAs(OWNER_PRINCIPAL);
    expect(providerRecords()[0]!.historyState).toBe('pending');
    expect(notices(new Date())).toEqual([]);
  });

  it('after a mandate\'s reconnect that may not cancel: none, the profile is connected again', () => {
    store.save(profile());
    markRevoked();
    reconnectAs(HELPER);
    expect(providerRecords()[0]!.historyState).toBe('pending');
    expect(notices(at(DAY))).toEqual([]);
  });

  it('a profile stored again under the same id shows nothing of the earlier record', () => {
    store.save(profile());
    markRevoked();
    store.remove('shop', undefined, { record: 'closing' });
    store.save(profile());
    expect(notices(at(DAY))).toEqual([]);
  });

  it('a later refusal of a newer grant: only its own erasure is told', () => {
    store.save(profile());
    markRevoked();
    const b = reconnectAs(HELPER);
    markRevoked();
    const told = notices(at(DAY));
    expect(told).toHaveLength(1);
    expect(told[0]!.recordId).toBe(providerRecords().find((r) => r.revokedGrant === b)!.id);
  });

  it('a closing record (the switch off) is never told', () => {
    restore.push(erasure.setProviderErasureForTests(false));
    store.save(profile());
    expect(markRevoked()).toBe('closing');
    expect(notices(at(DAY))).toEqual([]);
  });
});
