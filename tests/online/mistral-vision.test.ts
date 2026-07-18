/**
 * Online guard for the gen-3 Mistral vision capability (#2).
 *
 * The bug: an uploaded image (an iPhone screenshot = PNG) never reached a
 * Mistral-tier tenant's model. Root cause was a STALE `vision: false` flag on
 * the gen-3 Mistral capability entries — the openai-adapter reads
 * `modelCapability(model).features.vision` and, when false, THROWS before the
 * image is ever sent (openai-adapter.ts translateMessages). The models are in
 * fact multimodal; the flag was wrong.
 *
 * This test is the fb_skip_ne_pass_green guard: it drives the REAL adapter path
 * with a real image against the real Mistral API, using the DATED model ids
 * (`*-2512`) so `modelCapability` resolves to the flipped entry — not the
 * `-latest` alias, which has no capability entry and would take the
 * unknown-model translate path regardless of the flag. A regression that flips
 * vision back to false makes `agent.send` REJECT (the adapter throw), failing
 * this test loudly instead of silently answering an unseen image.
 *
 * Requires MISTRAL_API_KEY. Skipped without it. Uses dated snapshots only
 * (fb_mistral_stable_tag — never the rate-limited `-latest`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
const describeOnline = MISTRAL_KEY ? describe : describe.skip;

// Build a 120x80 PNG in-process: left half red, right half blue. No fixture
// file, no deps — the model must NAME both halves to prove it saw the pixels.
function redBluePngBase64(): string {
  const W = 120, H = 80;
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3); raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const p = row + 1 + x * 3;
      if (x < W / 2) { raw[p] = 220; raw[p + 1] = 20; raw[p + 2] = 20; }
      else { raw[p] = 20; raw[p + 1] = 40; raw[p + 2] = 220; }
    }
  }
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  return png.toString('base64');
}

// The three tier-routed gen-3 ids (fast / balanced / deep). Dated snapshots so
// modelCapability resolves the real entry the flag lives on.
const GEN3_ROUTED = ['ministral-8b-2512', 'ministral-14b-2512', 'mistral-large-2512'] as const;

describeOnline('Mistral gen-3 vision capability (#2)', () => {
  beforeAll(async () => {
    await initLLMProvider('openai');
  });

  const b64 = redBluePngBase64();

  for (const modelId of GEN3_ROUTED) {
    it(`${modelId} SEES an uploaded image (vision:true reaches the model)`, async () => {
      const agent = new Agent({
        name: `vision-${modelId}`,
        model: modelId,
        provider: 'openai',
        apiKey: MISTRAL_KEY!,
        apiBaseURL: 'https://api.mistral.ai/v1',
        openaiModelId: modelId,
        tools: [],
        maxIterations: 2,
      });

      // Anthropic-format image block — exactly what http-api.ts builds from a
      // composer upload; the adapter translates it to an OpenAI image_url part.
      const result = await agent.send([
        { type: 'text', text: 'This image has two colored halves. Name the LEFT color and the RIGHT color. Answer in a few words.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      ]);

      const lower = result.toLowerCase();
      // Must have actually described the pixels — proves the image was sent AND
      // the model processed it, not that the adapter silently dropped/threw.
      expect(lower, `${modelId} response: ${result}`).toMatch(/red|rot/);
      expect(lower, `${modelId} response: ${result}`).toMatch(/blue|blau/);
    }, 40_000);
  }
});
