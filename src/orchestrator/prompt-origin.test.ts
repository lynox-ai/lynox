/**
 * A confirmation raised from inside a workflow step must name what asked.
 *
 * The step's tool calls carry an empty `context_id` and never enter
 * `thread_messages`, so the dialog is the ONLY place the cause can appear.
 * Roland's instance showed the failure on 2026-08-08: four `bash` approvals from
 * a "bexio Triage" pipeline, raised against a transcript that contained no bash
 * call at all.
 *
 * These tests drive the WHOLE chain — `runManifest` → `spawnInline` →
 * `buildSubAgentPromptCallbacks` → the parent callback — rather than the two
 * halves separately. Asserting only that the spawner receives the handles, and
 * separately that the handles become meta, leaves the one join that actually
 * broke (nobody setting `workflowName`) covered by nothing.
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

const TOOLS: ToolEntry[] = [
  {
    definition: { name: 'bash', description: 'Run bash', input_schema: { type: 'object' } } as ToolEntry['definition'],
    handler: async () => 'done',
  },
  {
    definition: { name: 'ask_user', description: 'Ask', input_schema: { type: 'object' } } as ToolEntry['definition'],
    handler: async () => 'answered',
  },
];

function manifestNamed(name: string): Manifest {
  return {
    manifest_version: '1.0',
    name,
    triggered_by: 'test',
    context: {},
    agents: [{ id: 'load_contacts', agent: 'load_contacts', runtime: 'inline', task: 'Paginate GET /2.0/contact' }],
    gate_points: [],
    on_failure: 'stop',
  };
}

/** The `promptUser` the step's Agent was constructed with. */
function stepPromptUser(): (q: string, opts?: string[]) => Promise<string> {
  const cfg = vi.mocked(Agent).mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
  const fn = cfg['promptUser'];
  if (typeof fn !== 'function') throw new Error('step agent got no promptUser');
  return fn as (q: string, opts?: string[]) => Promise<string>;
}

describe('prompt origin — a workflow step names itself in its own confirmations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue('step done');
  });

  it('stamps the manifest name, step id and task onto the prompt', async () => {
    const parentPromptUser = vi.fn(async () => 'y');
    await runManifest(manifestNamed('bexio Triage Phase 1-3'), CONFIG, {
      parentTools: TOOLS,
      parentPrompt: { parentPromptUser },
    });

    await stepPromptUser()('⚠ bash: remote shell access — "ssh …"', ['Allow', 'Deny']);

    expect(parentPromptUser).toHaveBeenCalledWith(
      '⚠ bash: remote shell access — "ssh …"',
      ['Allow', 'Deny'],
      expect.objectContaining({
        workflowName: 'bexio Triage Phase 1-3',
        stepId: 'load_contacts',
        stepTask: 'Paginate GET /2.0/contact',
      }),
    );
  });

  it('names the manifest that declares the step, not one the caller pre-set', async () => {
    // A caller handing in a stale name must not survive: the step belongs to the
    // manifest running it. This is what makes a NESTED pipeline name the inner
    // workflow — pointing the user at an outer step list that does not contain
    // the step asking would be worse than saying nothing.
    const parentPromptUser = vi.fn(async () => 'y');
    await runManifest(manifestNamed('inner-pipeline'), CONFIG, {
      parentTools: TOOLS,
      parentPrompt: { parentPromptUser, workflowName: 'outer-pipeline' },
    });

    await stepPromptUser()('Q');

    expect(parentPromptUser).toHaveBeenCalledWith(
      'Q',
      undefined,
      expect.objectContaining({ workflowName: 'inner-pipeline' }),
    );
  });

  it('leaves the origin empty for a run with no workflow name', async () => {
    // `name` is a required Manifest field, so the honest no-origin case is the
    // one the main agent takes: no pipeline, no wrapper, no meta at all. Pinned
    // here so the origin line can never render an empty frame for it.
    const parentPromptUser = vi.fn(async () => 'y');
    const unnamed = { ...manifestNamed(''), name: '' };
    await runManifest(unnamed, CONFIG, { parentTools: TOOLS, parentPrompt: { parentPromptUser } });

    await stepPromptUser()('Q');

    const meta = parentPromptUser.mock.calls[0]![2] as Record<string, unknown> | undefined;
    expect(meta?.['workflowName']).toBe('');
    expect(meta?.['stepId']).toBe('load_contacts');
  });
});
