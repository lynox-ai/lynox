/**
 * Online integration test — Mistral Voxtral TTS endpoint.
 *
 * Gated on `MISTRAL_API_KEY`. When the gate fails the whole describe block is
 * skipped so CI stays green on the public OSS repo.
 *
 * What it asserts:
 *   1. Real `POST /v1/audio/speech` plain + stream calls succeed.
 *   2. Plain response returns a non-empty MP3 payload (ID3 or raw MPEG frame).
 *   3. Stream response emits at least one `speech.audio.delta` chunk and hits
 *      a first-byte latency under the generous ceiling of 3 s from Zurich.
 *   4. The text-prep pipeline roundtrips through the facade end-to-end.
 */

import { describe, expect, it } from 'vitest';
import { speak, speakStream } from '../../src/core/speak/index.js';

const API_KEY_PRESENT = !!process.env['MISTRAL_API_KEY'];

const SHORT_DE = 'Schick das Follow-up bis morgen.';
const LONGER_DE = [
  'Das Deployment auf Staging lief heute Morgen durch.',
  'Die Action Items sind: Call mit Marketing, Follow-up Mail und Review der Landing Page.',
  'Details findest du im Dashboard.',
].join(' ');

function looksLikeMp3(bytes: Uint8Array): boolean {
  // ID3v2 tag: "ID3" at offset 0
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  // Raw MPEG audio frame sync: 0xFF Ex (or Fx)
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return true;
  return false;
}

describe.skipIf(!API_KEY_PRESENT)('Voxtral TTS online integration (gated)', () => {
  it('plain: synthesizes a short DE reply into a playable MP3 blob', { timeout: 30_000 }, async () => {
    const out = await speak(SHORT_DE);
    expect(out).toBeTruthy();
    expect(out?.provider).toBe('mistral-voxtral-tts');
    expect(out?.mp3.byteLength).toBeGreaterThan(1000);
    expect(looksLikeMp3(out!.mp3)).toBe(true);
    expect(out?.characters).toBe(SHORT_DE.length);
  });

  it('stream: emits at least one audio chunk and meets a generous TTFB ceiling', { timeout: 30_000 }, async () => {
    const chunks: Uint8Array[] = [];
    const meta = await speakStream(LONGER_DE, (c) => chunks.push(c));
    expect(meta).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
    const first = chunks[0]!;
    expect(first.byteLength).toBeGreaterThan(0);
    // Phase 0 measured ~1 s TTFB from Zurich; 3 s is generous for CI variance.
    expect(meta?.ttfbMs ?? Infinity).toBeLessThan(3_000);
  });

  it('text-prep: Markdown roundtrips cleanly through the facade', { timeout: 30_000 }, async () => {
    const md = 'Heute:\n- Deployment\n- Follow-up\n- Review';
    const out = await speak(md);
    expect(out).toBeTruthy();
    // Character count is post-prep, so Markdown noise must have been stripped.
    expect(out!.characters).toBeLessThan(md.length);
    expect(looksLikeMp3(out!.mp3)).toBe(true);
  });
});

if (!API_KEY_PRESENT) {
  // eslint-disable-next-line no-console
  console.log('[voxtral-tts.test] skipped: MISTRAL_API_KEY missing');
}
