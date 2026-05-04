/**
 * Markdown → spoken-text sanitizer.
 *
 * Block-first pipeline. Markdown is segmented into semantic blocks, each
 * block is handled by an appropriate strategy (drop / summarize / speak),
 * and only the speak-blocks pass through inline cleanup. The pipeline is
 * intentionally language-thin: every speakable token — link labels, list
 * items, paragraphs — flows through identical rules regardless of language.
 * The only language-aware pieces are the labels for table/list summaries,
 * the list joiner, and a small symbol-word map for trend arrows in tables.
 *
 * Phases:
 *   1. Segment Markdown into Block[] (line-classified, no full Markdown AST).
 *   2. Per-block strategy:
 *        code, hr, blank          → drop
 *        table (≤5 rows, 2-3 col) → row-by-row spoken; else summary
 *        list  (>3 items)         → "[Liste mit N Einträgen]" / "[List with N items]"
 *        list  (≤3 items)         → comma+conjunction joined sentence
 *        heading                  → speak as own sentence
 *        quote, paragraph         → speak inline-stripped
 *   3. Inline-strip per speak block: links, URLs, inline code, HTML,
 *      Markdown markers, IDs/hashes, JSON-ish, residual brackets, em-dash.
 *   4. Stub-drop + hygiene: sub-sentences that originally contained a
 *      stripped element and now hold <STUB_MIN_WORDS speakable words are
 *      dropped (catches "Mehr unter." after a bare URL got stripped),
 *      then whitespace and punctuation are normalized.
 */

import type { Lang } from './types.js';

const LIST_MAX = 3;
const TABLE_MAX_ROWS = 5;
const STUB_MIN_WORDS = 3;

// Strip-marker: a sentinel character spliced in where a non-speakable element
// (URL, image, inline code, opaque ID) gets removed. The stub-drop pass uses
// it to detect "this sentence was longer before strip" and apply the
// word-count filter only to those sentences. Cleaned out at end of pipeline.
// U+E000 is in the Unicode Private Use Area — never appears in real text.
// `M_RE` is the hoisted marker-regex (avoids `new RegExp(M, 'g')` allocations
// inside `dropStubs` per surviving sentence and inside the final hygiene pass).
const M = '';
const M_RE = //g;

interface Labels {
  readonly tableSummary: (n: number) => string;
  readonly listSummary: (n: number) => string;
  readonly listJoiner: string;
  readonly symbols: ReadonlyMap<string, string>;
}

const SYMBOLS_DE: ReadonlyMap<string, string> = new Map([
  ['↑', 'steigend'], ['↗', 'steigend'],
  ['↓', 'fallend'], ['↘', 'fallend'],
  ['→', 'stabil'],
  ['✓', 'ja'], ['✅', 'ja'],
  ['✗', 'nein'], ['❌', 'nein'],
]);

const SYMBOLS_EN: ReadonlyMap<string, string> = new Map([
  ['↑', 'rising'], ['↗', 'rising'],
  ['↓', 'falling'], ['↘', 'falling'],
  ['→', 'flat'],
  ['✓', 'yes'], ['✅', 'yes'],
  ['✗', 'no'], ['❌', 'no'],
]);

const LABELS: Record<Lang, Labels> = {
  de: {
    tableSummary: (n: number): string => `Tabelle mit ${String(n)} Zeilen, siehe Bildschirm.`,
    listSummary: (n: number): string => `Liste mit ${String(n)} Einträgen, siehe Bildschirm.`,
    listJoiner: ' und ',
    symbols: SYMBOLS_DE,
  },
  en: {
    tableSummary: (n: number): string => `Table with ${String(n)} rows, see screen.`,
    listSummary: (n: number): string => `List with ${String(n)} items, see screen.`,
    listJoiner: ' and ',
    symbols: SYMBOLS_EN,
  },
};

type BlockKind = 'paragraph' | 'list' | 'table' | 'code' | 'heading' | 'quote' | 'hr' | 'blank';
interface Block { readonly kind: BlockKind; readonly lines: readonly string[] }

