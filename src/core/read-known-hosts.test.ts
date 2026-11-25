import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolEntry, PromptText } from '../types/index.js';

/**
 * A connected API's host counts for reads after foreign content when the owner chose it: the
 * exact `base_url` host of a profile the owner accepted at a save or saved in a tool batch that
 * began before any foreign content. Never for a send, never for a profile a mandate wrote.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));
let lynoxDir: string;
vi.mock('./config.js', async (orig) => ({ ...(await orig<object>()), getLynoxDir: () => lynoxDir }));

import { Agent } from './agent.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { OwnerKnownTargets } from './owner-known-targets.js';
import { ConversationLatch } from './conversation-latch.js';
import { flattenPrompt } from './prompt-value.js';
import { createToolContext } from './tool-context.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { bindingsAsMigrated } from '../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../tests/helpers/audit-log.js';

const COMPLETE = {
  rate_limit: { requests_per_minute: 60 },
  endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
  guidelines: ['Read only'],
  avoid: ['No writes'],
} as const;

function profile(id: string, baseUrl: string, extra: Partial<ApiProfile> = {}): ApiProfile {
  return { id, name: id, base_url: baseUrl, description: 'An API', auth: { type: 'none' }, ...COMPLETE, ...extra } as ApiProfile;
}

describe('ApiStore.readKnownHosts', () => {
  it('counts the exact host of a profile saved clean or accepted, and nothing else', () => {
    const store = new ApiStore();
    store.register(profile('clean', 'https://api.clean.example/v1', { owner_clean_host: 'api.clean.example' }));
    store.register(profile('acked', 'https://api.acked.example/v1', { custom_endpoint_ack: { accepted: true, hosts: ['api.acked.example'], accepted_at: '2026-11-20T00:00:00Z' } }));
    store.register(profile('plain', 'https://api.plain.example/v1'));
    store.register(profile('moved', 'https://api.moved.example/v1', { owner_clean_host: 'api.old.example' }));
    store.register(profile('mandate', 'https://api.mandate.example/v1', { owner_clean_host: 'api.mandate.example', created_by: 'mandate:helper@example.com' }));
    store.register(profile('ackother', 'https://api.ackother.example/v1', { custom_endpoint_ack: { accepted: true, hosts: ['auth.ackother.example'], accepted_at: '2026-11-20T00:00:00Z' } }));
    expect([...store.readKnownHosts()].sort()).toEqual(['api.acked.example', 'api.clean.example']);
    expect([...store.profileHosts()].sort()).toEqual(['api.acked.example', 'api.ackother.example', 'api.clean.example', 'api.mandate.example', 'api.moved.example', 'api.plain.example']);
  });
});

describe('api_setup stamps a save the owner made in a batch that began clean', () => {
  beforeEach(() => { lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-read-known-')); });
  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  function agentFor(store: ApiStore, tainted: boolean, run: { writeAuthor?: string; sendOrigin?: unknown } = { writeAuthor: 'owner' }) {
    return {
      principal: OWNER_PRINCIPAL,
      batchStartedTainted: () => tainted,
      heldProviderSearch: () => false,
      ...run,
      sessionCounters: { httpRequests: 0 },
      promptUser: async () => 'Allow',
      secretStore: { resolve: (): string | null => null, listNames: (): string[] => [] },
      toolContext: { ...createToolContext({}), auditLog: testAuditLog().log, apiStore: store, vaultNameBindings: bindingsAsMigrated(store) },
    } as never;
  }

  it('a batch that began clean stamps the host; one that began after foreign content does not, and drops a stamp the input carries', async () => {
    const store = new ApiStore();
    const clean = await apiSetupTool.handler({ action: 'create', profile: profile('crm', 'https://api.crm.example/v1') }, agentFor(store, false)) as string;
    expect(clean).toContain('Created API profile');
    expect(store.get('crm')?.owner_clean_host).toBe('api.crm.example');
    expect(store.readKnownHosts().has('api.crm.example')).toBe(true);

    const forged = await apiSetupTool.handler({ action: 'update', profile: profile('crm', 'https://api.crm.example/v1', { owner_clean_host: 'api.crm.example' }) }, agentFor(store, true)) as string;
    expect(forged).toContain('API profile');
    expect(store.get('crm')?.owner_clean_host).toBeUndefined();
    // The host still counts, by the acceptance the owner answered at this save, not by the stamp.
    expect(store.get('crm')?.custom_endpoint_ack?.accepted).toBe(true);
  });

  for (const missing of ['batchStartedTainted', 'heldProviderSearch'] as const) {
    it(`an agent without ${missing} does not stamp`, async () => {
      const store = new ApiStore();
      const agent = { ...(agentFor(store, false) as object), [missing]: undefined } as never;
      const out = await apiSetupTool.handler({ action: 'create', profile: profile('crm', 'https://api.crm.example/v1') }, agent) as string;
      expect(out).toContain('Created API profile');
      expect(store.get('crm')?.owner_clean_host).toBeUndefined();
    });
  }

  for (const [label, run] of [
    ["a trigger's run", { writeAuthor: 'trigger:t1' }],
    ["a workflow's run", { writeAuthor: 'workflow:w1' }],
    ['a run whose author is not known', {}],
    ['a sub-agent of the owner\'s chat', { writeAuthor: 'owner', sendOrigin: { kind: 'childAgent' } }],
  ] as const) {
    it(`a clean save in ${label} under the owner's principal does not stamp`, async () => {
      const store = new ApiStore();
      const out = await apiSetupTool.handler({ action: 'create', profile: profile('crm', 'https://api.crm.example/v1') }, agentFor(store, false, run)) as string;
      expect(out).toContain('Created API profile');
      expect(store.get('crm')?.owner_clean_host).toBeUndefined();
    });
  }
});

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };

function http(): ToolEntry & { sent: string[] } {
  const sent: string[] = [];
  return {
    ...(httpRequestTool as unknown as ToolEntry),
    sent,
    handler: async (input: { url: string }) => { sent.push(input.url); return 'ok'; },
  } as unknown as ToolEntry & { sent: string[] };
}

function agentWith(tool: ToolEntry, store: ApiStore, asked: string[]): Agent {
  const agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools: [tool],
    promptUser: async (q: string | PromptText) => { asked.push(flattenPrompt(q)); return 'Deny'; },
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => ['nothing named'] }),
    conversationLatch: ConversationLatch.detached(),
    toolContext: { ...createToolContext({}), apiStore: store },
  } as ConstructorParameters<typeof Agent>[0]);
  agent.restoreConversationTaint();
  return agent;
}

const call = (agent: Agent, input: Record<string, unknown>): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `h${Math.random()}`, name: 'http_request', input });

describe('a GET to a connected API after foreign content', () => {
  const store = new ApiStore();
  store.register(profile('crm', 'https://api.crm.example/v1', { owner_clean_host: 'api.crm.example' }));
  store.register(profile('old', 'https://api.old.example/v1'));

  it('to the host of a profile the owner saved clean is sent without a question', async () => {
    const tool = http(); const asked: string[] = [];
    await call(agentWith(tool, store, asked), { url: 'https://api.crm.example/v1/items?page=2' });
    expect(asked).toEqual([]);
    expect(tool.sent).toEqual(['https://api.crm.example/v1/items?page=2']);
  });

  it('to a subdomain of that host is asked about: the host counts exactly', async () => {
    const tool = http(); const asked: string[] = [];
    await call(agentWith(tool, store, asked), { url: 'https://x.api.crm.example/v1/items' });
    expect(asked).toHaveLength(1);
    expect(tool.sent).toEqual([]);
  });

  it('a write to that host is still asked about: a profile never makes a send target known', async () => {
    const tool = http(); const asked: string[] = [];
    await call(agentWith(tool, store, asked), { url: 'https://api.crm.example/v1/items', method: 'POST', body: '{"a":1}' });
    expect(asked).toHaveLength(1);
    expect(tool.sent).toEqual([]);
  });

  it('to the host of a profile without stamp or acceptance is asked about, and the question says how it would count', async () => {
    const tool = http(); const asked: string[] = [];
    await call(agentWith(tool, store, asked), { url: 'https://api.old.example/v1/items' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('belongs to a saved connection. Ask lynox in a new conversation to save that connection again');
    expect(tool.sent).toEqual([]);
  });

  it('CONTROL: a host no profile names gets the question without that sentence', async () => {
    const tool = http(); const asked: string[] = [];
    await call(agentWith(tool, store, asked), { url: 'https://elsewhere.example/p' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('saved connection');
  });
});
