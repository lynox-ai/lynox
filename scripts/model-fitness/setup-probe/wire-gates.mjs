#!/usr/bin/env node
/**
 * wire-gates — deterministic gates on an OpenAI-compatible endpoint, BEFORE any flow
 * runs. No engine, no judge: each gate is a small scripted exchange whose outcome is
 * checked mechanically, and every raw stream is kept.
 *
 * The stream is parsed by the rules core's openai-adapter.ts applies (only `data: `
 * lines, `choices[0]`, tool calls keyed by `delta.tool_calls[].index` with argument
 * fragments concatenated per index, a finish_reason required), so a gate that passes
 * here is a wire the engine can read.
 *
 * Gates (each binary; thresholds fixed here, before any measurement):
 *   tool_json        every tool call's arguments parse as a JSON object
 *   parallel         one turn carries >= 2 independent tool calls
 *   chain8           an 8-hop tool chain is followed exactly and the answer is the end word
 *   long_result      a ~50k-token tool result is read: the needle amount is answered
 *   german           a German question gets a German answer
 *   no_empty_turn    no turn ends with neither text nor a tool call
 *   ttft             median time to first token on the ~8k-token prefix calls <= 5 s
 *
 * And one measurement that is not a gate, three separate answers:
 *   caching          identical ~8k-token prefix sent 3x, plus a same-length control prefix:
 *                    (a) cache fields in the raw usage object, (b) first-token time of
 *                    repeats vs first call vs control.
 *
 *   node scripts/model-fitness/setup-probe/wire-gates.mjs --base-url https://<host>/v1 \
 *     --model <id> --key-file <path> --out <dir>
 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWire } from './wire.mjs';

const { values: opt } = parseArgs({
  options: {
    'base-url': { type: 'string' }, model: { type: 'string' }, 'key-file': { type: 'string' },
    out: { type: 'string' }, 'max-tokens': { type: 'string', default: '8192' },
  },
});
for (const k of ['base-url', 'model', 'key-file', 'out']) if (!opt[k]) { console.error(`missing --${k}`); process.exit(2); }
const BASE = opt['base-url'].replace(/\/$/, '');
const MODEL = opt.model;
const KEY = readFileSync(opt['key-file'], 'utf8').trim();
const OUT = join(opt.out, MODEL.replace(/[^A-Za-z0-9._-]/g, '_'));
mkdirSync(OUT, { recursive: true });

const chat = createWire({ base: BASE, model: MODEL, key: KEY, out: OUT, maxTokens: Number(opt['max-tokens']) });

/** Drive a tool loop with local tool implementations. */
async function loop(messages, tools, impl, label, maxRounds = 14) {
  const turns = [];
  for (let round = 0; round < maxRounds; round++) {
    const r = await chat(messages, tools, `${label}-r${round + 1}`);
    turns.push(r);
    if (!r.ok || r.toolCalls.length === 0) break;
    messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs || '{}' } })) });
    for (const c of r.toolCalls) messages.push({ role: 'tool', tool_call_id: c.id, content: impl(c) });
  }
  return turns;
}

const GERMAN = /\b(und|der|die|das|ist|eine?|nicht|mit|für|auf|wird|werden|sie|wir|bei|auch|als|von|zu|den|dem)\b/gi;
const looksGerman = t => (String(t).match(GERMAN) ?? []).length >= 5;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const gates = {};
const allTurns = [];
const track = t => { allTurns.push(...(Array.isArray(t) ? t : [t])); return t; };

// ── parallel + tool_json ────────────────────────────────────────────────────
{
  const tools = [
    { type: 'function', function: { name: 'wetter', description: 'Aktuelles Wetter für eine Stadt.', parameters: { type: 'object', properties: { stadt: { type: 'string' } }, required: ['stadt'] } } },
    { type: 'function', function: { name: 'wechselkurs', description: 'Wechselkurs zwischen zwei Währungen.', parameters: { type: 'object', properties: { von: { type: 'string' }, nach: { type: 'string' } }, required: ['von', 'nach'] } } },
  ];
  const r = track(await chat([{ role: 'user', content: 'Ich brauche drei Dinge gleichzeitig: das Wetter in Zürich, das Wetter in Genf und den Wechselkurs von CHF zu EUR. Ruf die Werkzeuge dafür auf.' }], tools, 'parallel'));
  gates.parallel = { pass: r.ok && r.toolCalls.length >= 2, calls: r.toolCalls.map(c => ({ name: c.name, args: c.args })) };
}

