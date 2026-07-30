import { describe, it, expect } from 'vitest';
import type { PlannedPipeline } from '../types/pipeline.js';
import { CURRENT_PIPELINE_SCHEMA_VERSION } from './pipeline-schema-migration.js';
import {
  toPortableWorkflow,
  LYNOX_WORKFLOW_FORMAT_VERSION,
  type PortableWorkflow,
} from './workflow-portable.js';

/** A fully-populated stored workflow, including a `secret:NAME` ref inside a
 *  step's literal tool call — the case the exfil invariant must protect. */
function makePlanned(overrides: Partial<PlannedPipeline> = {}): PlannedPipeline {
  return {
    id: 'wf_local_abc123',
    name: 'Monthly Ad Report',
    goal: 'Pull spend and email a summary',
    steps: [
      {
        id: 's1',
        task: 'Fetch spend for {{params.month}}',
        tool: 'http_request',
        input_template: {
          method: 'GET',
          url: 'https://api.example.com/spend',
          headers: { Authorization: 'Bearer secret:ADS_API_KEY' },
        },
      },
    ],
    reasoning: 'Two-step: fetch then summarise',
    estimatedCost: 0.42,
    createdAt: '2026-07-13T10:00:00.000Z',
    executed: true,
    template: true,
    mode: 'autonomous',
    on_failure: 'notify',
    parameters: [
      { name: 'month', description: 'Month to report', type: 'string', source: 'user_input' },
    ],
    capabilityContract: {
      version: 1,
      grantedTools: ['http_request'],
      httpMethods: ['GET'],
      hostPatterns: ['api.example.com'],
      pathPatterns: ['/spend'],
      paramConstraints: { month: { regex: '\\d{4}-\\d{2}' } },
    },
    confirmedAt: '2026-07-13T11:00:00.000Z',
    limits: { maxWallClockMs: 60000, maxIterations: 20 },
    schema_version: CURRENT_PIPELINE_SCHEMA_VERSION,
    ...overrides,
  };
}

describe('toPortableWorkflow', () => {
  it('keeps the authored fields', () => {
    const portable = toPortableWorkflow(makePlanned());
    const { workflow } = portable;
    expect(workflow.name).toBe('Monthly Ad Report');
    expect(workflow.goal).toBe('Pull spend and email a summary');
    expect(workflow.reasoning).toBe('Two-step: fetch then summarise');
    expect(workflow.mode).toBe('autonomous');
    expect(workflow.on_failure).toBe('notify');
    expect(workflow.parameters).toEqual([
      { name: 'month', description: 'Month to report', type: 'string', source: 'user_input' },
    ]);
    expect(workflow.limits).toEqual({ maxWallClockMs: 60000, maxIterations: 20 });
    expect(workflow.capabilityContract?.grantedTools).toEqual(['http_request']);
    // steps travel verbatim, including the replay `tool`/`input_template` pair
    expect(workflow.steps[0]?.tool).toBe('http_request');
    expect(workflow.steps[0]?.input_template?.['url']).toBe('https://api.example.com/spend');
  });

  it('strips tenant-local runtime + consent fields', () => {
    const portable = toPortableWorkflow(makePlanned());
    // The envelope object graph must not carry any stripped key at any depth.
    const keys = Object.keys(portable.workflow);
    for (const forbidden of ['id', 'executed', 'createdAt', 'estimatedCost', 'confirmedAt', 'template', 'schema_version']) {
      expect(keys).not.toContain(forbidden);
    }
    // confirmedAt is the security-critical one (§5 A1) — assert it is truly gone,
    // not merely undefined, so the import cannot inherit the sharer's consent.
    expect('confirmedAt' in portable.workflow).toBe(false);
  });

  it('NEVER resolves a secret:NAME ref — the ref is carried byte-identical', () => {
    const portable = toPortableWorkflow(makePlanned());
    // The header value is the ref VERBATIM — not resolved, not rewritten.
    const headers = portable.workflow.steps[0]?.input_template?.['headers'] as Record<string, unknown>;
    expect(headers['Authorization']).toBe('Bearer secret:ADS_API_KEY');
    // And the secret NAME appears exactly once in the whole envelope, only in ref
    // form: a resolution would replace it with a value or add a second occurrence.
    const serialized = JSON.stringify(portable);
    expect(serialized).toContain('secret:ADS_API_KEY');
    expect(serialized.match(/ADS_API_KEY/g)).toHaveLength(1);
  });

  it('stamps the envelope with both version axes', () => {
    const portable: PortableWorkflow = toPortableWorkflow(makePlanned());
    expect(portable.lynox_workflow_format_version).toBe(LYNOX_WORKFLOW_FORMAT_VERSION);
    expect(portable.content_schema_version).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    expect(typeof portable.workflow).toBe('object');
  });

  it('content version is current-shaped even for an unstamped (legacy) blob', () => {
    // A blob read before boot-migration stamped it — the serializer extracts the
    // current known field set, so the artifact is current-shaped regardless.
    const portable = toPortableWorkflow(makePlanned({ schema_version: undefined }));
    expect(portable.content_schema_version).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
  });

  it('omits optional fields that are absent (exactOptionalPropertyTypes)', () => {
    const portable = toPortableWorkflow(
      makePlanned({ capabilityContract: undefined, on_failure: undefined, limits: undefined }),
    );
    expect('capabilityContract' in portable.workflow).toBe(false);
    expect('on_failure' in portable.workflow).toBe(false);
    expect('limits' in portable.workflow).toBe(false);
    // required fields still present
    expect(portable.workflow.name).toBe('Monthly Ad Report');
    expect(portable.workflow.parameters).toEqual([
      { name: 'month', description: 'Month to report', type: 'string', source: 'user_input' },
    ]);
  });

  it('produces a fresh envelope object (does not mutate the input)', () => {
    const planned = makePlanned();
    const before = JSON.stringify(planned);
    toPortableWorkflow(planned);
    expect(JSON.stringify(planned)).toBe(before);
  });
});
