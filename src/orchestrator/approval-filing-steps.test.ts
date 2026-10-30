/**
 * A step of a trigger's workflow run files a mail under the run's trigger and names the
 * workflow run as its root. Driven through `runManifest`
 * into the step agent's construction, the join where the root is set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LynoxUserConfig, ToolEntry } from '../types/index.js';
import type { Manifest } from '../types/orchestration.js';

const mockSend = vi.fn().mockResolvedValue('step done');

vi.mock('../core/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (this: { send: typeof mockSend; abort: ReturnType<typeof vi.fn> }) {
    this.send = mockSend;
    this.abort = vi.fn();
  }),
}));

import { Agent } from '../core/agent.js';
import { runManifest } from './runner.js';

const CONFIG = { api_key: 'test-key' } as unknown as LynoxUserConfig;
const TOOLS: ToolEntry[] = [{
  definition: { name: 'mail_send', description: 'Send', input_schema: { type: 'object' } } as ToolEntry['definition'],
  handler: async () => 'done',
}];
const MANIFEST: Manifest = {
  manifest_version: '1.0', name: 'Weekly report', triggered_by: 'test', context: {},
  agents: [{ id: 'send', agent: 'send', runtime: 'inline', task: 'Send the weekly report' }],
  gate_points: [], on_failure: 'stop',
};
const RUN_ID = '0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const filing = { source: 'workflow' as const, triggerId: 'trg-1', store: {} as never, createdBy: 'owner', mandateId: null };
const stepFiling = (): Record<string, unknown> | undefined =>
  (vi.mocked(Agent).mock.calls.at(-1)![0] as unknown as Record<string, unknown>)['approvalFiling'] as Record<string, unknown> | undefined;

describe('a workflow step files under the run\'s trigger, rooted at the workflow run', () => {
  beforeEach(() => { vi.clearAllMocks(); mockSend.mockResolvedValue('step done'); });

  it('the top-level run names itself as the root', async () => {
    await runManifest(MANIFEST, CONFIG, {
      source: { kind: 'adhoc' as const }, parentTools: TOOLS, autonomy: 'autonomous', runId: RUN_ID,
      parentPrompt: { approvalFiling: filing },
    });
    expect(stepFiling()).toEqual({ ...filing, rootRunId: RUN_ID });
  });

  it('a root already set (a nested run) is kept', async () => {
    await runManifest(MANIFEST, CONFIG, {
      source: { kind: 'adhoc' as const }, parentTools: TOOLS, autonomy: 'autonomous', runId: RUN_ID,
      parentPrompt: { approvalFiling: { ...filing, rootRunId: 'outer-run' } },
    });
    expect(stepFiling()).toEqual({ ...filing, rootRunId: 'outer-run' });
  });

  it('a run handed none gives its step none', async () => {
    await runManifest(MANIFEST, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: TOOLS, autonomy: 'autonomous', runId: RUN_ID });
    expect(vi.mocked(Agent)).toHaveBeenCalled();
    expect(stepFiling()).toBeUndefined();
  });
});
