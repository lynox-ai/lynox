/**
 * The two dialogs that would have the person at the screen type a credential for a route only
 * the owner may write: `mail_connect` (a mailbox password for `POST /api/mail/accounts`) and
 * `ask_secret` (a key for `PUT /api/secrets/:name`). A mandate's turn gets neither dialog, so
 * nothing it types leaves its hands. Driven through the agent's real dispatch
 * (`Agent._executeOneInner`), with the session's prompt hook storing its row in a real
 * PromptStore, so "no dialog" is read as "no row", and the owner is the control each time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {
    status: number;
    constructor(status: number, _error: unknown, message: string | undefined) { super(message ?? 'api'); this.status = status; this.name = 'APIError'; }
  }
  return { default: MockAnthropic, APIError };
});

const { Agent } = await import('./agent.js');
const { createToolContext } = await import('./tool-context.js');
const { RunHistory } = await import('./run-history.js');
const { PromptStore } = await import('./prompt-store.js');
const { MANDATE_TOOL_SURFACE, MANDATE_WITHHELD_TOOLS, toolLockFor } = await import('./mandate-tool-lock.js');
const { createMailConnectTool } = await import('../integrations/mail/tools/mail-connect.js');
const { askSecretTool, MANDATE_SECRET_REFUSAL } = await import('../tools/builtin/ask-secret.js');
type ToolEntry = import('../types/index.js').ToolEntry;
type RequestPrincipal = import('./request-principal.js').RequestPrincipal;

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', display: 'TEST-DISPLAY', mandateId: 'M-1' };

const histories: Array<InstanceType<typeof RunHistory>> = [];
afterEach(() => { for (const h of histories.splice(0)) h.close(); });

/** An agent with one tool, its principal, and prompt hooks that store their row as the session's do. */
function promptingAgent(tool: ToolEntry, principal: RequestPrincipal | undefined) {
  const history = new RunHistory(':memory:');
  histories.push(history);
  const store = new PromptStore(history.getDb());
  const promptMailConnect = vi.fn(async (data: { address: string }) => {
    store.insertConnectMail('s-1', `Connect mailbox ${data.address}`, JSON.stringify(data));
    return 'canceled' as const;
  });
  const promptSecret = vi.fn(async (name: string, prompt: string) => {
    store.insertAskSecret('s-1', name, prompt);
    return 'canceled' as const;
  });
  const agent = new Agent({
    name: 'test', model: 'claude-sonnet-4-6', tools: [tool], toolContext: createToolContext({} as never),
    promptMailConnect, promptSecret, ...(principal ? { principal } : {}),
  } as never);
  const rows = (): Array<{ prompt_type: string }> =>
    history.getDb().prepare('SELECT prompt_type FROM pending_prompts').all() as Array<{ prompt_type: string }>;
  const call = (name: string, input: Record<string, unknown>): Promise<{ content: unknown; is_error?: boolean }> =>
    (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_1', name, input });
  return { agent, promptMailConnect, promptSecret, rows, call };
}

describe('mail_connect is withheld from a mandate, kept for the owner', () => {
  it('is placed as withheld, with its reason, and is off the surface', () => {
    expect(MANDATE_TOOL_SURFACE.has('mail_connect')).toBe(false);
    expect(MANDATE_WITHHELD_TOOLS['mail_connect']).toBe('opens a form for a mailbox password, and only the owner adds a mail account');
    expect(toolLockFor(MANDATE)?.has('mail_connect')).toBe(false);
  });

  it('is not offered to a mandate\'s turn, and an injected call opens no form and stores no row', async () => {
    const { agent, promptMailConnect, rows, call } = promptingAgent(createMailConnectTool() as ToolEntry, MANDATE);
    expect(agent.getAvailableTools().map(t => t.definition.name)).not.toContain('mail_connect');
    const r = await call('mail_connect', { email: 'anna@gmail.com' });
    expect(r.is_error).toBe(true);
    // What the model reads instead names no setting the person could not open.
    expect(String(r.content)).toContain('Tool not available in this session: mail_connect');
    expect(String(r.content)).not.toMatch(/settings/i);
    expect(promptMailConnect).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('control: the owner is offered it, and the same call opens the form and stores its row', async () => {
    const { agent, promptMailConnect, rows, call } = promptingAgent(createMailConnectTool() as ToolEntry, undefined);
    expect(agent.getAvailableTools().map(t => t.definition.name)).toContain('mail_connect');
    const r = await call('mail_connect', { email: 'anna@gmail.com' });
    expect(String(r.content)).toContain('dismissed the secure connect form');
    expect(promptMailConnect).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([{ prompt_type: 'connect_mail' }]);
  });
});

describe('ask_secret refuses a mandate before any dialog, and asks the owner', () => {
  it('answers a mandate\'s turn with the refusal, opens no dialog and stores no row', async () => {
    const { agent, promptSecret, rows, call } = promptingAgent(askSecretTool as ToolEntry, MANDATE);
    // It stays offered: the refusal is what tells the model who stores keys.
    expect(agent.getAvailableTools().map(t => t.definition.name)).toContain('ask_secret');
    const r = await call('ask_secret', { name: 'SHOPIFY_TOKEN', prompt: 'Paste the Shopify token' });
    expect(r.content).toBe(MANDATE_SECRET_REFUSAL);
    expect(promptSecret).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('refuses before the name checks, whose answers would name what the owner stores', async () => {
    const ask = async (principal: RequestPrincipal | undefined) => {
      const findNameMatches = vi.fn(() => ['SHOPIFY_TOKEN']);
      const { agent, call } = promptingAgent(askSecretTool as ToolEntry, principal);
      (agent as unknown as { secretStore: unknown }).secretStore = {
        findNameMatches, extractSecretNames: () => [], maskSecrets: (s: string) => s,
      };
      const r = await call('ask_secret', { name: 'SHOPIFY_TOKEN', prompt: 'Paste the Shopify token' });
      return { content: String(r.content), findNameMatches };
    };
    const mandate = await ask(MANDATE);
    expect(mandate.content).toBe(MANDATE_SECRET_REFUSAL);
    expect(mandate.findNameMatches).not.toHaveBeenCalled();
    // control: the owner's call reaches the check, and its answer names the stored key
    const owner = await ask(undefined);
    expect(owner.findNameMatches).toHaveBeenCalledTimes(1);
    expect(owner.content).toContain('"SHOPIFY_TOKEN"');
  });

  // The checks a connection's token brought in (scope, stored names, the API profiles that hold a
  // name) answer about the owner's vault too, so the refusal comes before every one of them.
  it('refuses before the scope check, the stored names and the API profiles are read', async () => {
    const ask = async (principal: RequestPrincipal | undefined) => {
      const touched: string[] = [];
      const apiStore = new Proxy({}, {
        get: (_t, key) => { touched.push(`apiStore.${String(key)}`); return () => []; },
      });
      const store = {
        findNameMatches: vi.fn(() => []),
        explainUnresolved: vi.fn(() => 'out-of-scope'),
        listAgentVisibleNames: vi.fn(() => ['SHOPIFY_TOKEN']),
        extractSecretNames: () => [], maskSecrets: (s: string) => s,
      };
      const { agent, call } = promptingAgent(askSecretTool as ToolEntry, principal);
      (agent as unknown as { secretStore: unknown }).secretStore = store;
      (agent as unknown as { toolContext: { apiStore?: unknown } }).toolContext.apiStore = apiStore;
      const r = await call('ask_secret', { name: 'SHOPIFY_TOKEN', prompt: 'Paste the Shopify token' });
      return { content: String(r.content), store, touched };
    };
    const mandate = await ask(MANDATE);
    expect(mandate.content).toBe(MANDATE_SECRET_REFUSAL);
    expect(mandate.store.explainUnresolved).not.toHaveBeenCalled();
    expect(mandate.store.listAgentVisibleNames).not.toHaveBeenCalled();
    expect(mandate.store.findNameMatches).not.toHaveBeenCalled();
    expect(mandate.touched).toEqual([]);
    // control: the owner's same call reaches each of them
    const owner = await ask(undefined);
    expect(owner.store.explainUnresolved).toHaveBeenCalledWith('SHOPIFY_TOKEN');
    expect(owner.store.listAgentVisibleNames).toHaveBeenCalled();
    expect(owner.touched.length).toBeGreaterThan(0);
  });

  it('control: the owner\'s same call opens the dialog and stores its row', async () => {
    const { promptSecret, rows, call } = promptingAgent(askSecretTool as ToolEntry, undefined);
    const r = await call('ask_secret', { name: 'SHOPIFY_TOKEN', prompt: 'Paste the Shopify token' });
    expect(String(r.content)).toContain('User canceled the secret prompt for "SHOPIFY_TOKEN"');
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([{ prompt_type: 'ask_secret' }]);
  });

  // The refusal is prompt surface: it teaches the model what to do next, so it must not teach a retry.
  it('says who stores keys and asks for nothing again', () => {
    expect(MANDATE_SECRET_REFUSAL).toBe(
      'Refused: in this session no key or password is entered. Only the owner of this instance stores keys. ' +
      'A profile you save here asks the owner to release the keys it reads, and until the owner does, the engine ' +
      'sends nothing under those keys. Tell the user to ask the owner to do it in a chat of the owner\'s own: ' +
      'store the key there if it is not stored yet, and, if a profile saved here reads it, ask lynox there to release ' +
      'it to that profile, naming the key and the profile. Do not ask for the key again, and never ask the user to ' +
      'paste it into this chat.');
    expect(MANDATE_SECRET_REFUSAL).not.toMatch(/\bretry\b|\btry again\b|corrected name|different name|settings/i);
  });
});
