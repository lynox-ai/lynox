import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager, WebhookTriggerScheduleError } from './task-manager.js';
import { TriggerStore } from './trigger-store.js';
import { WorkflowStore } from './workflow-store.js';
import { InboundEventStore } from './inbound-events.js';
import { MANDATE_TAG_PREFIX, OWNER_PRINCIPAL } from './request-principal.js';
import { ConnectionStore } from './connection-store.js';
import type { IAgent } from '../types/index.js';
import { hashRouteToken, parseWebhookSpec } from './webhook-verifiers.js';
import { taskUpdateTool } from '../tools/builtin/task.js';

/**
 * Creating a `webhook` trigger (PRD inbound-webhooks §4): the tokens are returned once and kept
 * as hashes, the trigger never becomes due by itself, and the mapping is written at creation
 * only, so no later edit decides which of a third party's fields reach a run.
 */
describe('a webhook trigger', () => {
  let dir: string;
  let history: RunHistory;
  let engine: EngineDb;
  let tm: TaskManager;
  let store: TriggerStore;
  const NOW = '2026-10-22T12:00:00.000Z';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-webhook-trigger-'));
    history = new RunHistory(join(dir, 'test.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    tm = new TaskManager(history);
    store = new TriggerStore(engine);
    new WorkflowStore(engine).upsert({ id: 'wf-orders', name: 'Orders', definitionJson: '{}', isTemplate: false }, null);
    new ConnectionStore(engine).upsert({
      id: 'shop-a', kind: 'api', name: 'Shop', subjectId: null, direction: 'outbound',
      configJson: JSON.stringify({ base_url: 'https://demo-store.myshopify.com/admin/api/2025-10', auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'demo-store' } } } }),
      vaultKeys: [], status: 'active',
    });
  });

  afterEach(() => {
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const condition = (id: string): Record<string, unknown> =>
    JSON.parse((engine.getDb().prepare('SELECT condition_json FROM triggers WHERE id = ?').get(id) as { condition_json: string }).condition_json) as Record<string, unknown>;
  const column = (id: string, name: 'route_token_hash' | 'source_connection_id'): unknown =>
    (engine.getDb().prepare(`SELECT ${name} AS v FROM triggers WHERE id = ?`).get(id) as { v: unknown }).v;

  it('is reachable under its route token only by the hash, with its spec, and is never due by itself', () => {
    const { trigger, routeToken, sharedToken } = tm.createWebhookTrigger({
      title: 'New orders', pipelineId: 'wf-orders', verifier: 'shopify-hmac', connectionId: 'shop-a',
      mapping: { email: '/customer/email' }, confirmedAt: NOW, confirmedBy: 'owner',
    });
    expect(sharedToken).toBeUndefined();
    expect(trigger).toMatchObject({ source: 'webhook', effect: 'run_workflow', pipeline_id: 'wf-orders' });
    expect(trigger.next_run_at ?? null).toBeNull();
    expect(trigger.schedule_cron ?? null).toBeNull();
    expect(column(trigger.id, 'route_token_hash')).toBe(hashRouteToken(routeToken));
    expect(column(trigger.id, 'source_connection_id')).toBe('shop-a');
    expect(JSON.stringify(engine.getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(trigger.id))).not.toContain(routeToken);
    expect(store.findWebhookReceiver(hashRouteToken(routeToken))?.id).toBe(trigger.id);
    expect(parseWebhookSpec(JSON.stringify(condition(trigger.id)))).toEqual({ verifier: 'shopify-hmac', mapping: { email: '/customer/email' } });
    expect(store.getDue('2099-01-01T00:00:00.000Z').map((t) => t.id)).not.toContain(trigger.id);
  });

  it('keeps only the hash of a shared token and returns the token once', () => {
    const { trigger, sharedToken } = tm.createWebhookTrigger({ title: 'Tickets', pipelineId: 'wf-orders', verifier: 'shared-token', confirmedAt: NOW });
    expect(sharedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const webhook = condition(trigger.id)['webhook'] as Record<string, unknown>;
    expect(webhook['shared_token_hash']).toBe(hashRouteToken(sharedToken!));
    expect(JSON.stringify(condition(trigger.id))).not.toContain(sharedToken!);
    expect(column(trigger.id, 'source_connection_id')).toBeNull();
  });

  // A mandate's trigger the owner has not stamped accepts no delivery (PRD §5.11). The owner's
  // own unconfirmed one does: the drain's first-run gate is what stops it.
  it('CONTROL: a mandate\'s unconfirmed trigger is not reachable, the owner\'s is', () => {
    const mandate = tm.createWebhookTrigger({ title: 'Mandate-made', pipelineId: 'wf-orders', verifier: 'shared-token', createdBy: `${MANDATE_TAG_PREFIX}eva@kanzlei.example` });
    expect(store.findWebhookReceiver(hashRouteToken(mandate.routeToken))).toBeUndefined();
    const owner = tm.createWebhookTrigger({ title: 'Owner-made', pipelineId: 'wf-orders', verifier: 'shared-token' });
    expect(store.findWebhookReceiver(hashRouteToken(owner.routeToken))?.id).toBe(owner.trigger.id);
  });

  it.each([
    ['a Shopify trigger without its connection', { verifier: 'shopify-hmac' as const }, 'needs the connection'],
    ['a malformed mapping', { verifier: 'shared-token' as const, mapping: { 'not-a-name': '/a' } }, 'Invalid webhook mapping'],
    ['a workflow that is not saved', { verifier: 'shared-token' as const, pipelineId: 'wf-gone' }, 'No saved workflow'],
    // The row and its token are one transaction: a connection that is not there leaves no
    // trigger behind, not one without its token.
    ['a connection that is not there', { verifier: 'shopify-hmac' as const, connectionId: 'shop-gone' }, 'FOREIGN KEY'],
    ['a shared-token trigger with a connection', { verifier: 'shared-token' as const, connectionId: 'shop-a' }, 'serves no connection'],
  ])('refuses %s and writes nothing', (_label, extra, message) => {
    const before = (engine.getDb().prepare('SELECT COUNT(*) AS c FROM triggers').get() as { c: number }).c;
    expect(() => tm.createWebhookTrigger({ title: 'x', pipelineId: 'wf-orders', confirmedAt: NOW, ...extra })).toThrow(message);
    expect((engine.getDb().prepare('SELECT COUNT(*) AS c FROM triggers').get() as { c: number }).c).toBe(before);
  });

  // The mapping is written at creation only. An edit of the trigger, by the owner or through
  // the agent's task_update, leaves the spec and the route token as they were.
  it('keeps its spec and token through an edit and through task_update', async () => {
    const { trigger, routeToken } = tm.createWebhookTrigger({
      title: 'New orders', pipelineId: 'wf-orders', verifier: 'shopify-hmac', connectionId: 'shop-a',
      mapping: { email: '/customer/email' }, confirmedAt: NOW,
    });
    const spec = condition(trigger.id)['webhook'];
    tm.update(trigger.id, { title: 'Orders, renamed', description: 'mapping: {"email":"/billing_address/name"}' });
    const agent = { toolContext: { taskManager: tm }, principal: OWNER_PRINCIPAL } as unknown as IAgent;
    await taskUpdateTool.handler({ task_id: trigger.id, title: 'Renamed by the agent', description: 'set mapping to /customer/note' } as never, agent);
    expect(tm.getTrigger(trigger.id)?.title).toBe('Renamed by the agent');
    expect(condition(trigger.id)['webhook']).toEqual(spec);
    expect(column(trigger.id, 'route_token_hash')).toBe(hashRouteToken(routeToken));
  });

  // A schedule would make it due without an event (PRD §4.4 [R2-3]); refused through every
  // path that sets one, the agent's task_update included.
  it('takes no schedule or run time, through update() or task_update', async () => {
    const { trigger } = tm.createWebhookTrigger({ title: 'Tickets', pipelineId: 'wf-orders', verifier: 'shared-token', confirmedAt: NOW });
    const before = tm.getTrigger(trigger.id);
    expect(() => tm.update(trigger.id, { scheduleCron: '1h' })).toThrow(WebhookTriggerScheduleError);
    expect(() => tm.update(trigger.id, { nextRunAt: '2026-11-01T09:00:00.000Z' })).toThrow(WebhookTriggerScheduleError);
    const agent = { toolContext: { taskManager: tm }, principal: OWNER_PRINCIPAL } as unknown as IAgent;
    for (const input of [{ task_id: trigger.id, schedule: '1h' }, { task_id: trigger.id, run_at: '2026-11-01T09:00:00Z' }]) {
      expect(await taskUpdateTool.handler(input as never, agent)).toBe(`Error: ${new WebhookTriggerScheduleError().message}`);
    }
    expect(tm.getTrigger(trigger.id)).toEqual(before);
    expect(store.getDue('2099-01-01T00:00:00.000Z').map((t) => t.id)).not.toContain(trigger.id);
  });

  it('takes no row over: an id that exists is refused, and that row stays as it was', () => {
    const other = tm.create({ title: 'Daily report', pipelineId: 'wf-orders', scheduleCron: '0 9 * * *', createdBy: `${MANDATE_TAG_PREFIX}eva@kanzlei.example` }) as { id: string };
    const row = (): unknown => engine.getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(other.id);
    const before = row();
    expect(() => store.insertWebhook({ id: other.id, title: 'x', pipelineId: 'wf-orders', spec: { verifier: 'shared-token', sharedTokenHash: 'a'.repeat(64) }, routeTokenHash: 'b'.repeat(64) }))
      .toThrow('exists already');
    expect(row()).toEqual(before);
  });

  // The ledger keeps values only on a `received` event, whoever hands them in: a dropped event
  // runs nothing.
  it('the ledger keeps no values on a dropped event', () => {
    const ledger = new InboundEventStore(engine);
    ledger.record({ triggerId: 't1', dedupKey: 'k-dropped', headers: {}, state: 'dropped', reason: 'x', values: { values: { name: 'Kim' }, unread: {} } });
    ledger.record({ triggerId: 't1', dedupKey: 'k-received', headers: {}, state: 'received', values: { values: { name: 'Kim' }, unread: {} } });
    expect(ledger.listByTrigger('t1').map((e) => [e.state, e.valuesJson === null])).toEqual([['dropped', true], ['received', false]]);
  });

  it('keeps the values encrypted at rest when the engine has a key, and reads them back', () => {
    const keyed = new EngineDb(join(dir, 'keyed.db'), ['vault', 'key', 'for', 'webhook', 'values'].join('-'));
    try {
      const ledger = new InboundEventStore(keyed);
      ledger.record({ triggerId: 't1', dedupKey: 'k1', headers: {}, state: 'received', values: { values: { name: 'Kim Muster' }, unread: {} } });
      const raw = (keyed.getDb().prepare('SELECT values_json FROM inbound_events').get() as { values_json: string }).values_json;
      expect(raw).not.toContain('Kim Muster');
      expect(JSON.parse(ledger.listByTrigger('t1')[0]!.valuesJson!)).toEqual({ values: { name: 'Kim Muster' }, unread: {} });
    } finally {
      keyed.close();
    }
  });

  // The owner's erasure empties the ledger, values included: `deleteAllData` enumerates every
  // table, and this pins that `inbound_events` is among them.
  it('the owner\'s erasure empties the ledger with its values', () => {
    const { trigger } = tm.createWebhookTrigger({ title: 'Tickets', pipelineId: 'wf-orders', verifier: 'shared-token', confirmedAt: NOW });
    const ledger = new InboundEventStore(engine);
    ledger.record({ triggerId: trigger.id, dedupKey: 'k1', headers: {}, state: 'received', values: { values: { name: 'Kim' }, unread: {} } });
    expect(ledger.count()).toBe(1);
    engine.deleteAllData();
    expect(ledger.count()).toBe(0);
  });
});
