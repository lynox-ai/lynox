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
 * Usage — point it at any engine with `durable_memory_enabled` on:
 *   LYNOX_BASE=http://127.0.0.1:3000 LYNOX_TOKEN=<engine http secret> \\
 *     node scripts/model-fitness/dk-capture-repro.mjs
 *   # a hosted engine takes a session cookie instead: LYNOX_COOKIE=<lynox_session value>
 *
 * Requires `durable_memory_enabled` on the target (check GET /api/tools/available
 * lists `remember`) — otherwise every probe reports 0 and proves nothing.
 */
import { runToken, freshName, freshUid, sawDedup } from './probe-freshness.mjs';
const BASE = process.env.LYNOX_BASE;
if (!BASE) { console.error('set LYNOX_BASE to the engine you want to probe (plus LYNOX_TOKEN, or LYNOX_COOKIE for a session cookie)'); process.exit(1); }
const COOKIE = process.env.LYNOX_COOKIE;
const TOKEN = process.env.LYNOX_TOKEN;
// ONE fact per RUN, fresh per run. The three cells deliberately share it — that is the
// control this probe is built on — but a fact reused across RUNS meets an active row from
// the last one and dedups (`probe-freshness.mjs` has the store's own rule). The subject is
// what carries the freshness; a fresh UID alone stays above the 0.7 content-token bar.
const FACT = `Die ${freshName('Nordberg')} Treuhand AG hat die UID ${freshUid(0)} und ist seit dem 12.03.2019 im Handelsregister Zug eingetragen, Aktienkapital CHF 150 000.`;

const PROBES = [
  { key: 'A-plain', task: `Zur Info: ${FACT}` },
  { key: 'B-plain-explicit', task: `Zur Info, das ist ein dauerhafter Fakt über einen Geschäftspartner: ${FACT}` },
  { key: 'C-research', task: `Recherchier bitte kurz im Web, was eine UID im Schweizer Handelsregister ist. Und zur Info: ${FACT}` },
];

async function api(path, init) {
  return fetch(`${BASE}${path}`, { ...init, headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : { Cookie: `lynox_session=${COOKIE}` }), ...(init?.body ? {'Content-Type':'application/json'} : {}), ...init?.headers } });
}

// Whether any cell has already written this run's fact. A dedup before this is true means
// freshness failed; after it, it is the intended A->B restatement.
let sentFact = false;

(async () => {
  for (const p of PROBES) {
    const s = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ source: 'user' }) })).json();
    const sid = s.sessionId ?? s.id ?? s.threadId;
    const run = await api(`/api/sessions/${sid}/run`, { method: 'POST', body: JSON.stringify({ task: p.task }) });
    const rd = run.body?.getReader();
    // Same trap as the cross-provider sweep: a deadline-cut run reads as remember=0.
    let timedOut = false;
    if (rd) { const dl = Date.now() + 180000; try { let done = false; while (!done) { if (Date.now() > dl) { timedOut = true; break; } ({ done } = await rd.read()); } } finally { rd.releaseLock(); } }
    const exp = await (await api(`/api/threads/${sid}/debug-export`)).json();
    const tools = (exp.messages ?? []).flatMap(m => (m.toolCalls ?? []).map(t => t.name));
    const remembered = tools.filter(t => t === 'remember').length;
    const results = (exp.messages ?? []).flatMap(m => (m.toolCalls ?? []).filter(t => t.name === 'remember').map(t => String(t.result ?? '').slice(0, 120)));
    const text = (exp.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => (m.blocks ?? []).filter(b => b.type === 'text').map(b => b.text ?? '')).join(' ').slice(0, 200);
    // C is the falling test for the research-turn rule, and its whole reading depends on the
    // turn being TAINTED — which happens only if a web tool actually ran. If the model skips
    // the search, C is a clean turn, lands active, and can dedup against A: the cell then
    // measures something else while looking like itself. Checked, not assumed.
    const webRan = tools.includes('web_research');
    // A dedup is only a FRESHNESS failure on the first cell to send this fact. A/B/C send
    // the same fact on purpose (that is the control), so B and C dedup against A by design
    // on every run, in every version of this script. Flagging those would make the tripwire
    // fire always — and a signal that always fires is not a signal.
    const deduped = results.some(sawDedup);
    const firstSender = sentFact === false;
    if (remembered > 0) sentFact = true;
    console.log(JSON.stringify({
      probe: p.key, run: runToken(), timedOut,
      model: (exp.runs?.[0]?.model_id || '?').split('/').pop(),
      remember: remembered, tools: [...new Set(tools)],
      ...(p.key === 'C-research' ? { webRan, cellValid: webRan && !timedOut } : {}),
      ...(deduped ? (firstSender
        ? { DEDUPED: true, note: 'freshness failed — this run met an older active row' }
        : { dedupExpected: true }) : {}),
      rememberResult: results, text,
    }, null, 1));
  }
})();