/**
 * Flatten Markdown into TTS-friendly text.
 *
 * `lang` is required: callers know the user's UI language (Web UI, Telegram)
 * or the assistant reply's locale. `'auto'` is an escape-hatch for paths
 * where context is genuinely missing (HTTP API without an explicit param);
 * it runs a cheap stopword vote that defaults to EN on tie / empty input.
 *
 * Pure function. No throws. Empty input returns empty string.
 */
export function prepareForSpeech(input: string, lang: Lang | 'auto'): string {
  if (!input) return '';
  const resolved: Lang = lang === 'auto' ? detectLang(input) : lang;
  const L = LABELS[resolved];

  const blocks = segmentBlocks(input);

  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'code':
      case 'hr':
      case 'blank':
        continue;

      case 'table': {
        // First two lines are the header row + GFM separator (already
        // verified during segmentation). Speakable rows start at index 2.
        const dataRows = b.lines.slice(2)
          .map(parseTableCells)
          .filter((r) => r.length > 0);
        const spoken = speakTable(dataRows, L);
        if (spoken) out.push(spoken);
        continue;
      }

      case 'list': {
        const items = b.lines
          .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
          .map(stripInline)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length === 0) continue;
        if (items.length > LIST_MAX) {
          out.push(L.listSummary(items.length));
        } else {
          out.push(joinListItems(items, L.listJoiner));
        }
        continue;
      }

      case 'heading': {
        const raw = b.lines.join(' ').replace(/^\s{0,3}#{1,6}\s+/, '');
        const t = stripInline(raw).trim();
        if (t) out.push(/[.!?]$/.test(t) ? t : `${t}.`);
        continue;
      }

      case 'quote': {
        const raw = b.lines.map((l) => l.replace(/^\s*>\s?/, '')).join(' ');
        const t = stripInline(raw).trim();
        if (t) out.push(t);
        continue;
      }

      case 'paragraph': {
        const t = stripInline(b.lines.join(' ')).trim();
        if (t) out.push(t);
        continue;
      }
    }
  }

  // Phase 4 — assemble + drop stubs + final hygiene.
  let s = out.join(' ');
  s = dropStubs(s);
  s = s.replace(M_RE, '');
  s = s.replace(/\s+([.,;:!?])/g, '$1');
  s = s.replace(/([.,;:!?])\1+/g, '$1');
  s = s.replace(/\.\s*\./g, '.');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Cheap symmetric language vote. Counts distinctive stopwords for both
 * languages; whichever wins, wins. Defaults to 'en' on tie / empty input —
 * mistaking DE for EN only swaps two label strings, while mistaking EN for
 * DE could insert " und " into an English list. Asymmetric cost → asymmetric
 * default.
 *
 * Umlaut counting is two-tier: ≥2 umlauts count on their own (terse DE input
 * like "Prüfung läuft" has no stopwords but is unambiguously German); a
 * single umlaut only counts when paired with a DE stopword (so a single
 * umlaut'd proper noun in EN text — "Visit Müller now" — does not flip
 * detection to DE).
 */
function detectLang(text: string): Lang {
  const s = text.slice(0, 2000);
  const deStopwords = s.match(/\b(?:der|die|das|und|ist|nicht|für|werden|sind|mit|auch|eine?|oder)\b/gi)
    ?.length ?? 0;
  const umlauts = s.match(/[äöüÄÖÜß]/g)?.length ?? 0;
  const umlautContribution = (deStopwords > 0 || umlauts >= 2) ? umlauts : 0;
  const de = deStopwords + umlautContribution;
  const en = s.match(/\b(?:the|and|is|are|of|to|for|with|that|this|from|have|has)\b/gi)
    ?.length ?? 0;
  return de > en ? 'de' : 'en';
}

/**
 * Inline cleanup. Order matters: containers (link/image/code) are stripped
 * before bare markers so labels survive container removal. Anything that
 * isn't speech is replaced by a NUL marker (`M`) so `dropStubs` can later
 * detect "this sentence had stripped content and is now too short to be
 * worth speaking". Markers are removed at the end of the pipeline.
 */
