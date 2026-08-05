/**
 * Recall fitness — does a fact that WAS recorded come back when it is needed?
 *
 * WHY THIS EXISTS. The capture-fitness eval (`capture-fitness-runner.mjs`) measures the write
 * half and stops there. It cannot see the failure this file measures: an entry that landed
 * `active`, is not pinned, and is therefore absent from every turn's automatic context. The
 * canary's "memory feels empty" is compatible with a store that has the fact — so the write
 * number alone was never enough to answer it.
 *
 * WHAT IT SEPARATES, and why the split is the whole point. DK has TWO recall surfaces:
 *   - the AUTOMATIC block (`renderBlocks`) — assembled by the engine every turn, no model
 *     decision involved. `session.ts:851`.
 *   - the TOOL (`recall`) — reached only if the model decides to call it.
 * The same eval that measured capture also measured that this model class initiates a memory
 * tool on a minority of the turns where it should. Anything that only the TOOL can reach is
 * therefore reachable in principle and missing in practice, and a number that merges the two
 * surfaces hides exactly that.
 *
 * NO MODEL RUNS HERE, deliberately. Both surfaces are pure store functions over a real
 * `engine.db`, so this is deterministic, free, and CI-able — unlike the capture eval, which
 * needs a live engine and a provider key. What it therefore cannot tell you: whether the model
 * USES what the automatic block handed it, or whether it calls the tool. Those stay with the
 * live-engine eval.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from '../../src/core/engine-db.js';
import { SubjectStore } from '../../src/core/subject-store.js';
import { KnowledgeStore } from '../../src/core/knowledge-store.js';

/** One recorded fact plus the way an operator would actually ask for it back. */
interface RecallCase {
  readonly id: string;
  /** The fact, as the model would `remember` it. */
  readonly text: string;
  /** The `subject` the model passes — a full legal name, which is what it reads off a briefing. */
  readonly subject: string;
  /** `pin: true` is documented as "only for the few facts you want in EVERY future turn". */
  readonly pinned: boolean;
  /** How the operator refers to the subject when they ask. Short form is the realistic case. */
  readonly query: string;
  /** A distinctive token of the fact — its presence in the rendered block is the hit test. */
  readonly needle: string;
}

const CASES: readonly RecallCase[] = [
  {
    id: 'short-name-pinned',
    text: 'Nordfeld GmbH ist Maschinenbau-Kunde seit 2023, Managed-Tarif, zahlt jährlich im Voraus. Ansprechpartnerin: Dr. Amrein.',
    subject: 'Nordfeld GmbH', pinned: true,
    query: 'Was weisst du über den Kunden Nordfeld? Wer ist dort meine Ansprechpartnerin?',
    needle: 'Amrein',
  },
  {
    id: 'full-name-pinned',
    text: 'Nordfeld GmbH ist Maschinenbau-Kunde seit 2023, Managed-Tarif, zahlt jährlich im Voraus. Ansprechpartnerin: Dr. Amrein.',
    subject: 'Nordfeld GmbH', pinned: true,
    query: 'Erzähl mir was über Nordfeld GmbH.',
    needle: 'Amrein',
  },
  {
    id: 'full-name-unpinned',
    text: 'Projekt Aurora: Auftraggeber Stadtwerke Lindau, Laufzeit bis März, technische Ansprechpartnerin Frau Bregenz.',
    subject: 'Aurora', pinned: false,
    query: 'Wie ist der Stand bei Aurora?',
    needle: 'Bregenz',
  },
  {
    id: 'no-subject-named',
    text: 'Seewald ist eine Anwaltskanzlei mit acht Personen, nutzt uns für die Mandatsablage.',
    subject: 'Seewald', pinned: true,
    query: 'Was läuft aktuell bei unseren Kunden?',
    needle: 'Mandatsablage',
  },
];

