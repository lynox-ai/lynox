/**
 * Online guard for the Fireworks-hosted vision candidates (2026-08-14).
 *
 * The Fireworks pages for Kimi K3, Qwen3.7 Plus and MiniMax M3 list image
 * input, but the catalog entries stayed vision:false until the openai-wire
 * image path was validated against the real endpoint — the flag alone proves
 * nothing about what the endpoint actually serves. This test drives the REAL
 * adapter path (registry visionSupport → translateMessages → image_url part)
 * with a real image against api.fireworks.ai, using the full
 * `accounts/fireworks/models/*` ids so `modelCapability` resolves the flipped
 * entries. A model that rejects or ignores images fails here loudly — the
 * entry then rolls back to FIREWORKS_TEXT_FEATURES.
 *
 * Requires FIREWORKS_API_KEY. Skipped without it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';

const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'];
const describeOnline = FIREWORKS_KEY ? describe : describe.skip;

// Same in-process probe as tests/online/mistral-vision.test.ts: left half red,
// right half blue. The model must NAME both halves to prove it saw the pixels.
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

// The three candidates whose Fireworks pages list image input (2026-08-14).
// Full ids so modelCapability resolves the real entry the flag lives on.
const VISION_CANDIDATES = [
  'accounts/fireworks/models/kimi-k3',
  'accounts/fireworks/models/qwen3p7-plus',
  'accounts/fireworks/models/minimax-m3',
] as const;

describeOnline('Fireworks vision candidates (2026-08-14)', () => {
  beforeAll(async () => {
    await initLLMProvider('openai');
  });

  const b64 = redBluePngBase64();

  for (const modelId of VISION_CANDIDATES) {
    it(`${modelId} SEES an uploaded image (vision:true reaches the model)`, async () => {
      const agent = new Agent({
        name: `vision-${modelId.split('/').pop()}`,
        model: modelId,
        provider: 'openai',
        apiKey: FIREWORKS_KEY!,
        apiBaseURL: 'https://api.fireworks.ai/inference/v1',
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
      expect(lower, `${modelId} response: ${result}`).toMatch(/red|rot/);
      expect(lower, `${modelId} response: ${result}`).toMatch(/blue|blau/);
    }, 90_000);
  }
});
