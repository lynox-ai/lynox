/**
 * A save_workflow call that saved nothing is recorded as a failed call, so a refusal can be
 * counted in the run history. The recorded reason is a fixed phrase, never text from the answer.
 * The model still reads the answer as it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();
vi.mock('../../core/stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { Agent } from '../../core/agent.js';
import { createToolContext } from '../../core/tool-context.js';
import type { StreamEvent, ToolEntry } from '../../types/index.js';
import { SESSION_PARAM_NAME_REFUSAL, saveWorkflowFailure, saveWorkflowTool, sessionAnalysisFailed } from './process.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (id: string) => ({
  content: [{ type: 'tool_use' as const, id, name: 'save_workflow', input: { name: 'Report' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});

type Ev = Extract<StreamEvent, { type: 'tool_result' }>;
interface Rec { toolName?: string; isError?: boolean; outputJson?: string }

/** save_workflow as declared, answering `answer`: its own `failureOf` reads the answer. */
function saveWorkflowAnswering(answer: string): ToolEntry {
  return { ...saveWorkflowTool, handler: async () => answer } as ToolEntry;
}

async function run(tool: ToolEntry): Promise<{ events: Ev[]; recs: Rec[]; modelSaw: string }> {
  const events: Ev[] = [];
  const recs: Rec[] = [];
  mockProcess.mockResolvedValueOnce(toolUse('tu-1'));
  mockProcess.mockResolvedValueOnce(endTurn('done'));
  const agent = new Agent({
    name: 'chat', model: 'claude-sonnet-4-6', tools: [tool], autonomy: 'autonomous',
    toolContext: createToolContext({}),
    recordToolCall: (c) => { recs.push(c as Rec); },
    onStream: async (e) => { if (e.type === 'tool_result') events.push(e); },
  });
  await agent.send('go');
  const modelSaw = JSON.stringify(agent.getMessages().flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type?: string }).type === 'tool_result'));
  return { events, recs, modelSaw };
}

describe('save_workflow: a call that saved nothing is recorded as failed', () => {
  beforeEach(() => { mockProcess.mockReset(); });

  it('the refusal of a parameter name is recorded with is_error and a fixed reason; the model reads the refusal as before', async () => {
    const { events, recs, modelSaw } = await run(saveWorkflowAnswering(SESSION_PARAM_NAME_REFUSAL));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toEqual(expect.objectContaining({ toolName: 'save_workflow', isError: true }));
    expect(recs[0]!.outputJson).toBe('not saved: a parameter name outside the accepted form');
    expect(events[0]!.softFailure).toBe(true);
    expect(events[0]!.result).toBe(SESSION_PARAM_NAME_REFUSAL);
    expect(JSON.parse(modelSaw)).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'tu-1', content: SESSION_PARAM_NAME_REFUSAL })]);
  });

  it('control: a saved workflow is recorded as done, with an empty output', async () => {
    const saved = JSON.stringify({ workflow_id: 'wf-1', steps: 2, source: 'session', parameters: [] }, null, 2);
    const { events, recs } = await run(saveWorkflowAnswering(saved));
    expect(recs[0]).toEqual(expect.objectContaining({ toolName: 'save_workflow', isError: false }));
    expect(recs[0]!.outputJson).toBe('');
    expect(events[0]!.softFailure).toBeUndefined();
  });
});

describe('saveWorkflowFailure', () => {
  const SENT = 'SENT_q7';

  // Every reason is a fixed phrase; the answers carry SENT where a caller's or provider's text sits.
  it('gives each kind of answer its fixed reason and no text from the answer', () => {
    const cases: Array<[string, string]> = [
      [SESSION_PARAM_NAME_REFUSAL, 'not saved: a parameter name outside the accepted form'],
      [sessionAnalysisFailed(Object.assign(new Error(SENT), { status: 422 })), 'not saved: the session analysis failed'],
      ['No tool calls found in this session. Nothing to save as a workflow.', 'not saved: nothing in this session to save'],
      ['No actionable steps were found in this session. Nothing to save as a workflow.', 'not saved: nothing in this session to save'],
      [`Error: Workflow "${SENT}" not found. Pass a workflow_id returned by plan_task, or omit it to save this session's work.`, 'not saved: an error stopped the save'],
      [`Error saving workflow: ${SENT}`, 'not saved: an error stopped the save'],
      [`Error: Could not save the workflow (${SENT}). No workflow was saved.`, 'not saved: an error stopped the save'],
    ];
    for (const [answer, reason] of cases) {
      expect(saveWorkflowFailure(answer), answer).toBe(reason);
    }
  });

  it('control: a JSON answer is a done call', () => {
    expect(saveWorkflowFailure(JSON.stringify({ workflow_id: 'wf-1', steps: 2 }))).toBeNull();
    expect(saveWorkflowFailure(JSON.stringify({ workflow_id: 'wf-1', already_reusable: true, next: 'Error: not one' }))).toBeNull();
  });

  it('is what the tool declares', () => {
    expect(saveWorkflowTool.failureOf).toBe(saveWorkflowFailure);
  });
});