describe('recall fitness — the automatic surface vs the tool surface', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function seeded(): { ks: KnowledgeStore; subjects: SubjectStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-recall-fitness-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const subjects = new SubjectStore(engine);
    const ks = new KnowledgeStore(engine, subjects);
    for (const c of CASES) {
      // The real write path, on the provenance a clean conversational turn produces:
      // channel `agent` (a model-authored `remember`), not untrusted → lands `active`.
      ks.write({ text: c.text, subjectName: c.subject, sourceChannel: 'agent', sourceUntrusted: false, pin: c.pinned });
    }
    return { ks, subjects };
  }

  it('reports both surfaces per case', () => {
    const { ks } = seeded();
    const rows = CASES.map(c => {
      const block = ks.renderBlocks({ turnText: c.query });
      const hits = ks.recall({ query: c.query, limit: 8 });
      return {
        id: c.id,
        auto: block.includes(c.needle),
        tool: hits.some(h => h.text.includes(c.needle)),
      };
    });
    const auto = rows.filter(r => r.auto).length;
    const tool = rows.filter(r => r.tool).length;

    const lines = rows.map(r => `  ${r.id.padEnd(22)} auto ${r.auto ? 'HIT ' : 'miss'}   tool ${r.tool ? 'HIT' : 'miss'}`);
    console.log(
      `\n=== recall fitness ===\n${lines.join('\n')}\n`
      + `  ${'—'.repeat(46)}\n`
      + `  automatic (every turn, no model decision)  ${auto}/${rows.length}\n`
      + `  tool (only if the model calls recall)      ${tool}/${rows.length}\n`,
    );

    // The tool surface is the one the architecture leans on, so it is the one held to an
    // invariant: every recorded fact must be reachable by a query that names it.
    expect(tool).toBe(rows.length);
    // The automatic surface is NOT asserted at a rate — it is deliberately narrow (pinned
    // entries of a subject named in the turn), and pinning that down as a number would freeze
    // today's gap into a passing test. The console split above is the signal.
  });

  it('the automatic block renders a pinned fact when the subject is named EXACTLY', () => {
    const { ks } = seeded();
    const block = ks.renderBlocks({ turnText: 'Erzähl mir was über Nordfeld GmbH.' });
    expect(block).toContain('Nordfeld GmbH');
    expect(block).toContain('Amrein');
  });

  it('the automatic block reaches the pinned fact under the SHORT name', () => {
    const { ks } = seeded();
    const block = ks.renderBlocks({ turnText: 'Was weisst du über den Kunden Nordfeld?' });
    expect(block).toContain('Amrein');
  });

  it('the recall TOOL finds the fact when the model passes the short name as `subject`', () => {
    // The live failure, 2026-08-05: Sonnet called recall({subject: "Nordfeld"}) — the argument
    // the DK prompt tells it to pass — and the store answered "no matching durable knowledge"
    // on a store that held the fact. Passing the subject was strictly worse than omitting it.
    const { ks } = seeded();
    const q = 'Nordfeld Kunde Ansprechpartnerin';
    expect(ks.recall({ query: q, subjectName: 'Nordfeld' }).some(h => h.text.includes('Amrein'))).toBe(true);
    // …and the exact form keeps working, i.e. the wide matcher did not displace the exact one.
    expect(ks.recall({ query: q, subjectName: 'Nordfeld GmbH' }).some(h => h.text.includes('Amrein'))).toBe(true);
  });

  it('does not run the short-form scan when an exact name already resolved', () => {
    // A cost claim, not a behaviour one — which is why it needs its own assert. The short-form
    // lookup scans the whole kind+owner range and folds in JS (the same deliberate non-indexed
    // scan `findByAliasResolved` documents as 1.2-3.2x slower, growing with subject count).
    // Running it after an exact hit changes no answer, so no output-shaped test can see it.
    const { ks, subjects } = seeded();
    let calls = 0;
    const real = subjects.findByShortFormResolved.bind(subjects);
    subjects.findByShortFormResolved = (...args: Parameters<typeof real>) => { calls++; return real(...args); };
    expect(ks.recall({ query: 'Ansprechpartnerin', subjectName: 'Nordfeld GmbH' }).length).toBeGreaterThan(0);
    expect(calls).toBe(0);
    ks.recall({ query: 'Ansprechpartnerin', subjectName: 'Nordfeld' });
    expect(calls).toBe(1);
  });

  it('a short name shared by two clients resolves to NEITHER, on both surfaces', () => {
    // The direction that makes the fix dangerous if it is built as a plain widening: the
    // operator has two clients whose names differ only in legal form. "Nordfeld" names neither,
    // and answering out of either one puts one client's facts under the other client's name.
    const { ks } = seeded();
    ks.write({
      text: 'Nordfeld AG ist ein Zulieferer, Zahlungsziel 60 Tage.',
      subjectName: 'Nordfeld AG', sourceChannel: 'agent', sourceUntrusted: false, pin: true,
    });
    const block = ks.renderBlocks({ turnText: 'Was weisst du über den Kunden Nordfeld?' });
    expect(block).not.toContain('Amrein');
    expect(block).not.toContain('Zahlungsziel');
    expect(ks.recall({ query: 'Nordfeld', subjectName: 'Nordfeld' })).toHaveLength(0);
    // The full name still reaches its own client — only the abbreviation is withheld.
    const exact = ks.renderBlocks({ turnText: 'Was weisst du über Nordfeld GmbH?' });
    expect(exact).toContain('Amrein');
    expect(exact).not.toContain('Zahlungsziel');
  });

  it('an ambiguous short form does not fall THROUGH into the person namespace', () => {
    // The failure the ambiguity guard in `_resolveRecallScope` exists for, and the only shape
    // under which it is observable — the stages ahead of it already answer the simpler ones.
    // A canonical person of that name deliberately WINS (an existing, documented preference),
    // so the guard only bites when the person match is by ALIAS, which runs after this stage:
    // two orgs sharing a short form plus a person aliased to it. Without the guard, an
    // organisation-scoped question is answered out of a person's entries.
    const { ks, subjects } = seeded();
    ks.write({
      text: 'Nordfeld AG ist ein Zulieferer, Zahlungsziel 60 Tage.',
      subjectName: 'Nordfeld AG', sourceChannel: 'agent', sourceUntrusted: false,
    });
    const advisor = subjects.createSubject({
      kind: 'person', name: 'Konrad Steiner', aliases: ['Konrad Steiner', 'Nordfeld'],
    });
    ks.write({
      text: 'Konrad Steiner ist unser Steuerberater, erreichbar dienstags.',
      subjectName: 'Konrad Steiner', subjectKind: 'person',
      sourceChannel: 'agent', sourceUntrusted: false,
    });
    expect(subjects.findByAlias('Nordfeld', 'person')?.id).toBe(advisor);
    expect(ks.recall({ query: 'Nordfeld', subjectName: 'Nordfeld' })).toHaveLength(0);
  });

  it('the automatic block skips an UNPINNED fact even when its subject is named exactly', () => {
    const { ks } = seeded();
    const block = ks.renderBlocks({ turnText: 'Wie ist der Stand bei Aurora?' });
    // The subject card renders — so the miss is not a resolution failure…
    expect(block).toContain('Aurora');
    // …the card carries only pinned entries (`_renderSubjectCard`), and this one is not pinned.
    expect(block).not.toContain('Bregenz');
  });
});
