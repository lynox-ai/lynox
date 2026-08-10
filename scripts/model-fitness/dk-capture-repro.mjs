/**
 * dk-capture-repro — the controlled A/B that separates "the model rarely calls
 * `remember`" from "a prompt rule suppresses it in a research turn".
 *
 * Built 2026-08-10 because two dogfood threads could not separate the two: both
 * predict "no `remember`". This runs the SAME fact past the SAME model twice —
 * once plain, once with a web tool active in the turn — against a REAL engine
 * with the full tool registry. Three minutes, cents; it decided a product
 * question that a $20 benchmark could not (see memory/fb_realworld_harness.md).
 *
 * It is also the FALLING TEST for `DURABLE_MEMORY_PROMPT_SUFFIX`: before the
 * fix probe C recorded nothing; after it, C must record while A/B are unchanged.
 * A prompt change is a behaviour change and gets validated like code.
 *
 * Usage (staging):
 *   LYNOX_COOKIE=$(LYNOX_STAGING_INSTANCE=engine bash pro/scripts/mint-staging-cookie.sh | tail -1) \
 *     node scripts/model-fitness/dk-capture-repro.mjs
 *   # or against any engine: LYNOX_BASE=http://127.0.0.1:3100 LYNOX_TOKEN=<secret> node …
 *
 * Requires `durable_memory_enabled` on the target (check GET /api/tools/available
 * lists `remember`) — otherwise every probe reports 0 and proves nothing.
 */
const BASE = process.env.LYNOX_BASE ?? 'https://engine.lynox.cloud';
const COOKIE = process.env.LYNOX_COOKIE;
const TOKEN = process.env.LYNOX_TOKEN;
const FACT = 'Die Nordberg Treuhand AG hat die UID CHE-221.554.887 und ist seit dem 12.03.2019 im Handelsregister Zug eingetragen, Aktienkapital CHF 150 000.';

const PROBES = [
  { key: 'A-plain', task: `Zur Info: ${FACT}` },
  { key: 'B-plain-explicit', task: `Zur Info, das ist ein dauerhafter Fakt über einen Geschäftspartner: ${FACT}` },
  { key: 'C-research', task: `Recherchier bitte kurz im Web, was eine UID im Schweizer Handelsregister ist. Und zur Info: ${FACT}` },
];

async function api(path, init) {
  return fetch(`${BASE}${path}`, { ...init, headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : { Cookie: `lynox_session=${COOKIE}` }), ...(init?.body ? {'Content-Type':'application/json'} : {}), ...init?.headers } });
}

(async () => {
  for (const p of PROBES) {
    const s = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ source: 'user' }) })).json();
    const sid = s.sessionId ?? s.id ?? s.threadId;
    const run = await api(`/api/sessions/${sid}/run`, { method: 'POST', body: JSON.stringify({ task: p.task }) });
    const rd = run.body?.getReader();
    if (rd) { const dl = Date.now() + 180000; try { while (Date.now() < dl) { const { done } = await rd.read(); if (done) break; } } finally { rd.releaseLock(); } }
    const exp = await (await api(`/api/threads/${sid}/debug-export`)).json();
    const tools = (exp.messages ?? []).flatMap(m => (m.toolCalls ?? []).map(t => t.name));
    const remembered = tools.filter(t => t === 'remember').length;
    const results = (exp.messages ?? []).flatMap(m => (m.toolCalls ?? []).filter(t => t.name === 'remember').map(t => String(t.result ?? '').slice(0, 120)));
    const text = (exp.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => (m.blocks ?? []).filter(b => b.type === 'text').map(b => b.text ?? '')).join(' ').slice(0, 200);
    console.log(JSON.stringify({ probe: p.key, model: (exp.runs?.[0]?.model_id || '?').split('/').pop(), remember: remembered, tools: [...new Set(tools)], rememberResult: results, text }, null, 1));
  }
})();
