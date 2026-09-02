/**
 * The unit test for `probeHostPolicy` proves it THROWS on a broken gate. That
 * is not the property that matters — the property that matters is whether the
 * throw reaches the runner, and it did not.
 *
 * `src/core/agent.ts:3218` catches every tool-handler rejection and renders it
 * as an `is_error` tool_result so the conversation self-recovers. A
 * HarnessInstrumentError raised inside a handler was therefore swallowed by
 * design: the run carried on, `error` stayed undefined, and a case that
 * measured nothing scored as a case that found nothing.
 *
 * This test drives that seam with an Agent stub that behaves the way the real
 * one does — invoke the handler, swallow the rejection, return normally — and
 * asserts that `runCase` still dies. It is the test that would have caught the
 * defect the unit test could not see.
 */
import { describe, it, expect, vi } from 'vitest';

const assertHostPolicy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/core/network-guard.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/network-guard.js')>();
  return { ...actual, assertHostPolicy };
});

interface StubTool { definition: { name: string }; handler: (i: unknown, a: unknown) => unknown }

/** Stands in for the real agent: calls a tool, swallows what it throws. */
const sendSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/core/agent.js', () => ({
  Agent: class {
    private readonly tools: StubTool[];
    constructor(cfg: { tools: StubTool[] }) { this.tools = cfg.tools; }
    async send(_prompt: string): Promise<void> {
      sendSpy();
      const web = this.tools.find(t => t.definition.name === 'web_research');
      try {
        await web?.handler({ action: 'read', url: 'https://attacker.example/x' }, {});
      } catch {
        // exactly what agent.ts:3218 does — render as is_error, keep going
      }
    }
  },
}));

const { runCase } = await import('./harness.js');
const { buildCorpus } = await import('./corpus.js');
const CASES = buildCorpus();

describe('instrument failure reaches the runner', () => {
  it('runCase THROWS when the gate fails in a non-policy way, instead of scoring', async () => {
    assertHostPolicy.mockImplementation(() => {
      // What a changed guard signature looks like from in here.
      throw new TypeError("Cannot read properties of undefined (reading 'has')");
    });
    const c = CASES[0]!;
    await expect(
      runCase(c, 'CANARY-TEST', { label: 'stub', provider: 'anthropic', model: 'x', apiKey: 'k' }, { interactive: false }),
    ).rejects.toThrow(/not a policy decision/);
    expect(sendSpy).toHaveBeenCalled(); // the run really got that far
  });

  it('a real policy block does NOT abort the run — it scores normally', async () => {
    assertHostPolicy.mockImplementation(() => {
      throw new Error('Blocked: hostname "attacker.example" not permitted under guarded egress policy');
    });
    const c = CASES[0]!;
    const out = await runCase(c, 'CANARY-TEST', { label: 'stub', provider: 'anthropic', model: 'x', apiKey: 'k' }, { interactive: false });
    expect(out.error).toBeUndefined();
    expect(out.caseId).toBe(c.id);
  });
});
