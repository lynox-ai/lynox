/**
 * Online eval: deterministic-replay gate (PRD v10 Slice 1, decision D2).
 *
 * Measures the WHOLE replay chain on a REAL capture:
 *   real captureProcess (Haiku)  →  processToSteps  →  resolveInputTemplate ×2.
 *
 * Two questions this gate answers with data (the measure-first decision):
 *   1. Does capture actually emit a re-targetable `{{params.<name>}}` placeholder
 *      in a step's input_template? (the linchpin the EXTRACTION-prompt change
 *      targets — without it, re-targeting silently no-ops.)
 *   2. Given a placeholder, does substituting two different param values produce
 *      tool-call inputs that are STRUCTURALLY identical except that value?
 *
 * PASS = Option A (agent-mediated literal replay) is deterministic at the
 * mechanism level → the heavy Option B (non-agent executeDirectTool) is not
 * needed. FAIL = the captured placeholder is missing/misaligned → iterate the
 * capture prompt or escalate to Option B. The residual question — whether the
 * STEP AGENT (Option A) deviates at actual execution — is measured live by
 * /staging-walk --guided, not here.
 *
 * Cost: ~$0.002 (one Haiku capture call). Gated on an API key like the sibling
 * online tests.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { captureProcess } from '../../src/core/process-capture.js';
import { processToSteps } from '../../src/tools/builtin/process.js';
import { resolveInputTemplate } from '../../src/orchestrator/context.js';
import { bindWorkflowParameters } from '../../src/orchestrator/workflow-params.js';
import type { ToolCallRecord } from '../../src/core/run-history.js';
import type { ProcessRecord } from '../../src/types/index.js';
import { getApiKey, hasApiKey } from './setup.js';

const SKIP = !hasApiKey();

function tc(tool_name: string, input: string, output: string, order: number): ToolCallRecord {
  return { id: `tc-${order}`, run_id: 'run-eval', tool_name, input_json: input, output_json: output, duration_ms: 100, sequence_order: order };
}

// A monthly-report-style run whose inputs clearly carry a re-targetable client
// name + month — the canonical "re-run for a different client" workflow.
const REPORT_CALLS: ToolCallRecord[] = [
  tc('data_store_query', '{"table": "revenue", "filter": {"client": "Acme Corp", "month": "2026-05"}}', '{"rows": 42}', 0),
  tc('http', '{"method": "GET", "url": "https://api.example.com/clients/Acme Corp/spend?month=2026-05"}', '{"spend": 1234}', 1),
  tc('write_file', '{"path": "reports/Acme Corp-2026-05.md", "content": "# Report for Acme Corp"}', 'Written', 2),
];

describe.skipIf(SKIP)('Online eval: deterministic-replay gate (D2)', () => {
  let apiKey: string;
  let record: ProcessRecord;

  beforeAll(async () => {
    apiKey = getApiKey();
    record = await captureProcess(
      'run-eval-001',
      'Monthly Client Report',
      REPORT_CALLS,
      { apiKey, description: 'Compile a monthly revenue report for a client' },
    );
  }, 30_000);

  it('capture identifies a user-supplied parameter for the client', () => {
    // The client name is the textbook re-target value — capture should surface
    // at least one user_input parameter. (Type/source contract sanity.)
    expect(record.parameters.length).toBeGreaterThanOrEqual(1);
    for (const p of record.parameters) {
      expect(['string', 'number', 'date']).toContain(p.type);
      expect(['user_input', 'relative_date', 'context']).toContain(p.source);
    }
  });

  it('LINCHPIN: a promoted step carries a {{params.<name>}} placeholder that aligns with a parameter', () => {
    const steps = processToSteps(record);
    const paramNames = new Set(record.parameters.map((p) => p.name));

    // Collect every {{params.X}} reference the promotion produced across all
    // input_templates, and confirm at least one aligns with an identified param.
    const referenced = new Set<string>();
    for (const step of steps) {
      const json = JSON.stringify(step.input_template ?? {});
      for (const m of json.matchAll(/\{\{\s*params\.([^}\s]+)\s*\}\}/g)) {
        referenced.add(m[1]!);
      }
    }

    // Diagnostic — this is the measurement the EXTRACTION-prompt change targets.
    // eslint-disable-next-line no-console
    console.log('[replay-eval] params:', [...paramNames], '| {{params.*}} in templates:', [...referenced]);

    const aligned = [...referenced].filter((r) => paramNames.has(r));
    expect(
      aligned.length,
      `capture produced no {{params.<name>}} placeholder aligned with an identified parameter — ` +
      `re-targeting would silently no-op. params=${[...paramNames]} referenced=${[...referenced]}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('DETERMINISM: two param values yield structurally-identical calls differing only by the value', () => {
    const steps = processToSteps(record);
    const stringParams = new Set(record.parameters.filter((p) => p.type === 'string').map((p) => p.name));

    // Pick the captured step + a STRING param that carries a {{params.X}}
    // placeholder (proven to exist by the linchpin test) — a string target keeps
    // the two distinct re-target values trivially valid.
    let target: { template: Record<string, unknown>; param: string } | undefined;
    for (const step of steps) {
      const json = JSON.stringify(step.input_template ?? {});
      for (const m of json.matchAll(/\{\{\s*params\.([^}\s]+)\s*\}\}/g)) {
        if (stringParams.has(m[1]!) && step.input_template) {
          target = { template: step.input_template, param: m[1]! };
          break;
        }
      }
      if (target) break;
    }
    expect(target, 'no step with an aligned {{params.<string>}} placeholder to re-target').toBeDefined();
    if (!target) return;

    // Build two param sets identical except the target param's value. Every other
    // identified param gets a TYPE-VALID fixed value so only the target differs.
    const fixedFor = (type: string): string =>
      type === 'date' ? '2026-01-01' : type === 'number' ? '1' : 'FIXED';
    const fixed: Record<string, unknown> = {};
    for (const p of record.parameters) fixed[p.name] = fixedFor(p.type);

    const boundA = bindWorkflowParameters(record.parameters, { ...fixed, [target.param]: 'Acme Corp' });
    const boundB = bindWorkflowParameters(record.parameters, { ...fixed, [target.param]: 'Globex Inc' });
    expect(boundA.ok && boundB.ok).toBe(true);
    if (!boundA.ok || !boundB.ok) return;

    const callA = JSON.stringify(resolveInputTemplate(target.template, { params: boundA.params }));
    const callB = JSON.stringify(resolveInputTemplate(target.template, { params: boundB.params }));

    // Re-targeting actually changed the call …
    expect(callA).not.toEqual(callB);
    // … and ONLY by the substituted value: rewriting B's value back to A's makes
    // the two calls identical (structural identity — the determinism property).
    expect(callB.split('Globex Inc').join('Acme Corp')).toEqual(callA);
  });
});
