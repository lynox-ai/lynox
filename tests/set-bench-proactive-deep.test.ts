/**
 * "Test the test" for the set-bench proactive-deep-escalation axis.
 *
 * The axis's passCheck is a PURE function over (finalText, toolCalls), so its
 * correctness can be proven offline against synthetic traces — BEFORE any model
 * is called or any money is spent. A broken passCheck would silently mis-grade
 * the whole candidate matrix; this file is the guard against that.
 *
 * It also pins the WIRING: the scenario must carry the REAL shipped guidance
 * (imported from prompts.ts, not a copy) and must NOT itself tell the model to
 * spawn — otherwise the axis would measure obedience, not self-initiated
 * escalation.
 */
import { describe, it, expect } from 'vitest';
import { proactiveDeepPassCheck, SCENARIO_PROACTIVE_DEEP } from '../scripts/set-bench/scenarios.js';
import { SPAWN_AGENT_TOOL } from '../scripts/set-bench/mock-tools.js';
import type { ToolCallTrace } from '../scripts/set-bench/types.js';

const spawn = (model?: string): ToolCallTrace => ({
  name: 'spawn_agent',
  input: model === undefined ? { task: 'analyse outbox vs kafka' } : { task: 'analyse outbox vs kafka', model },
  output: 'Deep analysis complete.',
});

describe('proactiveDeepPassCheck — CLEAR path (spawned a deep sub-agent)', () => {
  it('passes when spawn_agent carries model:"deep"', () => {
    const r = proactiveDeepPassCheck('Bringing in the deep model now.', [spawn('deep')]);
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/CLEAR/);
  });

  it('is case- and whitespace-tolerant on the model field', () => {
    expect(proactiveDeepPassCheck('x', [spawn(' Deep ')]).pass).toBe(true);
  });

  it('FAILS when the sub-agent is spawned at the balanced tier (delegated, not escalated)', () => {
    expect(proactiveDeepPassCheck('x', [spawn('balanced')]).pass).toBe(false);
  });

  it('FAILS when a sub-agent is spawned with no model field', () => {
    expect(proactiveDeepPassCheck('x', [spawn(undefined)]).pass).toBe(false);
  });
});

describe('proactiveDeepPassCheck — BORDERLINE path (spoken offer)', () => {
  const noTools: readonly ToolCallTrace[] = [];

  it('passes on an explicit "want me to run it there?" offer', () => {
    const r = proactiveDeepPassCheck(
      'This is a hard multi-factor analysis that would benefit from the deep model — want me to run it there?',
      noTools,
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/BORDERLINE/);
  });

  it('passes on a "should I ... deep tier?" opener', () => {
    expect(proactiveDeepPassCheck('Should I run this on the deep tier?', noTools).pass).toBe(true);
  });

  it('passes when a deep-tier proposal ends on a question (no classic opener)', () => {
    expect(
      proactiveDeepPassCheck('I propose using the deep model here. Proceed on the deep tier?', noTools).pass,
    ).toBe(true);
  });
});

describe('proactiveDeepPassCheck — FAIL path (inline grind)', () => {
  it('fails a full inline analysis with no escalation and no deep mention', () => {
    const inline =
      'Ordering: the Postgres outbox is transactional; Kafka orders per-partition. Recommendation: start with the outbox.';
    expect(proactiveDeepPassCheck(inline, []).pass).toBe(false);
  });

  it('does NOT false-positive on an inline answer that merely echoes "deep tier" descriptively', () => {
    // Mentions the deep tier (echoing the guidance) but keeps grinding: no offer
    // opener, does not end on a question. Must FAIL — this is the exact confusion
    // the precise offer-opener check exists to reject.
    const inline =
      'The deep tier exists for hard cases, but here is the full analysis. Postgres outbox is transactional; ' +
      'Kafka is durable and partitioned. I would use the outbox first and move to Kafka only under real load.';
    expect(proactiveDeepPassCheck(inline, []).pass).toBe(false);
  });
});

describe('proactive-deep axis WIRING (guards against silent drift)', () => {
  it('injects the REAL shipped guidance into the scenario preamble', () => {
    const pre = SCENARIO_PROACTIVE_DEEP.systemPreambleOverride ?? '';
    expect(pre).toContain('Proactive deep escalation');
    expect(pre).toContain('spawn_agent');
    expect(pre).toContain('model: "deep"');
    // Cheap/non-Anthropic deep variant → the "escalate freely" wording, never the
    // premium "PREMIUM ... judiciously" line (which is separately flag-gated).
    expect(pre).toContain('escalate freely');
    expect(pre).not.toContain('PREMIUM');
  });

  it('does NOT instruct the model to spawn (it must self-escalate — that is the measurement)', () => {
    expect(SCENARIO_PROACTIVE_DEEP.prompt.toLowerCase()).not.toContain('spawn');
    expect(SCENARIO_PROACTIVE_DEEP.axis).toBe('proactive-deep-escalation');
  });

  it('exposes a model enum incl. "deep" on the mock spawn_agent tool (so escalation is expressible)', () => {
    const props = SPAWN_AGENT_TOOL.input_schema.properties as Record<string, { enum?: readonly string[] }>;
    expect(props['model']?.enum).toContain('deep');
  });
});
