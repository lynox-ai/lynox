import { describe, it, expect, vi } from 'vitest';
import { WorkerLoop } from './worker-loop.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';
import { BULK_NOTICES } from './bulk-notices.js';
import type { Engine } from './engine.js';
import type { NotificationMessage, NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';

// A halted bulk run's end goes to three readers: the run's history, which a mandate reads too;
// the owner's devices; and the devices of the grant that planned the run. Where the halt's way on
// is the owner's alone, each reads its own sentence (U-383); every other halt stays one push to
// every device, as before.
const R = BULK_HALT_REASONS;
const CLOSING = 'Lösen kann das nur der Inhaber.';

function harness(opts: { reason: string; plannedBy: 'owner' | 'mandate' | 'mandate-without-grant'; live?: boolean }) {
  const recorded: string[] = [];
  const sent: NotificationMessage[] = [];
  const planner = opts.plannedBy === 'mandate' ? { kind: 'mandate', mandateId: 'grant-1' }
    // A run a mandate planned before the ledger kept its grant: the planner names no grant.
    : opts.plannedBy === 'mandate-without-grant' ? { kind: 'mandate', email: 'member@example.invalid' } : null;
  const engine = {
    config: { language: 'de' },
    getTaskManager: vi.fn(() => ({ recordTaskRun: vi.fn((_id: string, result: string) => { recorded.push(result); return true; }) })),
    getBulkLedger: vi.fn(() => ({
      getRunForApply: vi.fn(() => ({ phase: 'approved', haltReason: opts.reason, targetSystem: 'api:acme.myshopify.com', delegatedPlanner: planner })),
    })),
    getMandateEnds: vi.fn(() => ({ isLive: (id: string) => id === 'grant-1' && (opts.live ?? true) })),
  } as unknown as Engine;
  const router = {
    hasChannels: vi.fn(() => true),
    notify: vi.fn(async (m: NotificationMessage) => { sent.push(m); }),
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  const task = { id: 't-1', title: 'Bulk apply run-1', effect: 'bulk_apply', bulk_run_id: 'run-1' } as unknown as TriggerRecord;
  const end = (summary: string, said?: string): void => {
    (loop as unknown as { recordAndNotify: (t: TriggerRecord, s: string, e: boolean, said?: string) => void }).recordAndNotify(task, summary, false, said);
  };
  return { recorded, sent, end };
}

const COUNTS = ' 2 von 5 Zielen geschrieben.';

describe('a halted bulk run\'s end, as each reader gets it (U-383)', () => {
  it('records only the fact, pushes the way to the owner\'s devices and the owner to the planning grant\'s', () => {
    const h = harness({ reason: R.storeAccessEnded, plannedBy: 'mandate' });
    const summary = `${BULK_NOTICES.de.halted('apply', R.storeAccessEnded)}${COUNTS}`;
    h.end(summary);
    expect(h.recorded).toEqual([`lynox konnte den Zugang zum Shop nicht erneuern.${COUNTS}`]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ body: summary, audience: 'owner' });
    expect(h.sent[0]!.mandateId).toBeUndefined();
    expect(h.sent[1]).toMatchObject({ body: `lynox konnte den Zugang zum Shop nicht erneuern. ${CLOSING}${COUNTS}`, audience: 'mandates', mandateId: 'grant-1' });
    // Both name the run the same way.
    expect(h.sent[1]!.title).toBe(h.sent[0]!.title);
  });

  it('pushes a product write\'s short form to the owner\'s devices as it is, records the fact, and tells the planning grant the owner resolves it', () => {
    const h = harness({ reason: R.productWriteNotAsked, plannedBy: 'mandate' });
    const summary = BULK_NOTICES.de.productWriteNotAsked('not_asked', true);
    const push = BULK_NOTICES.de.productWriteNotAskedPush('not_asked', true);
    h.end(summary, push);
    expect(h.recorded).toEqual(['lynox hat nichts geschrieben. Diese Shopify-Verbindung darf keine Produkte ändern.']);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ body: push, audience: 'owner' });
    expect(h.sent[1]).toMatchObject({
      body: `lynox hat nichts geschrieben. Beim Verbinden hat lynox Shopify nicht um das Recht gebeten, Produkte zu ändern. ${CLOSING}`,
      audience: 'mandates', mandateId: 'grant-1',
    });
  });

  it('sends no mandate push for a run the owner planned, or whose grant has ended', () => {
    for (const setup of [{ plannedBy: 'owner' as const }, { plannedBy: 'mandate' as const, live: false }]) {
      const h = harness({ reason: R.credential, ...setup });
      h.end(BULK_NOTICES.de.halted('apply', R.credential));
      expect(h.sent.map((m) => m.audience), JSON.stringify(setup)).toEqual(['owner']);
      expect(h.recorded, JSON.stringify(setup)).toEqual(['lynox findet keinen gespeicherten Zugang zum Zielsystem.']);
    }
  });

  it('keeps a halt of a run a mandate planned without a recorded grant one push to every device, recorded as it is', () => {
    const h = harness({ reason: R.storeAccessEnded, plannedBy: 'mandate-without-grant' });
    const summary = `${BULK_NOTICES.de.halted('apply', R.storeAccessEnded)}${COUNTS}`;
    h.end(summary);
    expect(h.recorded).toEqual([summary]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body).toBe(summary);
    expect(h.sent[0]!.audience).toBeUndefined();
  });

  it('keeps every other halt one push to every device, with its sentence recorded as it is', () => {
    const h = harness({ reason: R.listTooLarge, plannedBy: 'mandate' });
    const summary = BULK_NOTICES.de.halted('apply', R.listTooLarge);
    h.end(summary);
    expect(h.recorded).toEqual([summary]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body).toBe(summary);
    expect(h.sent[0]!.audience).toBeUndefined();
  });
});
