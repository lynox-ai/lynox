import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A model id written with a `[1m]` suffix reaches the provider as its base id, whichever way it
 * was configured. Driven from the resolver that a configured id passes through, into a real SDK
 * client from `createLLMClient`, and read back from the body the client puts on the wire.
 */

interface Sent { url: string; body: Record<string, unknown> }
let sent: Sent[];

const REPLY = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
};

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(REPLY), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function sendWith(model: string): Promise<string> {
  const { createLLMClient } = await import('./llm-client.js');
  const client = createLLMClient({ provider: 'anthropic', apiKey: 'test-key' });
  await client.messages.create({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] });
  expect(sent).toHaveLength(1);
  return String(sent[0]!.body['model']);
}

describe('a [1m] id goes out as its base id', () => {
  beforeEach(() => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });

  it('from a hybrid tier_set slot', async () => {
    const { setTierSetResolver, resolveTierModel } = await import('./tier-resolver.js');
    setTierSetResolver({ routingMode: 'hybrid', tierSet: { balanced: { provider: 'anthropic', model_id: 'claude-sonnet-4-6[1m]' } } });
    try {
      const snap = resolveTierModel('balanced', 'anthropic');
      expect(snap.modelId).toBe('claude-sonnet-4-6[1m]');
      expect(await sendWith(snap.modelId)).toBe('claude-sonnet-4-6');
    } finally {
      setTierSetResolver({ routingMode: 'standard', tierSet: null });
    }
  });

  it('from a pinned model id, as a pipeline step names one', async () => {
    const { resolveRunModel } = await import('./tier-resolver.js');
    const run = resolveRunModel({
      requested: 'claude-opus-4-6[1m]', defaultTier: 'balanced', accountTier: undefined,
      maxTier: undefined, blockedModelIds: undefined, provider: 'anthropic',
    });
    expect(run).toMatchObject({ modelId: 'claude-opus-4-6[1m]', pinned: true });
    expect(await sendWith(run.modelId)).toBe('claude-opus-4-6');
  });

  it('leaves an id without the suffix as it is', async () => {
    expect(await sendWith('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('the one-time notice', () => {
  beforeEach(() => { vi.resetModules(); });

  it('names the base id and, for Sonnet 4.6, the smaller window, once per id', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { shapeRequestForModel } = await import('./llm-wire-rules.js');
    shapeRequestForModel({ model: 'claude-sonnet-4-6[1m]' });
    shapeRequestForModel({ model: 'claude-sonnet-4-6[1m]' });
    const lines = write.mock.calls.map(([l]) => String(l)).filter(l => l.startsWith('[lynox:model]'));
    expect(lines).toEqual([
      '[lynox:model] "claude-sonnet-4-6[1m]" is sent as "claude-sonnet-4-6"; its context window is 200000 tokens, not 1M.\n',
    ]);
  });

  it('names only the base id for Opus 4.6, whose base window is 1M', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { shapeRequestForModel } = await import('./llm-wire-rules.js');
    shapeRequestForModel({ model: 'claude-opus-4-6[1m]' });
    const lines = write.mock.calls.map(([l]) => String(l)).filter(l => l.startsWith('[lynox:model]'));
    expect(lines).toEqual(['[lynox:model] "claude-opus-4-6[1m]" is sent as "claude-opus-4-6".\n']);
  });

  it('quotes the id, so a line break in it stays on the notice line', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { shapeRequestForModel } = await import('./llm-wire-rules.js');
    shapeRequestForModel({ model: 'x\n[lynox:forged] y[1m]' });
    const out = write.mock.calls.map(([l]) => String(l)).join('');
    expect(out.split('\n').filter(l => l.startsWith('[lynox:forged]'))).toEqual([]);
  });

  it('stops noting after 64 distinct ids', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { shapeRequestForModel } = await import('./llm-wire-rules.js');
    for (let i = 0; i < 70; i++) shapeRequestForModel({ model: `m-${String(i)}[1m]` });
    expect(write.mock.calls.filter(([l]) => String(l).startsWith('[lynox:model]'))).toHaveLength(64);
  });

  it('says nothing for an id without the suffix', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { shapeRequestForModel } = await import('./llm-wire-rules.js');
    shapeRequestForModel({ model: 'claude-sonnet-4-6' });
    expect(write.mock.calls.filter(([l]) => String(l).startsWith('[lynox:model]'))).toEqual([]);
  });
});
