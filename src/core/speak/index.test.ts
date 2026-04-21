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
  });
});
