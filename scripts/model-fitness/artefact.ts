#!/usr/bin/env npx tsx
/**
 * R9 artefact-quality axis v2 (WS2 / main-model-requirements §6a).
 *
 * v1 lesson: an absolute LLM judge (Haiku, 9K truncation) barely separated the anchors
 * (good 6.5 / bad 5.0), while deterministic STRUCTURAL markers separated them cleanly
 * (good aria17/tokens16 vs bad 0/0). v2 therefore makes the deterministic structural score
 * the reliable BACKBONE (validity / a11y / design, calibrated so good-anchor≈10 & bad≈1-2),
 * and keeps an anchor-CALIBRATED LLM judge as a secondary aesthetic/content signal. The axis
 * is trusted only if BOTH rank the good anchor above the bad by a clear margin.
 *
 * Usage:  npx tsx scripts/model-fitness/artefact.ts [--runs N]
 * Keys:   ANTHROPIC_API_KEY / MISTRAL_API_KEY / FIREWORKS_API_KEY env, else ~/.lynox/config.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMClient } from '../../src/core/llm-client.js';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'artefact-out');

/** Directory holding the good/bad artefact-quality anchor fixtures. Not shipped
 *  in this repo; point the env var at your local anchor set. */
function anchorFixturesDir(): string {
  const dir = process.env['LYNOX_ARTEFACT_ANCHOR_DIR'];
  if (!dir) {
    throw new Error('LYNOX_ARTEFACT_ANCHOR_DIR is not set — point it at the artefact-quality anchor fixtures directory');
  }
  return dir;
}

const BRIEF = `Erstelle ein schönes, modernes, self-contained HTML-Artefakt zum Thema "KI-Agenten-Trends 2026: Technologien, Anwendungen & Zukunft".

Anforderungen:
- Ein VOLLSTÄNDIGES eigenständiges HTML-Dokument (<!DOCTYPE html>, <head>, <body>), inline CSS, keine externen Abhängigkeiten ausser optional einer CDN-Chart-Lib.
- Ansprechendes, professionelles Design (Typografie, Layout, Farbsystem), responsive, mit Barrierefreiheit (semantisches HTML, ARIA, Fokus-Stile).
- Inhalt: Meilensteine, Kategorien von Agenten, Anwendungsfälle, Risiken, Ausblick.
Gib NUR den HTML-Code aus, ohne Erklärung davor oder danach.`;

