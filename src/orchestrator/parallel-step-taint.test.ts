import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../core/agent.js';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore } from '../core/subject-store.js';
import { KnowledgeStore } from '../core/knowledge-store.js';
import { createToolContext } from '../core/tool-context.js';
import { rememberTool } from '../tools/builtin/knowledge.js';
import { createStepStreamHandler, newRunTaint, noteStepTaintLive, runTaintArmed } from './runtime-adapter.js';

/**
 * DEF-parallel-step-taint-not-armed — the SEMANTIC half of the fix, on REAL
 * agents and a REAL store (no LLM: the agents never send; the chain is driven
 * through the same functions the adapter wires).
 *
 * The store-then-recall chain: same-phase parallel siblings A and B; A reads
 * external content and parks it in the shared memory, B recalls it and makes a
 * durable write. B spawned clean (the phase was clean at spawn), so without
 * mid-run arming its write lands ACTIVE. The adapter's wiring half — that
 * spawnInline/spawnViaAgent register live peers and route tool events into
 * noteStepTaintLive — is pinned by runtime-adapter.test.ts (mocked agents);
 * this file pins that the arming actually flips a real durable write to
 * `pending_review` on a real Agent's real latch.
 */
describe('parallel-step taint — real agents, real store', () => {
  const tmpDirs: string[] = [];

  function makeRealPair(): { a: Agent; b: Agent; ks: KnowledgeStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ptaint-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const ks = new KnowledgeStore(engine, new SubjectStore(engine));
    const ctx = createToolContext({} as never);
    ctx.knowledgeStore = ks;
    const a = new Agent({ name: 'step-a', model: 'claude-haiku-4-5-20251001' });
    const b = new Agent({
      name: 'step-b',
      model: 'claude-haiku-4-5-20251001',
      toolContext: ctx,
      durableMemoryEnabled: true,
    });
    return { a, b, ks };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('sibling A\'s mid-run external read routes sibling B\'s durable write to pending_review', async () => {
    const { a, b, ks } = makeRealPair();
    const taint = newRunTaint();
    // What the spawners do at spawn time (pinned in runtime-adapter.test.ts):
    // register both live, wire A's stream handler to the mid-run fold.
    (taint.live ??= new Set()).add(a).add(b);
    const handlerA = createStepStreamHandler({
      onTokens: () => {},
      onToolActivity: () => noteStepTaintLive(taint, a),
    });

    // B spawned clean — before A's read, B's latch is genuinely unarmed.
    expect(b.conversationSawUntrusted).toBe(false);

    // A ingests wrapped external content mid-run; its tool_result event fires.
    a.noteUntrustedData();
    handlerA({ type: 'tool_result', name: 'http_request', result: 'external payload', agent: 'step-a' });

    // The accumulator armed AND the push reached B's REAL sticky latch…
    expect(runTaintArmed(taint)).toBe(true);
    expect(b.conversationSawUntrusted).toBe(true);

    // …so B's durable write — still mid-run, same phase — queues for review.
    const out = await rememberTool.handler({ text: 'ACME payment target is 30 days', subject: 'ACME' }, b);
    expect(out).toContain('review');
    expect(ks.pendingCount()).toBe(1);
    expect(ks.recall({ query: 'payment target', subjectName: 'ACME' }).length).toBe(0);
  });

  it('Gegenrichtung: a fully-internal phase still records directly (no arming, write stays active)', async () => {
    const { b, ks } = makeRealPair();
    const taint = newRunTaint();
    (taint.live ??= new Set()).add(b);
    // No sibling reads anything external — no tool event carries taint.
    expect(runTaintArmed(taint)).toBe(false);
    const out = await rememberTool.handler({ text: 'ACME payment target is 30 days', subject: 'ACME' }, b);
    expect(out).toContain('Remembered');
    expect(ks.pendingCount()).toBe(0);
    expect(ks.recall({ query: 'payment target', subjectName: 'ACME' }).length).toBe(1);
  });
});
