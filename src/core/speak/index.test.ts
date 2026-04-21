/**
 * Unit tests — speak facade (provider selection + text-prep pipeline).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as facade from './index.js';
import * as configModule from '../config.js';
import type { SpeakResult, SpeakStreamMeta } from './types.js';

function stubMistralKey(present: boolean): void {
  if (present) vi.stubEnv('MISTRAL_API_KEY', 'test-key-123');
  else vi.stubEnv('MISTRAL_API_KEY', '');
}

function stubConfig(tts_provider: 'mistral' | 'auto' | undefined): void {
  const spy = vi.spyOn(configModule, 'loadConfig');
  spy.mockReturnValue({ ...(tts_provider ? { tts_provider } : {}) } as Parameters<typeof spy.mockReturnValue>[0]);
}

function fakeResult(characters: number): SpeakResult {
  return {
    mp3: new Uint8Array([0xff, 0xfb, 0x00]),
    characters,
    provider: 'mistral-voxtral-tts',
    model: 'voxtral-mini-tts-latest',
    voice: 'en_paul_neutral',
    latencyMs: 42,
  };
}

function fakeStreamMeta(characters: number): SpeakStreamMeta {
  return {
    characters,
    provider: 'mistral-voxtral-tts',
    model: 'voxtral-mini-tts-latest',
    voice: 'en_paul_neutral',
    latencyMs: 120,
    ttfbMs: 80,
  };
}

describe('speak facade — provider resolution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('env LYNOX_TTS_PROVIDER=mistral picks the mistral provider when the key is set', () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    expect(facade.getActiveSpeakProvider()?.name).toBe('mistral-voxtral-tts');
  });

  it('env override returns null when the selected provider is unavailable', () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(false);
    stubConfig(undefined);
    expect(facade.getActiveSpeakProvider()).toBeNull();
  });

  it('auto mode picks mistral when MISTRAL_API_KEY is set', () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', '');
    stubMistralKey(true);
    stubConfig('auto');
    expect(facade.getActiveSpeakProvider()?.name).toBe('mistral-voxtral-tts');
  });

  it('auto mode returns null when no API key is set', () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', '');
    stubMistralKey(false);
    stubConfig('auto');
    expect(facade.getActiveSpeakProvider()).toBeNull();
  });

  it('env overrides config when both are set', () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig('auto');
    expect(facade.getActiveSpeakProvider()?.name).toBe('mistral-voxtral-tts');
  });

  it('invalid env value is ignored and config is consulted', () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'bogus');
    stubMistralKey(true);
    stubConfig('auto');
    expect(facade.getActiveSpeakProvider()?.name).toBe('mistral-voxtral-tts');
  });

  it('hasSpeakProvider reflects MISTRAL_API_KEY presence', () => {
    stubMistralKey(true);
    expect(facade.hasSpeakProvider()).toBe(true);
    stubMistralKey(false);
    expect(facade.hasSpeakProvider()).toBe(false);
  });
});

describe('speak facade — text-prep pipeline', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('speak() applies text-prep before handing off to the provider', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const spy = vi.spyOn(facade.mistralVoxtralTtsProvider, 'speak')
      .mockImplementation((prepared: string) => Promise.resolve(fakeResult(prepared.length)));

    const out = await facade.speak('**bold** text');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe('bold text');
    expect(out?.characters).toBe('bold text'.length);
  });

  it('speak() skipTextPrep bypasses the sanitizer', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const spy = vi.spyOn(facade.mistralVoxtralTtsProvider, 'speak')
      .mockResolvedValue(fakeResult(12));

    await facade.speak('**bold** text', { skipTextPrep: true });
    expect(spy.mock.calls[0]?.[0]).toBe('**bold** text');
  });

  it('speak() returns null when no provider resolves', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(false);
    stubConfig(undefined);
    expect(await facade.speak('hello')).toBeNull();
  });

  it('speak() returns null when the prepared text is empty', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const spy = vi.spyOn(facade.mistralVoxtralTtsProvider, 'speak');
    const out = await facade.speak('```\n```');
    expect(out).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('speak() returns null when the provider itself returns null', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    vi.spyOn(facade.mistralVoxtralTtsProvider, 'speak').mockResolvedValue(null);
    expect(await facade.speak('hello')).toBeNull();
  });

  it('speak() forwards voice/model/tenantId/timeoutMs options', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const spy = vi.spyOn(facade.mistralVoxtralTtsProvider, 'speak')
      .mockResolvedValue(fakeResult(5));

    await facade.speak('hello', { voice: 'gb_oliver_neutral', model: 'voxtral-mini-tts-2603', tenantId: 't1', timeoutMs: 10_000 });
    expect(spy.mock.calls[0]?.[1]).toEqual({
      voice: 'gb_oliver_neutral',
      model: 'voxtral-mini-tts-2603',
      tenantId: 't1',
      timeoutMs: 10_000,
    });
  });

  it('speakStream() applies text-prep and emits chunks through the callback', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const chunks: Uint8Array[] = [];
    const spy = vi.spyOn(facade.mistralVoxtralTtsProvider, 'speakStream')
      .mockImplementation(async (prepared, onChunk) => {
        onChunk(new Uint8Array([1, 2]));
        onChunk(new Uint8Array([3]));
        return fakeStreamMeta(prepared.length);
      });

    const meta = await facade.speakStream('**Hello** world', (c) => chunks.push(c));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe('Hello world');
    expect(chunks).toHaveLength(2);
    expect(meta?.characters).toBe('Hello world'.length);
    expect(meta?.ttfbMs).toBe(80);
  });

  it('speakStream() returns null when no provider resolves', async () => {
    vi.stubEnv('LYNOX_TTS_PROVIDER', 'mistral');
    stubMistralKey(false);
    stubConfig(undefined);
    const out = await facade.speakStream('hello', () => void 0);
    expect(out).toBeNull();
  });

  describe('listMistralVoices (Compliance Phase 2)', () => {
    it('returns the hardcoded fallback catalog when no Mistral key is set', async () => {
      stubMistralKey(false);
      const voices = await facade.listMistralVoices();
      expect(voices.length).toBeGreaterThan(0);
      expect(voices[0]).toHaveProperty('id');
      expect(voices.find(v => v.id === 'en_paul_neutral')).toBeDefined();
    });

    it('parses Mistral live shape across paginated responses', async () => {
      stubMistralKey(true);
      // Mistral caps page_size at 10; full catalog (~30 voices today) spans
      // 3 pages. This fixture has total_pages=3 — the loop must fetch all
      // three and concatenate uniquely.
      const page1 = {
        items: [
          { slug: 'en_paul_neutral', name: 'Paul - Neutral', languages: ['en_us'] },
          { slug: 'en_alex_neutral', name: 'Alex - Neutral', languages: ['en_us'] },
        ],
        total: 6, page: 1, page_size: 10, total_pages: 3,
      };
      const page2 = {
        items: [
          { slug: 'gb_oliver_neutral', name: 'Oliver - Neutral', languages: ['en_gb'] },
          { slug: 'gb_jane_sarcasm', name: 'Jane - Sarcasm', languages: ['en_gb'] },
        ],
        total: 6, page: 2, page_size: 10, total_pages: 3,
      };
      const page3 = {
        items: [
          { slug: 'fr_aurelie', name: 'Aurélie', languages: ['fr_fr'] },
          // Intentional duplicate — parser must dedupe.
          { slug: 'en_paul_neutral', name: 'Paul - Neutral', languages: ['en_us'] },
        ],
        total: 6, page: 3, page_size: 10, total_pages: 3,
      };
      const pages = [page1, page2, page3];
      let callIdx = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const body = pages[callIdx] ?? pages[pages.length - 1];
        callIdx++;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        await vi.resetModules();
        const fresh = await import('./index.js');
        const voices = await fresh.listMistralVoices();
        // 5 unique — the duplicate en_paul_neutral on page 3 is deduped.
        expect(voices.length).toBe(5);
        expect(voices.map(v => v.id)).toEqual([
          'en_paul_neutral', 'en_alex_neutral',
          'gb_oliver_neutral', 'gb_jane_sarcasm',
          'fr_aurelie',
        ]);
        // Pagination hit all 3 pages.
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        // URLs use `page=N` — confirm page 2 and page 3 were requested.
        const urls = fetchSpy.mock.calls.map(c => String(c[0]));
        expect(urls[0]).toContain('page=1');
        expect(urls[1]).toContain('page=2');
        expect(urls[2]).toContain('page=3');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('falls back if first page returns non-ok (any page)', async () => {
      stubMistralKey(true);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('nope', { status: 503 }),
      );
      try {
        await vi.resetModules();
        const fresh = await import('./index.js');
        const voices = await fresh.listMistralVoices();
        // Fallback catalog has at least en_paul_neutral.
        expect(voices.find(v => v.id === 'en_paul_neutral')).toBeDefined();
        expect(voices.length).toBeGreaterThan(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
