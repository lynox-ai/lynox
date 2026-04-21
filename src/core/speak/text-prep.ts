/**
 * Markdown → spoken-text sanitizer.
 *
 * Raw assistant replies are Markdown. Reading them verbatim through a TTS
 * engine produces "asterisk-asterisk" for bold, URLs read character-by-character,
 * code fences as noise. This module flattens Markdown to a spoken-friendly
 * form, preserving punctuation for prosody.
 *
 * Phase 0 finding (voice-tts.md, 2026-04-16): prosody scales with input length.
 * Short replies read flatter than long ones because the model plans intonation
 * over the whole input. Preferring spoken connectors over terse bullet lists
 * partially offsets this.
 */

/**
 * Flatten Markdown-ish assistant output into text a TTS can read cleanly.
 * Pure function. No throws. Empty input returns empty string.
 */
export function prepareForSpeech(input: string): string {
  if (!input) return '';
  let text = input;

  // Arrows first — before anything else can mangle them. A comma gives the
  // TTS engine a natural prosody pause without guessing a language-specific
  // connector ("to" vs. "zu" vs. "à"). ASCII forms (`<->`, `->`, `<-`) are
  // ordered longest-first so `<->` isn't partially eaten by `<-`.
  text = text.replace(/\s*(?:→|←|↔|⇒|⇐|⇔)\s*/g, ', ');
  text = text.replace(/\s*(?:<->|->|<-)\s*/g, ', ');

  text = text.replace(/```[\s\S]*?```/g, '. ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/`+/g, '');

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  text = text.replace(/https?:\/\/\S+/g, ' ');

  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(?<![*_])[*_]([^*_\n]+)[*_](?![*_])/g, '$1');

  text = text.replace(/^\s*>\s?/gm, '');

  text = text.replace(/<[^>]+>/g, ' ');

  // Horizontal rules (---, ***, ___ on their own line) read as "dash dash
  // dash" in TTS — drop standalone occurrences. Anchored to full line so
  // em-dashes mid-sentence stay untouched.
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');

  text = flattenTables(text);
  text = flattenLists(text);

  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\n{2,}/g, '. ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/([,.;:!?]){2,}/g, '$1');

  return text.trim();
}

/**
 * Collapse bullet/numbered lists into comma- and "und"-joined sentences so TTS
 * prosody doesn't lurch at every bullet. Non-list lines pass through untouched.
 */
function flattenLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let runStart = -1;

  const flushRun = (endExclusive: number): void => {
    if (runStart < 0) return;
    const items = lines
      .slice(runStart, endExclusive)
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter((l) => l.length > 0);
    if (items.length > 0) out.push(joinItems(items));
    runStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
      out.push(line);
    }
  }
  flushRun(lines.length);
  return out.join('\n');
}

function joinItems(items: string[]): string {
  if (items.length === 1) return ensureSentenceEnd(items[0]!);
  const last = items[items.length - 1]!;
  const rest = items.slice(0, -1).map(stripTrailingPunct);
  return `${rest.join(', ')} und ${stripTrailingPunct(last)}.`;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?]+$/, '').trim();
}

function ensureSentenceEnd(s: string): string {
  return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}

/**
 * Collapse Markdown pipe-tables into TTS-friendly sentences. A table is
 * detected by the canonical GFM shape: a pipe-bearing header row directly
 * followed by a separator row whose cells are only dashes/colons. 2-column
 * tables are typically key/value layouts — spoken as `"key: value."` lines,
 * dropping the visually-convenient header row because it adds no prosody.
 * Wider tables fall back to comma-joined rows preceded by the header.
 * Non-table lines pass through untouched.
 */
function flattenTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = i + 1 < lines.length ? lines[i + 1] ?? '' : '';
    if (isTableRow(line) && isTableSeparator(next)) {
      const header = parseTableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        rows.push(parseTableCells(lines[i] ?? ''));
        i++;
      }
      out.push(speakTable(header, rows));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function isTableRow(line: string): boolean {
  if (!line.includes('|')) return false;
  return parseTableCells(line).length >= 2;
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
  return stripped
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function speakTable(header: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return header.length > 0 ? `${header.join(', ')}.` : '';
  }
  // 2-col: speak each row as "a: b." — drop the header row, it's
  // visual-only ("Metric | Value") and adds no semantic weight.
  if (header.length === 2) {
    return rows
      .map((r) => {
        if (r.length >= 2) {
          const [first, ...rest] = r;
          return `${first ?? ''}: ${rest.join(' ')}.`;
        }
        return r.length === 1 ? `${r[0] ?? ''}.` : '';
      })
      .filter((s) => s.length > 0)
      .join(' ');
  }
  // N-col: header + rows each as comma-joined sentence.
  const sentences = [`${header.join(', ')}.`];
  for (const r of rows) if (r.length > 0) sentences.push(`${r.join(', ')}.`);
  return sentences.join(' ');
}
