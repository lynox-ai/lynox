#!/usr/bin/env npx tsx
/**
 * Real-model eval for a stopped run (run-stop.ts), on the real path: a real
 * Engine, Session, Agent and ThreadStore in a throwaway data dir, one provider.
 *
 *   npx tsx scripts/eval-interrupted-turn.ts <anthropic|mistral> <n>
 *
 * Scenario A (user stop, live): the model looks up four orders one by one; the
 * user stops the run while the third lookup runs, then writes "mach weiter".
 *   ok = the follow-up gives the right sum (545) and looks up no order whose
 *        result was already kept.
 * Scenario B (loop break, after a reload): a thread whose last run was broken
 * after five identical `api_profile view wrong` calls is resumed from disk and
 * the user writes "mach weiter". Two arms: `marker` (the engine note with
 * `inContext`, as written today) and `control` (the same rows, the note without
 * it, so the model gets the kept loop but no stop text).
 *   repeated = the follow-up calls `api_profile view wrong` again.
 * Cache (anthropic, scenario A only): usage of the two calls after the stop.
 *
 * One JSON line per run on stdout. Needs ANTHROPIC_API_KEY or MISTRAL_API_KEY.
 * HOME and LYNOX_DATA_DIR are pointed at a temp dir before anything loads.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = process.argv[2];
const n = Number(process.argv[3] ?? '3');
if (provider !== 'anthropic' && provider !== 'mistral') throw new Error('usage: <anthropic|mistral> <n>');

const home = mkdtempSync(join(tmpdir(), 'lynox-itr-eval-'));
process.env['HOME'] = home;
delete process.env['LYNOX_DIR'];
delete process.env['LYNOX_WORKSPACE_ROOT'];

const { Engine } = await import('../src/core/engine.js');
const { reloadConfig } = await import('../src/core/config.js');
const { SessionStore } = await import('../src/core/session-store.js');
const { buildDisplayNoteContent } = await import('../src/core/render-projection.js');
const { loopBreakDetail, readRunStop } = await import('../src/core/run-stop.js');
const { MISTRAL_API_BASE, MISTRAL_MODEL_MAP } = await import('../src/types/models.js');
type Engine = InstanceType<typeof Engine>;

const ORDERS: Record<string, number> = { '101': 120, '102': 80, '103': 45, '104': 300 };

function config(): Record<string, unknown> {
  if (provider === 'mistral') {
    const key = process.env['MISTRAL_API_KEY'];
    if (!key) throw new Error('MISTRAL_API_KEY missing');
    return { provider: 'openai', api_base_url: MISTRAL_API_BASE, openai_model_id: MISTRAL_MODEL_MAP.balanced, api_key: key };
  }
  if (!process.env['ANTHROPIC_API_KEY']) throw new Error('ANTHROPIC_API_KEY missing');
  return {};
}

async function boot(): Promise<{ engine: Engine; dir: string }> {
  const dir = mkdtempSync(join(home, 'data-'));
  process.env['LYNOX_DATA_DIR'] = dir;
  reloadConfig();
  const engine = new Engine(config() as never);
  await engine.init();
  return { engine, dir };
}

function toolCalls(messages: Array<{ role: string; content: unknown }>): Array<{ name: string; input: Record<string, unknown> }> {
  const out: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string; name?: string; input?: unknown }>) {
      if (b.type === 'tool_use') out.push({ name: b.name ?? '', input: (b.input ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

async function scenarioA(i: number): Promise<void> {
  const { engine, dir } = await boot();
  let session: ReturnType<Engine['createSession']> | null = null;
  let calls = 0;
  engine.registerTool({
    definition: {
      name: 'lookup_order',
      description: 'Look up ONE order by its id. Returns the order amount in CHF.',
      input_schema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
    },
    handler: async (input: { id: string }) => {
      calls++;
      // The user stops the run while the third lookup runs.
      if (calls === 3) setTimeout(() => session?.abort(), 0);
      await new Promise((r) => setTimeout(r, 50));
      const amount = ORDERS[input.id];
      return amount === undefined ? `Order ${input.id}: not found` : `Order ${input.id}: CHF ${String(amount)}`;
    },
  });
  session = engine.createSession();
  let firstEnd = 'completed';
  try {
    await session.run('Schau die Bestellungen 101, 102, 103 und 104 nacheinander mit lookup_order nach, immer nur eine pro Schritt, und nenne mir danach die Summe in CHF.');
  } catch (err) { firstEnd = (err as Error).name; }
  const agent = session.getAgent()!;
  const kept = agent.getMessages();
  const keptIds = new Set(toolCalls(kept).map((c) => String(c.input['id'])));
  const stopOnKept = kept.map((m) => readRunStop(m)?.code).filter(Boolean);

  const before = { ...session.usage };
  const reply = await session.run('mach weiter');
  const mid = { ...session.usage };
  const after1 = agent.getMessages();
  const followCalls = toolCalls(after1.slice(kept.length));
  const repeated = followCalls.filter((c) => keptIds.has(String(c.input['id']))).length;
  // Cache: one more short turn, so two calls after the stop can be compared.
  await session.run('Danke. Antworte nur mit OK.');
  const end = { ...session.usage };
  const d = (a: typeof before, b: typeof before) => ({
    cache_read: b.cache_read_input_tokens - a.cache_read_input_tokens,
    cache_creation: b.cache_creation_input_tokens - a.cache_creation_input_tokens,
    input: b.input_tokens - a.input_tokens,
  });
  console.log(JSON.stringify({
    provider, scenario: 'A', i, firstEnd, keptMessages: kept.length, keptIds: [...keptIds], stopOnKept,
    followCalls: followCalls.map((c) => c.input['id']), repeated, sumOk: reply.includes('545'),
    ok: reply.includes('545') && repeated === 0,
    usageFollowUp1: d(before, mid), usageFollowUp2: d(mid, end),
    reply: reply.slice(0, 300),
  }));
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
}

const NOT_FOUND = 'API profile "wrong" not found. Use action "list" to see available profiles.';

async function scenarioB(i: number, arm: 'marker' | 'control'): Promise<void> {
  const { engine, dir } = await boot();
  engine.registerTool({
    definition: {
      name: 'api_profile',
      description: 'Manage API profiles. action "list" lists profile ids; action "view" shows one profile by id.',
      input_schema: { type: 'object' as const, properties: { action: { type: 'string', enum: ['list', 'view'] }, id: { type: 'string' } }, required: ['action'] },
    },
    handler: async (input: { action: string; id?: string }) => {
      if (input.action === 'list') return 'Profiles: shop-api, crm-api';
      if (input.id === 'shop-api') return 'shop-api: base https://shop.example.test, auth bearer';
      if (input.id === 'crm-api') return 'crm-api: base https://crm.example.test, auth basic';
      return NOT_FOUND;
    },
  });
  // The thread as the engine leaves it after a loop break: question and five
  // identical pairs as API rows, then the display note.
  const store = engine.getThreadStore()!;
  const id = `itr-eval-${arm}-${String(i)}`;
  store.createThread(id);
  const input = { action: 'view', id: 'wrong' };
  const rows: Array<{ role: 'user' | 'assistant'; content: never }> = [
    { role: 'user', content: 'Zeig mir die Konfiguration meines Shop-API-Profils.' as never },
  ];
  for (let k = 0; k < 5; k++) {
    rows.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_${String(k)}`, name: 'api_profile', input }] as never });
    rows.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${String(k)}`, content: NOT_FOUND }] as never });
  }
  store.appendMessages(id, rows, store.getNextSeq(id), { message_count: rows.length });
  const detail = loopBreakDetail(`api_profile\x00${JSON.stringify(input)}`);
  store.appendDisplayNotes(id, [{ role: 'assistant', content: buildDisplayNoteContent('tool_loop_break', detail, arm === 'marker') }], store.getNextSeq(id));

  const session = new SessionStore().getOrCreate(id, engine);
  const agent = session.getAgent()!;
  const kept = agent.getMessages();
  const stopLoaded = readRunStop(kept[kept.length - 1]!)?.code ?? null;
  let end = 'completed';
  let reply = '';
  try { reply = await session.run('mach weiter'); } catch (err) { end = (err as Error).name; }
  const follow = toolCalls(agent.getMessages().slice(kept.length));
  const repeated = follow.filter((c) => c.name === 'api_profile' && c.input['action'] === 'view' && c.input['id'] === 'wrong').length;
  console.log(JSON.stringify({
    provider, scenario: 'B', arm, i, stopLoaded, end,
    follow: follow.map((c) => `${c.name} ${JSON.stringify(c.input)}`), repeated, reply: reply.slice(0, 300),
  }));
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
}

try {
  for (let i = 0; i < n; i++) {
    await scenarioA(i);
    await scenarioB(i, 'marker');
    await scenarioB(i, 'control');
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
