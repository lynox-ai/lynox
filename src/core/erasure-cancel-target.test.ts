import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { AuditLog } from './audit-log.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import * as erasure from './connection-erasure.js';

/**
 * What the audit row of a cancelled provider erasure names the profile by. The slug is the
 * model's choice and can name a client, so every row names the opaque id (`connections.trail_id`)
 * instead, whoever cancels. The owner reads the slug back through the record id.
 */

const SLUG = 'mueller-crm';
const profile = (): ApiProfile => ({ id: SLUG, name: 'Mueller CRM', base_url: 'https://crm.example', description: 'd', auth: { type: 'bearer', vault_keys: ['CRM_KEY'] } });
const HELPER: RequestPrincipal = { kind: 'mandate', email: 'helper@example.com', mandateId: 'm-1' };

let dir: string;
let db: EngineDb;
let store: ApiStore;
let restore: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-cancel-target-'));
  db = new EngineDb(join(dir, 'engine.db'));
  const conn = new ConnectionStore(db);
  store = new ApiStore();
  store.loadFromConnections(conn);
  store.setConnectionStore(conn);
  store.setGrantLedger(new GrantLedger(db.getDb()));
  store.setAuditLog(new AuditLog(db.getDb()));
  restore = [erasure.setProviderErasureForTests(true), erasure.setErasureOnDeleteForTests(true)];
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const markRevoked = (fp: string): string => store.markRevokedWithRecord(SLUG, fp, new Date(Date.now() - 1000), true);
const reconnectAs = (actor: RequestPrincipal): void => {
  const current = store.get(SLUG)!;
  const grant = { connected_by: `mandate:${HELPER.email}`, connected_mandate_id: HELPER.mandateId, state: 'connected' as const };
  expect(store.save({ ...current, oauth_grant: grant }, undefined, { newConsent: true, actor }).ok).toBe(true);
};
const liftAs = (actor: RequestPrincipal): void => {
  const current = store.get(SLUG)!;
  const grant = { ...current.oauth_grant };
  delete grant.state; delete grant.revoked_fp; delete grant.revoked_at;
  expect(store.save({ ...current, oauth_grant: grant }, undefined, { actor }).ok).toBe(true);
};
const cancelTargets = (): string[] => (db.getDb().prepare("SELECT target FROM audit_log WHERE action = 'connection.erasure.cancel' ORDER BY id").all() as Array<{ target: string }>).map((r) => r.target);
const slugOfRecord = (recordId: number): string | undefined => (db.getDb().prepare('SELECT connection_id FROM connection_records WHERE id = ?').get(recordId) as { connection_id: string } | undefined)?.connection_id;

describe('the audit row of a cancelled provider erasure names the opaque id, never the slug', () => {
  it('a consent, a lift and an owner\'s delete each write a row, and none of them carries the slug', () => {
    store.save(profile());
    reconnectAs(HELPER);
    const trail = store.trailIdOf(SLUG)!;
    expect(trail).toMatch(/^apf_[0-9a-f]{16}$/);
    markRevoked('fp-1');
    reconnectAs(HELPER); // consent, by the mandate that connected the refused grant
    markRevoked('fp-2');
    liftAs(HELPER); // lift, the same grant works again
    markRevoked('fp-3');
    expect(store.remove(SLUG, undefined, { record: 'erasure' })).toBe(true); // owner's delete supersedes

    const targets = cancelTargets();
    // Positive control: every cancel wrote its row, so an empty set below is not a pass.
    expect(targets.map((t) => t.split(' ')[2])).toEqual(['consent', 'lift', 'owner_delete']);
    for (const t of targets) {
      expect(t).not.toContain(SLUG);
      expect(t).not.toContain('mueller');
      expect(t.split(' ')[0]).toBe(trail);
    }
    // The owner reads the slug back through the record id, also once the profile is deleted.
    expect(store.get(SLUG)).toBeUndefined();
    for (const t of targets) expect(slugOfRecord(Number(t.split(' ')[1]))).toBe(SLUG);
  });

  it('an owner\'s delete reads the id before the row goes: the row names apf_, not api', () => {
    store.save(profile());
    const trail = store.trailIdOf(SLUG)!;
    markRevoked('fp-1');
    const recordId = erasure.erasureRecords(db.getDb(), SLUG).find((r) => r.cause === 'provider_revoked')!.id;
    expect(store.remove(SLUG, undefined, { record: 'erasure' })).toBe(true);
    expect(db.getDb().prepare('SELECT COUNT(*) AS n FROM connections WHERE id = ?').get(SLUG)).toEqual({ n: 0 });
    expect(cancelTargets()).toEqual([`${trail} ${recordId} owner_delete`]);
  });

  it('a row without an id is named api, never by its slug', () => {
    store.save(profile());
    markRevoked('fp-1');
    db.getDb().prepare('UPDATE connections SET trail_id = NULL WHERE id = ?').run(SLUG);
    const recordId = erasure.erasureRecords(db.getDb(), SLUG).find((r) => r.cause === 'provider_revoked')!.id;
    // The owner's route cancels one held record; it calls the writer the same way.
    const handle = db.getDb();
    handle.transaction(() => {
      expect(erasure.cancelProviderRecord(handle, recordId, new Date())).toBe('cancelled');
      erasure.auditProviderCancels(new AuditLog(handle), handle, OWNER_PRINCIPAL, [recordId], 'owner');
    })();
    expect(cancelTargets()).toEqual([`api ${recordId} owner`]);
  });

  it('a connection of another kind that took the id since is not named as the profile', () => {
    store.save(profile());
    markRevoked('fp-1');
    const recordId = erasure.erasureRecords(db.getDb(), SLUG).find((r) => r.cause === 'provider_revoked')!.id;
    // A closing delete leaves the provider's erasure held; another kind of connection takes the id.
    expect(store.remove(SLUG, undefined, { record: 'closing' })).toBe(true);
    const foreign = `apf_${'0'.repeat(16)}`;
    db.getDb().prepare("INSERT INTO connections (id, kind, name, config_json, trail_id) VALUES (?, 'mail', 'Mail', '{}', ?)").run(SLUG, foreign);
    const handle = db.getDb();
    handle.transaction(() => {
      expect(erasure.cancelProviderRecord(handle, recordId, new Date())).toBe('cancelled');
      erasure.auditProviderCancels(new AuditLog(handle), handle, OWNER_PRINCIPAL, [recordId], 'owner');
    })();
    expect(cancelTargets()).toEqual([`api ${recordId} owner`]);
  });
});
