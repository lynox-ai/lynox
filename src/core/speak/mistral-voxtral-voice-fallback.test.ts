import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Measured 2026-11-07 on staging and against the API: Mistral's catalogue has a German
 * voice (`voice_481`), the language pick chooses it for German text, and the pinned
 * model refuses it with 400 / code `3051`, "voice is not supported for speech v1".
 * Every German reader got silence. The stub answers exactly that body for any voice
 * outside `SPOKEN`, so the tests drive the measured shape, not an invented one.
 */

const REFUSAL = JSON.stringify({
  object: 'error',
  message: 'voice is not supported for speech v1',
  type: 'invalid_request_invalid_args',
  param: null,
  code: '3051',
  raw_status_code: 400,
});

const SPOKEN = new Set(['en_paul_neutral', 'fr_marie_neutral']);
const MP3 = Buffer.from('ID3-fake-mp3').toString('base64');

interface Sent { readonly voice: string; readonly model: string; readonly stream: boolean; readonly accept: string | null }
const sent: Sent[] = [];

function stubSpeech(opts: { refusal?: { status: number; body: string } } = {}) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { voice: string; model: string; stream: boolean };
    const headers = init.headers as Record<string, string>;
    sent.push({ voice: body.voice, model: body.model, stream: body.stream, accept: headers['accept'] ?? null });
    if (!SPOKEN.has(body.voice)) {
      const r = opts.refusal ?? { status: 400, body: REFUSAL };
      return new Response(r.body, { status: r.status, statusText: 'Bad Request' });
    }
    if (body.stream) {
      const frame = `event: speech.audio.delta\ndata: ${JSON.stringify({ audio_data: MP3 })}\n\n`;
      return new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ audio_data: MP3 }), { status: 200 });
  });
}

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv('MISTRAL_API_KEY', 'test-key-not-a-secret');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  stderr.mockRestore();
});

async function load() {
  vi.resetModules();
  return import('./mistral-voxtral-tts.js');
}

function written(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

describe('a voice the pinned model cannot speak is read with the default voice', () => {
  it('reads a one-shot request for voice_481 with en_paul_neutral, asking twice', async () => {
    vi.stubGlobal('fetch', stubSpeech());
    const { speakMistralVoxtral, VOXTRAL_TTS_MODEL } = await load();
    const result = await speakMistralVoxtral('Guten Tag.', { voice: 'voice_481' });
    expect(result).not.toBeNull();
    expect(result?.voice).toBe('en_paul_neutral');
    expect(sent.map((s) => s.voice)).toEqual(['voice_481', 'en_paul_neutral']);
    expect(sent.every((s) => s.model === VOXTRAL_TTS_MODEL && !s.stream)).toBe(true);
    expect(written()).toContain('cannot speak voice=voice_481; reading with voice=en_paul_neutral');
  });

  it('reads a streamed request for voice_481 with en_paul_neutral and keeps the stream headers', async () => {
    vi.stubGlobal('fetch', stubSpeech());
    const { speakMistralVoxtralStream } = await load();
    const chunks: Uint8Array[] = [];
    const meta = await speakMistralVoxtralStream('Guten Tag.', (c) => { chunks.push(c); }, { voice: 'voice_481' });
    expect(meta?.voice).toBe('en_paul_neutral');
    expect(chunks.length).toBe(1);
    expect(sent.map((s) => [s.voice, s.stream, s.accept])).toEqual([
      ['voice_481', true, 'text/event-stream'],
      ['en_paul_neutral', true, 'text/event-stream'],
    ]);
  });

  it('reads German text without a chosen voice: the language pick takes voice_481, the read falls back', async () => {
    // The whole measured path: `speakStream` → `resolveVoice` → catalogue → `voice_481`
    // → refusal → default voice. The catalogue stub returns the German voice the live
    // catalogue has.
    const speech = stubSpeech();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/v1/audio/voices')) {
        return new Response(JSON.stringify({
          items: [
            { slug: 'en_paul_neutral', name: 'Paul - Neutral', languages: ['en_us'], id: 'u1' },
            { slug: 'voice_481', name: 'Heidi', languages: ['de_de'], id: 'u2' },
          ],
          total: 2,
        }), { status: 200 });
      }
      return speech(url, init);
    }));
    vi.resetModules();
    const { speakStream } = await import('./index.js');
    const meta = await speakStream('Guten Tag, das ist ein Test.', () => {}, { voiceLanguage: 'de' });
    expect(sent.map((s) => s.voice)).toEqual(['voice_481', 'en_paul_neutral']);
    expect(meta?.voice).toBe('en_paul_neutral');
  });

  it('asks only once when the voice is spoken', async () => {
    vi.stubGlobal('fetch', stubSpeech());
    const { speakMistralVoxtral } = await load();
    const result = await speakMistralVoxtral('Bonjour.', { voice: 'fr_marie_neutral' });
    expect(result?.voice).toBe('fr_marie_neutral');
    expect(sent.map((s) => s.voice)).toEqual(['fr_marie_neutral']);
  });
});

describe('the voice in the fallback log line is a plain id or nothing', () => {
  it('replaces a voice with a newline instead of writing it', async () => {
    vi.stubGlobal('fetch', stubSpeech());
    const { speakMistralVoxtral } = await load();
    await speakMistralVoxtral('Guten Tag.', { voice: 'voice_481\n[fake] line' });
    expect(written()).toContain('cannot speak voice=<not an id>; reading with voice=en_paul_neutral');
    expect(written()).not.toContain('[fake] line');
  });
});

describe('every other refusal still fails, without a second request', () => {
  const cases: Array<[string, { status: number; body: string }]> = [
    ['a 400 with another code', { status: 400, body: JSON.stringify({ code: '3050', message: 'other' }) }],
    // The refusal's own message with another code: the code decides, not the wording.
    ['a 400 with the refusal message but another code', { status: 400, body: JSON.stringify({ code: '3050', message: 'voice is not supported for speech v1' }) }],
    ['a 401 that carries code 3051', { status: 401, body: REFUSAL }],
    ['a 400 whose body is not JSON', { status: 400, body: 'voice is not supported for speech v1' }],
  ];
  for (const [name, refusal] of cases) {
    it(`${name}: returns null and asks once`, async () => {
      vi.stubGlobal('fetch', stubSpeech({ refusal }));
      const { speakMistralVoxtral } = await load();
      expect(await speakMistralVoxtral('Guten Tag.', { voice: 'voice_481' })).toBeNull();
      expect(sent.map((s) => s.voice)).toEqual(['voice_481']);
      expect(written()).not.toContain('reading with voice=');
    });
  }

  it('the default voice refused is not retried with itself', async () => {
    const fetchSpy = vi.fn(async () => new Response(REFUSAL, { status: 400, statusText: 'Bad Request' }));
    vi.stubGlobal('fetch', fetchSpy);
    const { speakMistralVoxtral } = await load();
    expect(await speakMistralVoxtral('Hello.')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a fallback that is refused too returns null after two requests', async () => {
    const fetchSpy = vi.fn(async () => new Response(REFUSAL, { status: 400, statusText: 'Bad Request' }));
    vi.stubGlobal('fetch', fetchSpy);
    const { speakMistralVoxtralStream } = await load();
    expect(await speakMistralVoxtralStream('Guten Tag.', () => {}, { voice: 'voice_481' })).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