interface Candidate { label: string; provider: 'anthropic' | 'openai'; modelId: string; apiBaseURL?: string; keyName: 'anthropic' | 'mistral' | 'fireworks'; }
const CANDIDATES: Candidate[] = [
  { label: 'ministral-14b', provider: 'openai', modelId: 'ministral-14b-2512', apiBaseURL: MISTRAL_BASE, keyName: 'mistral' },
  { label: 'mistral-medium', provider: 'openai', modelId: 'mistral-medium-2604', apiBaseURL: MISTRAL_BASE, keyName: 'mistral' },
  { label: 'haiku-4.5', provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', keyName: 'anthropic' },
  { label: 'glm-5p2', provider: 'openai', modelId: 'accounts/fireworks/models/glm-5p2', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks' },
];

interface Block { type: string; text?: string }
type Dims = { validity: number; a11y: number; design: number };

function loadKeys(): Record<Candidate['keyName'], string> {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>; } catch { /* env */ }
  const pick = (e: string, k: string): string => process.env[e] ?? (typeof cfg[k] === 'string' ? cfg[k] as string : '');
  return { anthropic: pick('ANTHROPIC_API_KEY', 'anthropic_api_key'), mistral: pick('MISTRAL_API_KEY', 'mistral_api_key'), fireworks: pick('FIREWORKS_API_KEY', 'fireworks_api_key') };
}

function stripFences(s: string): string {
  const m = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (m ? m[1]! : s).trim();
}

/** Deterministic structural score (the reliable backbone), each dim 0-10, calibrated so the
 *  good anchor ≈ 10 and the bad anchor (bare fragment, no a11y) ≈ 0-2 on validity/a11y. */
function scoreStructure(html: string): Dims {
  const cnt = (re: RegExp): number => (html.match(re) ?? []).length;
  const has = (re: RegExp): boolean => re.test(html);
  const doctype = has(/<!doctype html/i);
  const head = has(/<head[\s>]/i), body = has(/<body[\s>]/i);
  const validity = Math.min(10,
    (doctype ? 3 : 0) + (head ? 2 : 0) + (body ? 2 : 0) +
    (has(/<html[^>]+lang=/i) ? 1 : 0) + (has(/<title>/i) ? 1 : 0) + (doctype && head && body ? 1 : 0));
  const aria = cnt(/aria-[a-z]+/gi), semantic = cnt(/<(nav|main|section|header|footer|article|aside)[\s>]/gi);
  const skip = has(/skip[- ]?link|skip to|zum inhalt springen/i) ? 1 : 0, focus = cnt(/:focus/gi), role = cnt(/\brole=/gi);
  const a11y = Math.min(10, Math.round(
    Math.min(aria, 12) * 0.4 + Math.min(semantic, 8) * 0.45 + skip * 2 + Math.min(focus, 4) * 0.35 + Math.min(role, 5) * 0.2));
  const cssVars = new Set(html.match(/--[a-z0-9-]+\s*:/gi) ?? []).size, media = cnt(/@media/gi);
  const design = Math.min(10, Math.round(
    Math.min(cssVars, 12) * 0.45 + Math.min(media, 4) * 0.7 + (has(/display\s*:\s*(grid|flex)/i) ? 2 : 0) +
    (has(/gradient\(/i) ? 1 : 0) + (has(/font-family/i) ? 1 : 0)));
  return { validity, a11y, design };
}

/** Anchor-calibrated LLM judge for the aesthetic/content dimension the structure can't see. */
async function judgeAesthetic(html: string, judgeKey: string): Promise<number | null> {
  if (!html.trim()) return 0;
  const client = createLLMClient({ provider: 'anthropic', apiKey: judgeKey });
  const prompt = `You grade the AESTHETIC + CONTENT quality of an HTML artefact on a 0-10 scale, calibrated by two references:
- A BAD reference (score 2): a bare fragment — no doctype, generic light-grey cards, a broken chart script, dull typography, no visual hierarchy, thin/boilerplate content.
- A GREAT reference (score 9): a full document with a deliberate dark design-token theme, a sticky sidebar nav, cited stat-cards, accordions, a real timeline, a lazy-loaded chart, and specific, honestly-qualified content.
Judge ONLY visual design intentionality + content substance (ignore raw validity/a11y — scored separately). USE THE FULL RANGE and be harsh: a competent-but-templated look is ~4-5, not 7.

ARTEFACT (may be truncated):
"""
${html.slice(0, 16000)}
"""
Reply with ONLY a single integer 0-10.`;
  const stream = client.beta.messages.stream({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: prompt }] } as never);
  const final = await stream.finalMessage();
  const txt = ((final.content ?? []) as Block[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  const m = txt.match(/\d+(\.\d+)?/);
  return m ? Math.min(10, Number(m[0])) : null;
}

async function generate(c: Candidate, key: string): Promise<string> {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const client = createLLMClient({ provider: c.provider, apiKey: key, ...(c.apiBaseURL ? { apiBaseURL: c.apiBaseURL } : {}), ...(c.provider === 'openai' ? { openaiModelId: c.modelId } : {}) });
      const stream = client.beta.messages.stream({ model: c.modelId, max_tokens: 8192, messages: [{ role: 'user', content: BRIEF }] } as never);
      const final = await Promise.race([stream.finalMessage(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout 180s')), 180_000))]);
      const html = stripFences(((final.content ?? []) as Block[]).filter(b => b.type === 'text').map(b => b.text ?? '').join(''));
      if (html.length > 200) return html;
      lastErr = `empty/short output (${html.length}B)`;
    } catch (err) { lastErr = err instanceof Error ? err.message : String(err); }
  }
  throw new Error(`generate failed after 3 attempts: ${lastErr}`);
}

async function main(): Promise<void> {
  const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 2;
  const keys = loadKeys();
  const FIXTURES = anchorFixturesDir();
  mkdirSync(OUT_DIR, { recursive: true });
  const judgeKey = keys.anthropic;
  if (!judgeKey) { console.error('need anthropic key for the judge'); process.exit(1); }

  console.log('\n=== R9 artefact-quality axis v2 ===\n');
  const goodHtml = readFileSync(join(FIXTURES, 'good-sonnet5.html'), 'utf8');
  const badHtml = readFileSync(join(FIXTURES, 'bad-ministral14b.html'), 'utf8');
  const gS = scoreStructure(goodHtml), bS = scoreStructure(badHtml);
  const gA = await judgeAesthetic(goodHtml, judgeKey), bA = await judgeAesthetic(badHtml, judgeKey);
  const fmt = (d: Dims, a: number | null): string => `struct[val=${d.validity} a11y=${d.a11y} design=${d.design}] aesthetic=${a ?? '?'}`;
  console.log(`CALIBRATION good-anchor: ${fmt(gS, gA)}`);
  console.log(`CALIBRATION bad-anchor : ${fmt(bS, bA)}`);
  const structGap = (gS.validity + gS.a11y + gS.design) - (bS.validity + bS.a11y + bS.design);
  console.log(`  → structural gap good−bad = ${structGap} (want ≥12); aesthetic gap = ${(gA ?? 0) - (bA ?? 0)} (want ≥3)\n`);

  for (const c of CANDIDATES) {
    const key = keys[c.keyName];
    if (!key) { console.log(`  ${c.label.padEnd(16)} SKIP — no ${c.keyName} key`); continue; }
    const structs: Dims[] = []; const aes: number[] = []; let bytes = 0; let err = '';
    for (let i = 0; i < runs; i++) {
      try {
        const html = await generate(c, key);
        if (i === 0) { writeFileSync(join(OUT_DIR, `${c.label}.html`), html); bytes = html.length; }
        structs.push(scoreStructure(html));
        const a = await judgeAesthetic(html, judgeKey); if (a !== null) aes.push(a);
      } catch (e) { err = e instanceof Error ? e.message : String(e); }
    }
    if (!structs.length) { console.log(`  ${c.label.padEnd(16)} ❌ GENERATION FAILED — ${err}`); continue; }
    const avg = (xs: number[]): number => Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10;
    const d: Dims = { validity: avg(structs.map(s => s.validity)), a11y: avg(structs.map(s => s.a11y)), design: avg(structs.map(s => s.design)) };
    const structOverall = Math.round((d.validity + d.a11y + d.design) / 3 * 10) / 10;
    console.log(`  ${c.label.padEnd(16)} struct=${structOverall} [val=${d.validity} a11y=${d.a11y} design=${d.design}]  aesthetic=${aes.length ? avg(aes) : '?'}  ${bytes}B  (n=${structs.length})`);
  }
  console.log(`\nArtefacts in ${OUT_DIR}/. Structural score is the reliable backbone; aesthetic is the LLM secondary.\n`);
}

void main();