function stripInline(s: string): string {
  let t = s;

  // Containers — replace with marker so stubs are detectable downstream.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, M);                  // images
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');               // links: keep label
  // Bare URLs: keep any trailing sentence punctuation OR closing bracket
  // outside the marker, so "Visit https://x.com." keeps its period and
  // "Look at (https://x.com) here" keeps the closing paren (matched by
  // the surrounding `(` and collapsed by the bracket-marker rule below).
  t = t.replace(/https?:\/\/\S+/g, (matched) => {
    const trail = matched.match(/[.,;:!?)\]]+$/);
    return trail ? `${M}${trail[0]}` : M;
  });
  // Collapse parentheses or square brackets that wrap a marker only — the
  // visible content inside was unspeakable (URL/image), so the brackets
  // themselves carry no information. Runs after URL strip so the marker
  // is in place. Replaces with a single marker so dropStubs still detects
  // the strip.
  t = t.replace(/[(\[]\s*\s*[)\]]/g, M);
  t = t.replace(/`[^`]*`/g, M);                                // inline code

  // Inline HTML tags — strip silently.
  t = t.replace(/<[^>]+>/g, '');

  // Inline Markdown markers (bold/italic/strike/underscore-italic).
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
  t = t.replace(/(?<![*_~])[*_~]([^*_~\n]+)[*_~](?![*_~])/g, '$1');

  // Issue/PR refs: drop "#" but keep number — speakable + informative.
  // No "Nummer"/"number" word inserted — TTS reads bare digits idiomatically.
  t = t.replace(/#(\d+)\b/g, '$1');

  // Unspeakable token shapes.
  t = t.replace(/\b[A-Fa-f0-9]{8,}\b/g, M);                    // hex IDs / hashes
  // Long opaque tokens (UUID, JWT, base64, API keys). Requires a "shape
  // signal" — a digit OR an underscore inside — to avoid swallowing long
  // natural-language compounds: German nouns like
  // "Donaudampfschifffahrtsgesellschaft" (no shape signal at all) and
  // hyphenated English phrases like "state-of-the-art-implementation"
  // (hyphens alone don't count, since real prose uses them too).
  t = t.replace(/\b(?=[\w-]{24,}\b)[\w-]*[\d_][\w-]*\b/g, M);
  t = t.replace(/\{[^{}\n]*\}/g, M);                           // inline JSON-ish

  // Em/en dash → comma. Language-agnostic — both DE and EN want a clause break.
  t = t.replace(/\s*[—–]\s*/g, ', ');

  // Arrows in prose → comma. Tables map ↑↓→ to language-specific words
  // before this code runs on the cell, so prose-only here. ASCII arrows
  // MUST be replaced before the `[<>|]` strip below, otherwise the `>`/`<`
  // gets eaten and `->` collapses to a stray dash.
  t = t.replace(/\s*[→←↔⇒⇐⇔↗↘]\s*/g, ', ');
  t = t.replace(/\s*(?:<->|<=>|->|<-|=>|<=)\s*/g, ', ');

  // Residual brackets and pipes (e.g. orphan "|" from broken tables).
  t = t.replace(/[<>|]/g, '');

  // Local punctuation hygiene (final pass runs again at end of pipeline).
  t = t.replace(/\s+([.,;:!?])/g, '$1');
  t = t.replace(/([.,;:!?]){2,}/g, '$1');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Drop sub-sentences left behind by inline-strip. A sentence is dropped iff
 *   1. its tail-most token (ignoring trailing punctuation) is a strip marker
 *      — i.e. the stripped element was the OBJECT of a trailing preposition
 *      ("More at <URL>." / "Mehr unter <URL>."), AND
 *   2. fewer than STUB_MIN_WORDS speakable words remain.
 * Mid-sentence strips ("Result: {json} arrived.") are kept — surrounding
 * words still form a coherent utterance. Sentences without any marker
 * always pass through, so terse natural sentences like "Hi Jane." survive.
 */
function dropStubs(s: string): string {
  return s
    .split(/(?<=[.!?])\s+/)
    .filter((seg) => {
      const tail = seg.replace(/[\s.!?,;:]+$/, '');
      if (!tail.endsWith(M)) return true;
      const cleaned = seg.replace(M_RE, '');
      const words = cleaned.match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
      return words.length >= STUB_MIN_WORDS;
    })
    .join(' ');
}

function joinListItems(items: readonly string[], joiner: string): string {
  if (items.length === 1) return ensureEnd(items[0] ?? '');
  const last = stripTrailingPunct(items[items.length - 1] ?? '');
  const rest = items.slice(0, -1).map(stripTrailingPunct);
  return `${rest.join(', ')}${joiner}${last}.`;
}

function stripTrailingPunct(s: string): string { return s.replace(/[.,;:!?]+$/, '').trim(); }
function ensureEnd(s: string): string { return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`; }

