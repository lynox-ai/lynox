import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Agent } from './agent.js';
import type { IMemory } from '../types/index.js';
import { appendCaptureTelemetry } from './capture-telemetry.js';

/**
 * The DENOMINATOR half of the fire-rate, guarded.
 *
 * `capture_eligible` is emitted from the turn-end hook and ONLY behind three conditions
 * (`agent.ts`: no `Memory` · `skipMemoryExtraction` · an internal run). The NUMERATOR
 * (`remember_invoked`, from the tool handler) sits behind none of them. That asymmetry is
 * why `remember_invoked / capture_eligible` is not guaranteed to be a ratio at all — a
 * real sink carried 910 numerator events against 0 denominator events.
 *
 * Until this file existed, **removing any one of the three guards broke no test**: the
 * suite drove the numerator and the report, never the hook itself. Each `it` below is
 * therefore written to die under exactly one mutation of that line — the mutation table
 * is in the PR, and the assert that kills each one is named there.
 *
 * The sink itself is mocked rather than written to disk: `_captureAtTurnEnd` fires the
 * append with `void` and returns synchronously, so a disk-backed assertion would race the
 * write. What is under test is WHETHER the emit happens and with WHICH run id, which is
 * exactly what the call spy sees.
 */
vi.mock('./capture-telemetry.js', async (orig) => {
  const actual = await orig<typeof import('./capture-telemetry.js')>();
  return { ...actual, appendCaptureTelemetry: vi.fn(() => Promise.resolve()) };
});

const emit = vi.mocked(appendCaptureTelemetry);

/** Internals the hook reads; `memory` is `readonly` on the class, so it is set through here. */
interface Internals {
  _durableMemoryEnabled: boolean;
  _captureAtTurnEnd(text: string): void;
  memory: IMemory | null;
}

/**
 * A turn-end that WOULD be eligible: DK on, a Memory present, not internal, extraction not
 * skipped. Each test then breaks exactly one of those and asserts the emit disappears.
 *
 * `memory` is a stub rather than a real Memory — the hook only tests it for truthiness on
 * the DK branch, and a real one would drag a store into a test about a guard. It DOES
 * carry `maybeUpdate`, because the DK-OFF case falls through to the legacy extraction and
 * a bare `{}` makes that path throw a TypeError — which fails the test for a reason that
 * has nothing to do with the guard under test, and would have been read as a kill.
 */
function makeEligibleAgent(): Agent & Internals {
  const agent = new Agent({ name: 'test', model: 'mistral-medium-2604', systemPrompt: 'SYS' });
  const inner = agent as unknown as Agent & Internals;
  inner.memory = { maybeUpdate: () => Promise.resolve() } as unknown as IMemory;
  inner._durableMemoryEnabled = true;
  agent.currentRunId = 'run-alpha';
  agent.currentThreadId = 'thread-1';
  return inner;
}

/** The `capture_eligible` payloads the hook handed the sink this test. */
function eligibleEmits(): Array<Record<string, unknown>> {
  return emit.mock.calls
    .filter(([enabled, e]) => enabled === true && e.event === 'capture_eligible')
    .map(([, e]) => e as unknown as Record<string, unknown>);
}

beforeEach(() => { emit.mockClear(); });

describe('capture_eligible — the denominator fires only for a run the hook accepts', () => {
  it('emits for an ordinary DK turn, carrying the run id that makes it joinable', () => {
    const inner = makeEligibleAgent();
    inner._captureAtTurnEnd('a business fact');
    const emits = eligibleEmits();
    expect(emits).toHaveLength(1);
    // The run id is the whole point: without it the report cannot tell whether this
    // denominator event and some numerator event describe the same run. Dropping the
    // field from the emit is a live mutation and dies here.
    expect(emits[0]).toMatchObject({ event: 'capture_eligible', runId: 'run-alpha' });
  });

  it('does NOT emit for an internal run — auto-compaction is not a captured turn', () => {
    const inner = makeEligibleAgent();
    inner.isInternalRun = true;
    inner._captureAtTurnEnd('a business fact');
    expect(eligibleEmits()).toEqual([]);
  });

  it('does NOT emit when memory extraction is skipped for this run', () => {
    const inner = makeEligibleAgent();
    inner.skipMemoryExtraction = true;
    inner._captureAtTurnEnd('a business fact');
    expect(eligibleEmits()).toEqual([]);
  });

  it('does NOT emit when the agent has no Memory at all', () => {
    const inner = makeEligibleAgent();
    inner.memory = null;
    inner._captureAtTurnEnd('a business fact');
    expect(eligibleEmits()).toEqual([]);
  });

  it('does NOT emit when DK is off — the sink logs only where we measure', () => {
    const inner = makeEligibleAgent();
    inner._durableMemoryEnabled = false;
    inner._captureAtTurnEnd('a business fact');
    expect(eligibleEmits()).toEqual([]);
  });
});
