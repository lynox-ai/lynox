import { describe, it, expect, vi, afterEach } from 'vitest';

// Mistral commits to EU/EFTA inference only for its regional endpoint `api.eu.mistral.ai`; for
// the global `api.mistral.ai` it commits to no location. Every Mistral route lynox calls goes to
// the EU one: chat (also when a stored config still names the global host), speech to text, text
// to speech, the voice catalogue and the account health check.

const EU = 'api.eu.mistral.ai';
const hostOf = (input: unknown): string => new URL(String(input)).hostname;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Records every URL fetched and answers with `answer`. */
function recordFetch(answer: () => Response): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => { urls.push(String(input)); return answer(); }));
  return urls;
}

describe('Mistral routes go to the EU regional endpoint', () => {
  it('chat: a base URL on the global endpoint is sent to the EU one', async () => {
    const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n';
    const urls = recordFetch(() => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const { OpenAIAdapter } = await import('./openai-adapter.js');
    for (const baseURL of ['https://api.mistral.ai/v1', 'https://api.eu.mistral.ai/v1']) {
      const adapter = new OpenAIAdapter({ baseURL, apiKey: 'test', modelId: 'mistral-medium-2604' });
      await adapter.beta.messages.stream({
        model: 'mistral-medium-2604', max_tokens: 5, messages: [{ role: 'user', content: 'x' }],
      } as Parameters<typeof adapter.beta.messages.stream>[0]).finalMessage();
    }
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(hostOf(url), url).toBe(EU);
  });

  it('chat twin: another endpoint is left where it is', async () => {
    const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n';
    const urls = recordFetch(() => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const { OpenAIAdapter } = await import('./openai-adapter.js');
    const adapter = new OpenAIAdapter({ baseURL: 'https://api.groq.com/openai/v1', apiKey: 'test', modelId: 'm' });
    await adapter.beta.messages.stream({
      model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }],
    } as Parameters<typeof adapter.beta.messages.stream>[0]).finalMessage();
    expect(hostOf(urls[0])).toBe('api.groq.com');
  });

  it('speech to text', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'test');
    const urls = recordFetch(() => Response.json({ text: 'hallo' }));
    const { transcribeMistralVoxtral } = await import('./transcribe/mistral-voxtral.js');
    await transcribeMistralVoxtral(Buffer.from('RIFF'), 'a.wav', 'de');
    expect(urls.map(hostOf)).toEqual([EU]);
  });

  it('text to speech', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'test');
    const urls = recordFetch(() => Response.json({ audio_data: Buffer.from('mp3').toString('base64') }));
    const { speakMistralVoxtral } = await import('./speak/mistral-voxtral-tts.js');
    await speakMistralVoxtral('Hallo');
    expect(urls.map(hostOf)).toEqual([EU]);
  });

  it('the voice catalogue', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'test');
    const urls = recordFetch(() => Response.json({ items: [], total: 0 }));
    const { listMistralVoices } = await import('./speak/mistral-voxtral-tts.js');
    await listMistralVoices();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(hostOf(url), url).toBe(EU);
  });
});
