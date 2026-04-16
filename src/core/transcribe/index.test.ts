/**
 * Unit tests — transcribe facade (provider selection + glossary pipeline).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as facade from './index.js';
import * as configModule from '../config.js';
import { hasWhisperCpp } from './whisper-cpp.js';

function stubMistralKey(present: boolean): void {
  if (present) vi.stubEnv('MISTRAL_API_KEY', 'test-key-123');
  else vi.stubEnv('MISTRAL_API_KEY', '');
}

function stubConfig(transcription_provider: 'mistral' | 'whisper' | 'auto' | undefined): void {
  const spy = vi.spyOn(configModule, 'loadConfig');
  spy.mockReturnValue({ ...(transcription_provider ? { transcription_provider } : {}) } as Parameters<typeof spy.mockReturnValue>[0]);
}

describe('transcribe facade — provider resolution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('env LYNOX_TRANSCRIBE_PROVIDER=mistral picks mistral-voxtral when the key is set', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const p = facade.getActiveTranscribeProvider();
    expect(p?.name).toBe('mistral-voxtral');
  });

  it('env override returns null if the selected provider is unavailable', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(false);
    stubConfig(undefined);
    const p = facade.getActiveTranscribeProvider();
    expect(p).toBeNull();
  });

  it('config transcription_provider=whisper selects whisper.cpp when available', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', '');
    stubMistralKey(true);
    stubConfig('whisper');
    const p = facade.getActiveTranscribeProvider();
    if (hasWhisperCpp()) {
      expect(p?.name).toBe('whisper-cpp');
    } else {
      expect(p).toBeNull();
    }
  });

  it('auto mode prefers mistral when MISTRAL_API_KEY is set', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', '');
    stubMistralKey(true);
    stubConfig('auto');
    expect(facade.getActiveTranscribeProvider()?.name).toBe('mistral-voxtral');
  });

  it('auto mode falls back to whisper.cpp when no key (skipped if whisper unavailable on host)', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', '');
    stubMistralKey(false);
    stubConfig('auto');
    const p = facade.getActiveTranscribeProvider();
    if (hasWhisperCpp()) expect(p?.name).toBe('whisper-cpp');
    else expect(p).toBeNull();
  });

  it('env overrides config when both are set', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig('whisper');
    expect(facade.getActiveTranscribeProvider()?.name).toBe('mistral-voxtral');
  });

  it('invalid env value is ignored and config is consulted', () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'bogus');
    stubMistralKey(true);
    stubConfig('auto');
    expect(facade.getActiveTranscribeProvider()?.name).toBe('mistral-voxtral');
  });
});

describe('transcribe facade — glossary pipeline', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('transcribe() applies core glossary to the provider output', async () => {
    // Stub the mistral provider's transcribe with a mock that returns a Phase 0 mishearing.
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    const spy = vi.spyOn(facade.mistralVoxtralProvider, 'transcribe')
      .mockResolvedValue('Der Setup-Result ist ein Blockierer.');

    const out = await facade.transcribe(Buffer.from('irrelevant'), 'clip.webm');
    expect(out).toBe('Der Setup Wizard ist ein Blocker.');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('transcribe() applies session glossary when session context is given', async () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    vi.spyOn(facade.mistralVoxtralProvider, 'transcribe')
      .mockResolvedValue('Rolland ruft heute an.');

    const out = await facade.transcribe(Buffer.from(''), 'clip.webm', {
      session: { contactNames: ['Roland'] },
    });
    expect(out).toBe('Roland ruft heute an.');
  });

  it('transcribe() returns null when no provider resolves', async () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(false);
    stubConfig(undefined);
    const out = await facade.transcribe(Buffer.from(''), 'clip.webm');
    expect(out).toBeNull();
  });

  it('transcribe() returns null when the provider itself returns null', async () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    vi.spyOn(facade.mistralVoxtralProvider, 'transcribe').mockResolvedValue(null);
    const out = await facade.transcribe(Buffer.from(''), 'clip.webm');
    expect(out).toBeNull();
  });

  it('skipGlossary bypasses the post-process step entirely', async () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    vi.spyOn(facade.mistralVoxtralProvider, 'transcribe')
      .mockResolvedValue('Der Setup-Result war schlecht.');

    const out = await facade.transcribe(Buffer.from(''), 'clip.webm', { skipGlossary: true });
    expect(out).toBe('Der Setup-Result war schlecht.'); // untouched
  });

  it('legacy transcribeAudio delegates to transcribe() with core glossary', async () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    vi.spyOn(facade.mistralVoxtralProvider, 'transcribe')
      .mockResolvedValue('Setup-Result fertig');

    const out = await facade.transcribeAudio(Buffer.from(''), 'clip.webm', 'de');
    expect(out).toBe('Setup Wizard fertig');
  });
});

describe('transcribe facade — streaming fallback', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emits a synthetic final segment for providers without native streaming', async () => {
    vi.stubEnv('LYNOX_TRANSCRIBE_PROVIDER', 'mistral');
    stubMistralKey(true);
    stubConfig(undefined);
    vi.spyOn(facade.mistralVoxtralProvider, 'transcribe')
      .mockResolvedValue('Der Setup-Result ist ok.');

    const segments: string[] = [];
    const final = await facade.transcribeWithStream(Buffer.from(''), 'clip.webm', (s) => segments.push(s));
    expect(final).toBe('Der Setup Wizard ist ok.');
    // First segment is the empty "starting" signal, second is the final post-processed text.
    expect(segments[0]).toBe('');
    expect(segments[1]).toBe('Der Setup Wizard ist ok.');
  });
});
