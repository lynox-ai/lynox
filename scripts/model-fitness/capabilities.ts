/**
 * The lynox capability map (v1 high-value cut). Each entry is a
 * capability-critical point × a short triggering case × a deterministic
 * assertion, reusing the probe logic this session already validated
 * (vision #2, terminal-tool #7, recall L2b) plus the online-probe patterns
 * (tool-select from short desc, tool-call reliability). Cases are SHORT to keep
 * a full run to a few cents. Add the remaining map points (action-routing,
 * multi-step-workflow, language-fidelity, correct-first-call) here over time.
 */
import zlib from 'node:zlib';
import type { ToolEntry } from '../../src/types/index.js';
import { WEB_UI_SYSTEM_PROMPT_SUFFIX } from '../../src/core/prompts.js';
import type { Capability, MakeAgent, CaseResult } from './types.js';

// ── shared helpers ──────────────────────────────────────────────

/** A 120×80 PNG, left half red, right half blue — the model must name both
 *  halves to prove it saw the pixels (no fixture, no deps). */
function redBluePngBase64(): string {
  const W = 120, H = 80;
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
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
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
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
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
    .toString('base64');
}

/** A tool whose handler records that it fired + captures the input. */
function recordingTool(def: ToolEntry['definition'], onCall: (input: unknown) => void, result = 'ok'): ToolEntry {
  return { definition: def, handler: async (input: unknown) => { onCall(input); return result; } };
}

const PNG = redBluePngBase64();

// ── the capability registry (v1 cut) ────────────────────────────

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'vision',
    point: 'Vision: sees + describes an uploaded image',
    tiers: ['balanced', 'deep'],
    detail: 'Anthropic-format image block → the model names both colour halves.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const agent = make({ name: 'fit-vision', tools: [], maxIterations: 2 });
      const out = await agent.send([
        { type: 'text', text: 'This image has two colored halves. Name the LEFT and the RIGHT color, few words.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ]);
      const l = out.toLowerCase();
      const pass = /red|rot/.test(l) && /blue|blau/.test(l);
      return { pass, note: out.slice(0, 60) };
    },
  },
  {
    id: 'terminal-tool',
    point: 'Terminal-tool compliance: fires suggest_follow_ups to end the turn',
    tiers: ['fast', 'balanced', 'deep'],
    detail: 'With the real web-ui suffix + the tool available, the turn ends with a suggest_follow_ups call.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      let fired = false;
      const tool = recordingTool(
        { name: 'suggest_follow_ups', description: 'Web UI only. Emit end-of-turn follow-up chips (2-4). Terminal — ENDS your turn; call it last.',
          input_schema: { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, task: { type: 'string' } }, required: ['label', 'task'] } } }, required: ['suggestions'] } },
        () => { fired = true; }, 'Presented follow-ups.');
      const agent = make({ name: 'fit-terminal', systemPrompt: 'You are lynox, a business assistant.' + WEB_UI_SYSTEM_PROMPT_SUFFIX, tools: [tool], maxIterations: 3 });
      await agent.send('Fasse kurz zusammen, was wiederkehrende Aufgaben bringen.');
      return { pass: fired, note: fired ? 'fired' : 'did not fire' };
    },
  },
  {
    id: 'tool-select-short',
    point: 'Tool selection from a SHORT description',
    tiers: ['fast', 'balanced', 'deep'],
    detail: 'Two short-desc tools; a weather query must pick get_weather, not send_email.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      let called = '';
      const weather = recordingTool({ name: 'get_weather', description: 'Get the weather forecast for a place.', input_schema: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] } }, () => { called = called || 'get_weather'; }, '18°C, sunny.');
      const email = recordingTool({ name: 'send_email', description: 'Send an email to a recipient.', input_schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } }, () => { called = called || 'send_email'; });
      const agent = make({ name: 'fit-select', tools: [weather, email], maxIterations: 2 });
      await agent.send('Wie wird das Wetter morgen in Zürich?');
      return { pass: called === 'get_weather', note: `called=${called || 'none'}` };
    },
  },
  {
    id: 'tool-call-reliability',
    point: 'Tool-call reliability: actually calls a tool when the turn needs one',
    tiers: ['fast', 'balanced', 'deep'],
    detail: 'A data query that cannot be answered from the model — must call data_store_query.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      let called = false;
      const tool = recordingTool({ name: 'data_store_query', description: 'Query a business data table.', input_schema: { type: 'object', properties: { table: { type: 'string' }, filter: { type: 'object' } }, required: ['table'] } }, () => { called = true; }, JSON.stringify({ rows: [{ name: 'Acme', stage: 'open' }] }));
      const agent = make({ name: 'fit-toolcall', tools: [tool], maxIterations: 3 });
      await agent.send('Zeig mir alle offenen Deals aus der Tabelle "deals".');
      return { pass: called, note: called ? 'called' : 'answered without tool' };
    },
  },
  {
    id: 'json-schema-fidelity',
    point: 'JSON / schema-arg fidelity: emits schema-valid args (enum + required)',
    tiers: ['fast', 'balanced', 'deep'],
    detail: 'A task_create with an enum priority + required fields — args must be schema-valid.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      let args: { title?: unknown; priority?: unknown } | null = null;
      const tool = recordingTool({ name: 'task_create', description: 'Create a task.', input_schema: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] } }, required: ['title', 'priority'] } }, (input) => { args = input as { title?: unknown; priority?: unknown }; }, 'Created.');
      const agent = make({ name: 'fit-json', tools: [tool], maxIterations: 2 });
      await agent.send('Erstelle eine dringende Aufgabe: Angebot an Markus senden.');
      const a = args as { title?: unknown; priority?: unknown } | null;
      const valid = a !== null && typeof a.title === 'string' && typeof a.priority === 'string'
        && ['low', 'medium', 'high', 'urgent'].includes(a.priority);
      return { pass: valid, note: a ? `priority=${String(a.priority)}` : 'no call' };
    },
  },
];