/**
 * Decide how to render a Markdown table. Drops empty tables. Speaks 2- and
 * 3-column tables row-by-row up to TABLE_MAX_ROWS — 2-col uses "key: value",
 * 3-col uses comma-joined cells (the header is dropped in both cases — it's
 * label scaffolding, not speakable content). Anything wider or longer
 * collapses to a single summary sentence so the listener gets the count
 * without enduring a row recital.
 */
function speakTable(rows: readonly string[][], L: Labels): string {
  if (rows.length === 0) return '';
  if (rows.length > TABLE_MAX_ROWS) return L.tableSummary(rows.length);
  const cols = rows[0]?.length ?? 0;
  if (cols < 2 || cols > 3) return L.tableSummary(rows.length);

  const sentences: string[] = [];
  for (const r of rows) {
    const cells = r.map((c) => stripInline(mapSymbols(c, L)).trim());
    if (cells.length === 2) {
      const a = cells[0] ?? '';
      const b = cells[1] ?? '';
      if (a && b) sentences.push(`${a}: ${b}.`);
      continue;
    }
    const joined = cells.filter((c) => c.length > 0).join(', ');
    if (joined) sentences.push(`${joined}.`);
  }
  return sentences.join(' ');
}

function mapSymbols(cell: string, L: Labels): string {
  let t = cell;
  for (const [sym, word] of L.symbols) {
    t = t.split(sym).join(word);
  }
  return t;
}

// ----- block segmentation -----

function segmentBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      blocks.push({ kind: 'blank', lines: [line] });
      i++;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const start = i;
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) i++;
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ kind: 'code', lines: lines.slice(start, i) });
      continue;
    }

    if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr', lines: [line] });
      i++;
      continue;
    }

    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', lines: [line] });
      i++;
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? '')) {
      const start = i;
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? '')) i++;
      blocks.push({ kind: 'table', lines: lines.slice(start, i) });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) i++;
      blocks.push({ kind: 'quote', lines: lines.slice(start, i) });
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s/.test(lines[i] ?? '')) i++;
      blocks.push({ kind: 'list', lines: lines.slice(start, i) });
      continue;
    }

    // Paragraph — extends until blank or any structural-start.
    const start = i;
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !isStructuralStart(lines[i] ?? '', lines[i + 1] ?? '')
    ) i++;
    blocks.push({ kind: 'paragraph', lines: lines.slice(start, i) });
  }
  return blocks;
}

function isStructuralStart(line: string, next: string): boolean {
  if (/^\s*```/.test(line)) return true;
  if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) return true;
  if (isTableRow(line) && isTableSeparator(next)) return true;
  return false;
}

function isTableRow(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = parseTableCells(line);
  // ≥2 cells AND at least one non-empty — an all-blank pipe-row isn't a
  // semantic table row.
  return cells.length >= 2 && cells.some((c) => c.length > 0);
}

function isTableSeparator(line: string): boolean {
  const stripped = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (stripped.length === 0) return false;
  const cells = stripped.split('|').map((c) => c.trim());
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

function parseTableCells(line: string): string[] {
  const stripped = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // Empty cells are kept so column count stays stable (a 2-col table with
  // an empty value cell is still a 2-col table — speakTable decides per-row
  // whether to skip).
  return stripped.split('|').map((c) => c.trim());
}
