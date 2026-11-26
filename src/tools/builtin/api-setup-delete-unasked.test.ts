import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptText } from '../../types/index.js';

/**
 * An `api_setup` delete in an autonomous run is refused before anyone is asked: its prompt channel
 * only parks a question for later, and the handler refuses the delete whatever the answer. The
 * declarations under test are the tool's own (`apiSetupTool`); only its handler is replaced, so
 * nothing is deleted and the test sees whether it was reached.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('../../core/stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from '../../core/agent.js';
import { OwnerKnownTargets } from '../../core/owner-known-targets.js';
import { ConversationLatch } from '../../core/conversation-latch.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { apiSetupTool } from './api-setup.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };

function tool(): ToolEntry & { reached: unknown[] } {
  const reached: unknown[] = [];
  return {
    ...(apiSetupTool as unknown as ToolEntry),
    reached,
    handler: async (input: unknown) => { reached.push(input); return 'deleted'; },
  } as unknown as ToolEntry & { reached: unknown[] };
}

function agentOf(t: ToolEntry, asked: string[], autonomy: 'autonomous' | 'supervised'): Agent {
  return new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools: [t], autonomy,
    promptUser: async (q: string | PromptText) => { asked.push(flattenPrompt(q)); return 'allow'; },
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => ['nothing named'] }),
    conversationLatch: ConversationLatch.detached(),
  } as ConstructorParameters<typeof Agent>[0]);
}

const call = (agent: Agent, input: unknown): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `d${Math.random()}`, name: 'api_setup', input });

describe('api_setup delete in an autonomous run', () => {
  it('is refused before the guard asks, and the handler is not reached', async () => {
    const t = tool();
    const asked: string[] = [];
    const result = await call(agentOf(t, asked, 'autonomous'), { action: 'delete', id: 'svc' });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('Blocked: connection "svc" not deleted. Deleting a connection needs the user\'s acceptance, and a scheduled or background run cannot ask them.');
    expect(asked).toEqual([]);
    expect(t.reached).toEqual([]);
  });

  it('control: a supervised delete reaches the handler, which asks its own question', async () => {
    const t = tool();
    const asked: string[] = [];
    const result = await call(agentOf(t, asked, 'supervised'), { action: 'delete', id: 'svc' });
    expect(result.is_error).not.toBe(true);
    expect(asked).toEqual([]);
    expect(t.reached).toEqual([{ action: 'delete', id: 'svc' }]);
  });
});
