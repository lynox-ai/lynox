import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportWorkflowTool, LYNOX_WORKFLOW_INFO_STRING } from './export-workflow.js';
import { _resetPipelineStore } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import { RunHistory } from '../../core/run-history.js';
import { EngineDb } from '../../core/engine-db.js';
import { CURRENT_PIPELINE_SCHEMA_VERSION } from '../../core/pipeline-schema-migration.js';
import { LYNOX_WORKFLOW_FORMAT_VERSION, type PortableWorkflow } from '../../core/workflow-portable.js';
import type { IAgent, LynoxUserConfig, PlannedPipeline } from '../../types/index.js';

const mockConfig = { api_key: 'test-key' } as LynoxUserConfig;

function makeAgent(runHistory: RunHistory | null): IAgent {
  const toolContext = createToolContext(mockConfig);
  toolContext.runHistory = runHistory;
  return {
    name: 'test', model: 'test-model', memory: null, tools: [], onStream: null,
    currentRunId: 'run-1', toolContext,
  } as unknown as IAgent;
}

function makePlanned(overrides: Partial<PlannedPipeline> = {}): PlannedPipeline {
  return {
    id: 'wf-1',
    name: 'Monthly Report',
    goal: 'Fetch spend and email it',
    steps: [
      {
        id: 's1',
        task: 'Fetch spend',
        tool: 'http_request',
        input_template: {
          method: 'GET',
          url: 'https://api.example.com/spend',
          headers: { Authorization: 'Bearer secret:ADS_API_KEY' },
        },
      },
    ],
    reasoning: 'fetch then send',
    estimatedCost: 0.5,
    createdAt: '2026-07-13T00:00:00.000Z',
    executed: true,
    template: true,
    mode: 'autonomous',
    parameters: [],
    confirmedAt: '2026-07-13T09:00:00.000Z',
    ...overrides,
  };
}

/** Pull the JSON payload out of the fenced block. The fence is dynamic-length
 *  (CommonMark: longer than any backtick run in the body), so we read the actual
 *  opening-fence backtick count and match a closing fence of exactly that run —
 *  never a hard-coded ```. This mirrors what the Slice-3 parser must do. */
function extractBlock(output: string): string {
  const open = output.match(new RegExp('(`{3,})' + LYNOX_WORKFLOW_INFO_STRING + '\\n'));
  expect(open).toBeTruthy();
  const fence = open![1]!;
  const bodyStart = output.indexOf(open![0]!) + open![0]!.length;
  // The producer guarantees no backtick run in the body reaches `fence.length`,
  // so `\n<fence>` matches only the real closing fence.
  const end = output.indexOf('\n' + fence, bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return output.slice(bodyStart, end);
}

describe('export_workflow', () => {
  let dir: string;
  let history: RunHistory;
  let engine: EngineDb;

  beforeEach(() => {
    _resetPipelineStore();
    dir = mkdtempSync(join(tmpdir(), 'wf-export-'));
    history = new RunHistory(join(dir, 'h.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
  });

  afterEach(() => {
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits a valid, parseable share block for a saved workflow', async () => {
    history.insertPlannedPipeline(makePlanned());
    _resetPipelineStore(); // force the SQLite round-trip, not the write-cache
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-1' }, makeAgent(history));

    expect(out).toContain('✓ Exported "Monthly Report"');
    expect(out).toMatch(new RegExp('`{3,}' + LYNOX_WORKFLOW_INFO_STRING));

    const parsed = JSON.parse(extractBlock(out)) as PortableWorkflow;
    expect(parsed.lynox_workflow_format_version).toBe(LYNOX_WORKFLOW_FORMAT_VERSION);
    expect(parsed.content_schema_version).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    expect(parsed.workflow.name).toBe('Monthly Report');
    expect(parsed.workflow.goal).toBe('Fetch spend and email it');
    expect(parsed.workflow.steps[0]?.tool).toBe('http_request');
  });

  it('round-trips even when the content contains a literal ``` fence', async () => {
    // A workflow whose reasoning / step text embeds a triple-backtick block would
    // close a fixed ``` fence early and break JSON parsing — the dynamic fence
    // must be longer than any backtick run in the body.
    history.insertPlannedPipeline(makePlanned({
      id: 'wf-fence',
      reasoning: 'Run this: ```bash\ncurl https://api.example.com\n``` then summarise.',
      steps: [{ id: 's1', task: 'Emit ```` quad and ``` triple backticks' }],
    }));
    _resetPipelineStore();
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-fence' }, makeAgent(history));

    // The block still parses as JSON and preserves the backtick-laden content.
    const parsed = JSON.parse(extractBlock(out)) as PortableWorkflow;
    expect(parsed.workflow.reasoning).toContain('```bash');
    expect(parsed.workflow.steps[0]?.task).toContain('```` quad');
  });

  it('preserves the optional kept fields across the persist→read→export round-trip', async () => {
    history.insertPlannedPipeline(makePlanned({
      id: 'wf-opt',
      on_failure: 'notify',
      limits: { maxWallClockMs: 60000, maxIterations: 20 },
      capabilityContract: {
        version: 1,
        grantedTools: ['http_request'],
        httpMethods: ['GET'],
        hostPatterns: ['api.example.com'],
        pathPatterns: ['/spend'],
        paramConstraints: {},
      },
    }));
    _resetPipelineStore();
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-opt' }, makeAgent(history));
    const parsed = JSON.parse(extractBlock(out)) as PortableWorkflow;
    expect(parsed.workflow.on_failure).toBe('notify');
    expect(parsed.workflow.limits).toEqual({ maxWallClockMs: 60000, maxIterations: 20 });
    expect(parsed.workflow.capabilityContract?.grantedTools).toEqual(['http_request']);
    expect(parsed.workflow.capabilityContract?.hostPatterns).toEqual(['api.example.com']);
  });

  it('strips confirmedAt and tenant-local fields from the block (§5 A1)', async () => {
    history.insertPlannedPipeline(makePlanned());
    _resetPipelineStore();
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-1' }, makeAgent(history));
    const parsed = JSON.parse(extractBlock(out)) as PortableWorkflow;
    for (const forbidden of ['id', 'executed', 'createdAt', 'estimatedCost', 'confirmedAt', 'template']) {
      expect(forbidden in parsed.workflow).toBe(false);
    }
  });

  it('never inlines a secret value — the ref travels verbatim', async () => {
    history.insertPlannedPipeline(makePlanned());
    _resetPipelineStore();
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-1' }, makeAgent(history));
    expect(out).toContain('secret:ADS_API_KEY');
  });

  it('errors cleanly for an unknown workflow_id', async () => {
    const out = await exportWorkflowTool.handler({ workflow_id: 'does-not-exist' }, makeAgent(history));
    expect(out).toMatch(/^Error: Workflow "does-not-exist" not found\./);
  });

  it('errors cleanly for a non-template (one-shot) workflow', async () => {
    history.insertPlannedPipeline(makePlanned({ id: 'wf-oneshot', template: false }));
    _resetPipelineStore();
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-oneshot' }, makeAgent(history));
    expect(out).toContain('is a one-shot run, not a saved workflow');
  });

  it('errors when workflow_id is missing', async () => {
    const out = await exportWorkflowTool.handler({}, makeAgent(history));
    expect(out).toBe('Error: workflow_id is required.');
  });

  it('errors when run history is unavailable', async () => {
    const out = await exportWorkflowTool.handler({ workflow_id: 'wf-1' }, makeAgent(null));
    expect(out).toContain('Run history is not available');
  });
});