// ── chain8 ──────────────────────────────────────────────────────────────────
{
  const chain = ['START', 'QX-71', 'LM-24', 'RB-09', 'TK-55', 'WF-38', 'HN-62', 'PD-17', 'ZC-80'];
  const word = 'SEEBLICK';
  const tools = [{ type: 'function', function: { name: 'naechster_code', description: 'Gibt zu einem Code den nächsten Code zurück – oder am Ende der Kette das Lösungswort.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } }];
  const visited = [];
  const impl = c => {
    const code = String(c.args?.code ?? '');
    visited.push(code);
    const i = chain.indexOf(code);
    if (i < 0) return `Unbekannter Code "${code}".`;
    if (i === chain.length - 1) return `Ende der Kette. Das Lösungswort lautet ${word}.`;
    return `Der nächste Code ist ${chain[i + 1]}.`;
  };
  const turns = track(await loop([{ role: 'user', content: 'Ruf das Werkzeug naechster_code mit dem Code START auf. Es nennt dir einen neuen Code. Ruf es mit jedem neuen Code wieder auf, bis es dir ein Lösungswort nennt. Antworte dann nur mit dem Lösungswort.' }], tools, impl, 'chain8'));
  const final = turns.at(-1)?.text ?? '';
  const exact = JSON.stringify(visited) === JSON.stringify(chain);
  gates.chain8 = { pass: exact && final.includes(word), rounds: turns.length, visited, final: final.slice(0, 120) };
}

// ── long_result ─────────────────────────────────────────────────────────────
{
  const rows = [];
  const fmt = v => v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  let x = 7;
  for (let i = 1; i <= 4200; i++) {
    x = (x * 48271) % 2147483647;
    const amount = i === 3117 ? 7412.85 : (x % 900000) / 100 + 10;
    rows.push(`B-${String(i).padStart(5, '0')};2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')};Lieferant ${1 + (x % 380)};${fmt(amount)}`);
  }
  const csv = 'beleg;datum;lieferant;betrag_chf\n' + rows.join('\n');
  const tools = [{ type: 'function', function: { name: 'lade_belege', description: 'Lädt die Belegliste des Jahres als CSV.', parameters: { type: 'object', properties: {} } } }];
  const turns = track(await loop([{ role: 'user', content: 'Ruf lade_belege auf und nenn mir den Betrag von Beleg B-03117.' }], tools, () => csv, 'long_result', 4));
  const final = turns.at(-1)?.text ?? '';
  const promptTokens = Math.max(0, ...turns.map(t => t.usage?.prompt_tokens ?? 0));
  gates.long_result = { pass: /7'?412[.,]85/.test(final) && promptTokens >= 40_000, promptTokens, final: final.slice(0, 160) };
}

// ── german ──────────────────────────────────────────────────────────────────
{
  const r = track(await chat([{ role: 'user', content: 'Erklär mir bitte in zwei Sätzen, was die Mehrwertsteuer ist und wer sie am Ende bezahlt.' }], null, 'german'));
  gates.german = { pass: r.ok && looksGerman(r.text), text: r.text.slice(0, 300) };
}

// ── caching + ttft ──────────────────────────────────────────────────────────
const caching = {};
{
  const para = i => `Abschnitt ${i}: Die Buchhaltung erfasst Belege, prüft Beträge und Mehrwertsteuersätze, ordnet Lieferanten zu und hält Fristen ein. Jeder Beleg erhält eine Nummer, ein Datum und einen Betrag in Franken. `;
  const prefixA = Array.from({ length: 260 }, (_, i) => para(i)).join('');
  const prefixB = Array.from({ length: 260 }, (_, i) => para(i).replace('Buchhaltung', 'Lagerverwaltung').replace('Belege', 'Artikel')).join('');
  const ask = sys => [{ role: 'system', content: sys }, { role: 'user', content: 'Antworte nur mit dem Wort: ok' }];
  const runs = [];
  for (const [label, sys] of [['A1', prefixA], ['A2', prefixA], ['A3', prefixA], ['B1', prefixB]]) {
    const r = track(await chat(ask(sys), null, `cache-${label}`));
    runs.push({ label, ttft: r.ttft, elapsed: r.elapsed, usage: r.usage });
  }
  const cacheFields = runs.map(r => {
    const u = r.usage ?? {};
    const found = {};
    const walk = (o, p) => { for (const [k, v] of Object.entries(o ?? {})) { if (/cach/i.test(k)) found[p + k] = v; if (v && typeof v === 'object') walk(v, `${p}${k}.`); } };
    walk(u, '');
    return { label: r.label, promptTokens: u.prompt_tokens ?? null, cacheFields: found };
  });
  caching.runs = runs;
  caching.reportedInUsage = cacheFields.some(c => Object.values(c.cacheFields).some(v => typeof v === 'number' && v > 0));
  caching.cacheFields = cacheFields;
  const [a1, a2, a3, b1] = runs.map(r => r.ttft);
  caching.ttft = { first: a1, repeats: [a2, a3], control: b1 };
  gates.ttft = { pass: median(runs.map(r => r.ttft).filter(v => v !== null)) <= 5000, medianMs: median(runs.map(r => r.ttft).filter(v => v !== null)) };
}

// ── derived gates ───────────────────────────────────────────────────────────
const toolTurns = allTurns.filter(t => t.toolCalls?.length);
gates.tool_json = { pass: toolTurns.length > 0 && toolTurns.every(t => t.toolCalls.every(c => c.argsOk && c.name)), toolTurns: toolTurns.length };
const empty = allTurns.filter(t => t.ok && t.toolCalls.length === 0 && !t.text.trim());
gates.no_empty_turn = { pass: empty.length === 0 && allTurns.every(t => t.ok), emptyTurns: empty.length, failedCalls: allTurns.filter(t => !t.ok).map(t => t.status) };

const usage = allTurns.reduce((a, t) => ({ in: a.in + (t.usage?.prompt_tokens ?? 0), out: a.out + (t.usage?.completion_tokens ?? 0) }), { in: 0, out: 0 });
const report = { model: MODEL, base: BASE, at: new Date().toISOString(), calls: allTurns.length, usage, gates, allPass: Object.values(gates).every(g => g.pass), caching };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
for (const [k, g] of Object.entries(gates)) console.log(`${g.pass ? 'PASS' : 'FAIL'} ${k} ${JSON.stringify(g).slice(0, 220)}`);
console.log(`caching: usage-reported=${caching.reportedInUsage} ttft first=${Math.round(caching.ttft.first)}ms repeats=${caching.ttft.repeats.map(Math.round)} control=${Math.round(caching.ttft.control)}ms`);
console.log(`calls=${allTurns.length} tokens in=${usage.in} out=${usage.out} -> ${OUT}/report.json`);
