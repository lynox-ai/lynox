import { describe, it, expect, vi } from 'vitest';
import { WorkerLoop } from './worker-loop.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';
import { BULK_NOTICES } from './bulk-notices.js';
import type { Engine } from './engine.js';
import type { NotificationMessage, NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';
import { noteMemberConnection, runCollectingMemberNotes } from './member-connection-notes.js';

// A halted bulk run's end goes to three readers: the run's history, which a mandate reads too;
// the owner's devices; and the devices of every live grant, whoever planned the run (a mandate
// gets the notices the owner gets). Where the halt's way on is the owner's alone, each reads its
// own sentence (U-383); every other halt stays one push to every device, as before.
const R = BULK_HALT_REASONS;
const CLOSING = 'Lösen kann das nur der Inhaber.';

function harness(opts: { reason: string; plannedBy: 'owner' | 'mandate' | 'mandate-without-grant' }) {
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
  it('records only the fact, pushes the way to the owner\'s devices and the owner to every grant\'s', () => {
    const h = harness({ reason: R.storeAccessEnded, plannedBy: 'mandate' });
    const summary = `${BULK_NOTICES.de.halted('apply', R.storeAccessEnded)}${COUNTS}`;
    h.end(summary);
    expect(h.recorded).toEqual([`lynox konnte den Zugang zum Shop nicht erneuern.${COUNTS}`]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ body: summary, audience: 'owner' });
    expect(h.sent[0]!.mandateId).toBeUndefined();
    expect(h.sent[1]).toMatchObject({ body: `lynox konnte den Zugang zum Shop nicht erneuern. ${CLOSING}${COUNTS}`, audience: 'all_mandates' });
    // Every grant, not one: no grant named.
    expect(h.sent[1]!.mandateId).toBeUndefined();
    // Both name the run the same way.
    expect(h.sent[1]!.title).toBe(h.sent[0]!.title);
  });

  it('leaves the owner\'s member-connection lines out of every grant\'s push; the owner\'s push and the history keep them', async () => {
    const h = harness({ reason: R.storeAccessEnded, plannedBy: 'mandate' });
    const summary = `${BULK_NOTICES.de.halted('apply', R.storeAccessEnded)}${COUNTS}`;
    // The owner's wording of a refused member connection: another member's provider and profile,
    // and the owner's way to change it.
    const NOTE = { en: 'Connection not used: CRM was connected by eva@kanzlei.example with her own login. Change it under Settings → APIs.', de: 'Verbindung nicht genutzt: CRM hat eva@kanzlei.example mit ihrem eigenen Login verbunden. Ändern unter Einstellungen → APIs.' };
    await runCollectingMemberNotes(async () => {
      noteMemberConnection('Connection not used: the model\'s line', () => NOTE);
      h.end(summary);
    }).done;
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ audience: 'owner', body: `${summary}\n• ${NOTE.de}` });
    expect(h.sent[1]).toMatchObject({ audience: 'all_mandates', body: `lynox konnte den Zugang zum Shop nicht erneuern. ${CLOSING}${COUNTS}` });
    expect(h.sent[1]!.body).not.toContain('eva@kanzlei.example');
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toContain(NOTE.en);
  });

  it('builds every grant\'s push from the sentence in the owner\'s language, as before the lines were left out', async () => {
    const h = harness({ reason: R.storeAccessEnded, plannedBy: 'mandate' });
    // The stored sentence in English, its version in the owner's German pushed in its place.
    const stored = `${BULK_NOTICES.en.halted('apply', R.storeAccessEnded)} 2 of 5 targets written.`;
    const said = `${BULK_NOTICES.de.halted('apply', R.storeAccessEnded)}${COUNTS}`;
    await runCollectingMemberNotes(async () => {
      noteMemberConnection('Connection not used: the model\'s line', () => ({ en: 'Connection not used: a note.', de: 'Verbindung nicht genutzt: eine Notiz.' }));
      h.end(stored, said);
    }).done;
    expect(h.sent[1]).toMatchObject({ audience: 'all_mandates', body: `lynox konnte den Zugang zum Shop nicht erneuern. ${CLOSING}${COUNTS}` });
  });

  it('pushes a product write\'s short form to the owner\'s devices as it is, records the fact, and tells every grant the owner resolves it', () => {
    const h = harness({ reason: R.productWriteNotAsked, plannedBy: 'mandate' });
    const summary = BULK_NOTICES.de.productWriteNotAsked('not_asked', true);
    const push = BULK_NOTICES.de.productWriteNotAskedPush('not_asked', true);
    h.end(summary, push);
    expect(h.recorded).toEqual(['lynox hat nichts geschrieben. Diese Shopify-Verbindung darf keine Produkte ändern.']);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ body: push, audience: 'owner' });
    expect(h.sent[1]).toMatchObject({
      body: `lynox hat nichts geschrieben. Beim Verbinden hat lynox Shopify nicht um das Recht gebeten, Produkte zu ändern. ${CLOSING}`,
      audience: 'all_mandates',
    });
  });

  // A mandate gets the notices the owner gets: whoever planned the run, every grant reads that
  // the owner resolves it, as the planning grant does.
  it('tells every grant the owner resolves it for a run the owner planned, and for one whose planning grant is not recorded', () => {
    for (const plannedBy of ['owner', 'mandate-without-grant'] as const) {
      const h = harness({ reason: R.credential, plannedBy });
      h.end(BULK_NOTICES.de.halted('apply', R.credential));
      expect(h.sent.map((m) => [m.audience, m.mandateId]), plannedBy).toEqual([['owner', undefined], ['all_mandates', undefined]]);
      expect(h.sent[1]!.body, plannedBy).toBe(`lynox findet keinen gespeicherten Zugang zum Zielsystem. ${CLOSING}`);
      expect(h.recorded, plannedBy).toEqual(['lynox findet keinen gespeicherten Zugang zum Zielsystem.']);
    }
  });

  // A halt whose way is not the owner's alone, ended with the owner's member-connection lines: the
  // lines go to the owner's devices only; every grant reads the halt without them, whoever
  // planned the run (a mandate gets the notices the owner gets).
  it('pushes another halt\'s member-connection lines to the owner\'s devices only, and the halt without them to every grant, whoever planned it', async () => {
    for (const plannedBy of ['mandate', 'owner', 'mandate-without-grant'] as const) {
      const h = harness({ reason: R.listTooLarge, plannedBy });
      const summary = BULK_NOTICES.de.halted('apply', R.listTooLarge);
      const NOTE = { en: 'Connection not used: CRM was connected by eva@kanzlei.example.', de: 'Verbindung nicht genutzt: CRM hat eva@kanzlei.example verbunden.' };
      await runCollectingMemberNotes(async () => {
        noteMemberConnection('Connection not used: the model\'s line', () => NOTE);
        h.end(summary);
      }).done;
      expect(h.sent.map((m) => [m.audience, m.mandateId, m.body]), plannedBy).toEqual([
        ['owner', undefined, `${summary}\n• ${NOTE.de}`],
        ['all_mandates', undefined, summary],
      ]);
    }
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
