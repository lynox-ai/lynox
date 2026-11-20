import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolEntry } from '../types/index.js';

// A save the owner makes in their own chat records its host as one they chose when the batch the
// save runs in began before any foreign content. Driven through the agent's own dispatch, which
// arms the conversation latch for `api_setup` before its handler runs.

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));
let lynoxDir: string;
vi.mock('./config.js', async (orig) => ({ ...(await orig<object>()), getLynoxDir: () => lynoxDir }));

import { Agent } from './agent.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { ConversationLatch } from './conversation-latch.js';
import { createToolContext } from './tool-context.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { bindingsAsMigrated } from '../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../tests/helpers/audit-log.js';

const PROFILE = {
  id: 'crm', name: 'crm', base_url: 'https://api.crm.example/v1', description: 'An API', auth: { type: 'none' },
  rate_limit: { requests_per_minute: 60 },
  endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
  guidelines: ['Read only'],
  avoid: ['No writes'],
} as unknown as ApiProfile;

const endTurn = { content: [{ type: 'text' as const, text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const batch = (...calls: Array<[string, Record<string, unknown>]>) => ({
  content: calls.map(([name, input], i) => ({ type: 'tool_use' as const, id: `tu_${name}_${String(i)}`, name, input })),
  stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 },
});

function foreignRead(): ToolEntry {
  return {
    definition: { name: 'web_research', description: 'web_research', input_schema: { type: 'object' as const, properties: {} } },
    handler: async () => 'a page',
  };
}

function ownersChat(store: ApiStore): Agent {
  const agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    principal: OWNER_PRINCIPAL,
    tools: [apiSetupTool as unknown as ToolEntry, foreignRead()],
    promptUser: async () => 'Allow',
    conversationLatch: ConversationLatch.detached(),
    toolContext: { ...createToolContext({}), auditLog: testAuditLog().log, apiStore: store, vaultNameBindings: bindingsAsMigrated(store) },
  } as ConstructorParameters<typeof Agent>[0]);
  agent.writeAuthor = 'owner';
  return agent;
}

const save = (): [string, Record<string, unknown>] => ['api_setup', { action: 'create', profile: PROFILE }];

describe('api_setup through the dispatch records the host of a save the owner made', () => {
  beforeEach(() => { lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-clean-host-')); mockProcess.mockReset(); });
  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  it('records the host when the batch began clean', async () => {
    const store = new ApiStore();
    mockProcess.mockResolvedValueOnce(batch(save())).mockResolvedValueOnce(endTurn);
    await ownersChat(store).send('connect my CRM');
    expect(store.get('crm')?.owner_clean_host).toBe('api.crm.example');
  });

  it('records the host when a foreign read runs in the same batch, whose result the save could not have seen', async () => {
    const store = new ApiStore();
    mockProcess.mockResolvedValueOnce(batch(['web_research', {}], save())).mockResolvedValueOnce(endTurn);
    await ownersChat(store).send('connect my CRM');
    expect(store.get('crm')?.owner_clean_host).toBe('api.crm.example');
  });

  it('does not record the host when the batch began after foreign content', async () => {
    const store = new ApiStore();
    mockProcess.mockResolvedValueOnce(batch(['web_research', {}])).mockResolvedValueOnce(batch(save())).mockResolvedValueOnce(endTurn);
    await ownersChat(store).send('connect my CRM');
    expect(store.get('crm')).toBeDefined();
    expect(store.get('crm')?.owner_clean_host).toBeUndefined();
  });

  it('does not record the host when an earlier api_setup call of the conversation came first, a bootstrap included', async () => {
    const store = new ApiStore();
    mockProcess.mockResolvedValueOnce(batch(['api_setup', { action: 'bootstrap' }])).mockResolvedValueOnce(batch(save())).mockResolvedValueOnce(endTurn);
    await ownersChat(store).send('connect my CRM');
    expect(store.get('crm')).toBeDefined();
    expect(store.get('crm')?.owner_clean_host).toBeUndefined();
  });

  it('does not record the host for a call made outside a batch', async () => {
    const store = new ApiStore();
    const agent = ownersChat(store);
    expect(agent.batchStartedTainted()).toBe(true);
    const run = agent as unknown as { _executeOneInner(tc: unknown): Promise<unknown> };
    await run._executeOneInner({ type: 'tool_use', id: 'tu_1', name: 'api_setup', input: save()[1] });
    expect(store.get('crm')).toBeDefined();
    expect(store.get('crm')?.owner_clean_host).toBeUndefined();
  });
});
