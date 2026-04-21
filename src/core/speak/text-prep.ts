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

  // Detect language context ONCE — the arrow-connector choice below and
  // the sentence-initial "Die" fix at the end both depend on it, and
  // scanning twice would duplicate work.
  const deContext = hasGermanMarkers(text);

  // Arrows — language-dependent connector. In German a comma (`A, B`)
  // reads abrupt on small voices, so DE chains get " dann " (≈ /daːn/,
  // "then"). English would pronounce "dann" as /dæn/ (the name "Dan"),
  // which is worse than the plain comma — so EN falls back to ", ".
  // ASCII forms (`<->`, `<=>`, `->`, `<-`, `=>`, `<=`) ordered longest
  // first so `<->` isn't partially eaten by `<-`.
  const arrowConnector = deContext ? ' dann ' : ', ';
  text = text.replace(/\s*(?:→|←|↔|⇒|⇐|⇔)\s*/g, arrowConnector);
  text = text.replace(/\s*(?:<->|<=>|->|<-|=>|<=)\s*/g, arrowConnector);

  // Less-than + digit (e.g. "<4h", "<100ms") — strip the "<" so TTS reads
  // the quantity naturally instead of choking on the bracket. We lose the
  // "less than" nuance, but preserving a readable quantity is more important.
  text = text.replace(/<(\s?\d)/g, '$1');

  text = text.replace(/```[\s\S]*?```/g, '. ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/`+/g, '');

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  text = text.replace(/https?:\/\/\S+/g, ' ');

  // Price/rate-per-unit expansion. "39/mo" reads as "thirty-nine slash mo"
  // on Voxtral — expand to the natural phrasing a human would say. Language-
  // aware: "pro Monat" in DE context, "per month" otherwise. Handles the
  // English (mo/yr/d/h), German (Monat/Jahr/Tag/Stunde), and long-form
  // (month/year/day/hour) variants. Ordered longest-first so "/month" is
  // not partially eaten by "/mo". Runs BEFORE the generic slash rule so
  // the unit abbreviations get the expanded form instead of just ", ".
  const perMonth = deContext ? ' pro Monat' : ' per month';
  const perYear  = deContext ? ' pro Jahr'  : ' per year';
  const perDay   = deContext ? ' pro Tag'   : ' per day';
  const perHour  = deContext ? ' pro Stunde': ' per hour';
  text = text.replace(/(\d)\s*\/\s*(?:month|Monat|mo)\b/gi, `$1${perMonth}`);
  text = text.replace(/(\d)\s*\/\s*(?:year|Jahr|yr)\b/gi, `$1${perYear}`);
  text = text.replace(/(\d)\s*\/\s*(?:day|Tag|d)\b/gi, `$1${perDay}`);
  text = text.replace(/(\d)\s*\/\s*(?:hour|Stunde|h)\b/gi, `$1${perHour}`);

  // Generic slash between word-tokens (e.g. "Wachstum/SLA", "EU/US",
  // "customer/invoice") — convert to ", " so TTS treats them as a list.
  // Two passes: letter on the left (letter-first cases), and digit on the
  // left with letter on the right ("Q2/March"). Digit/digit is intentionally
  // NOT matched so dates (04/21), fractions (1/2), and version ranges
  // (3.9/3.10) pass through unchanged. URLs stripped earlier.
  text = text.replace(/(\p{L})\s*\/\s*([\p{L}\p{N}])/gu, '$1, $2');
  text = text.replace(/(\p{N})\s*\/\s*(\p{L})/gu, '$1, $2');

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

  if (deContext) text = tweakGermanPronunciation(text);

  return text.trim();
}

/**
 * Cheap language heuristic: true if the text shows unambiguous German
 * signals. Used to gate every rule that could misbehave on English or
 * mixed content — an "arrow → dann" collapse in EN would make the voice
 * say "Dan", and a "Die → Dee" rewrite on an English movie title would
 * just be wrong.
 *
 * Stopword list intentionally excludes "die"/"das" — those are the tokens
 * we may transform, and counting them as DE evidence would let English
 * sentences containing them trigger the rewrite.
 */
function hasGermanMarkers(text: string): boolean {
  return (
    /[äöüÄÖÜß]/.test(text) ||
    /\b(?:der|und|ist|nicht|eine?|mit|für|auch|werden|sind|nach|sehr|oder)\b/i.test(text)
  );
}

/**
 * Tiny pronunciation adjustments for DE text being read by an EN voice
 * (Voxtral's TTS catalog is EN-only as of Phase 0). Caller must already
 * have verified DE context via `hasGermanMarkers`. Today this only rewrites
 * sentence-initial "Die" → "Dee" — the EN voice otherwise reads "Die" as
 * /daɪ/ (as in "to die"). "Dee" reads as /diː/, close to the DE /diː/
 * pronunciation. Extend cautiously: every rule added here reshapes the
 * visible spoken text and can misfire on mixed-language content.
 */
function tweakGermanPronunciation(text: string): string {
  // Replace "Die" only at sentence boundaries (start of text or after
  // terminal punctuation), so mid-sentence "die" doesn't accidentally
  // match and the English "Die Hard" never mutates.
  return text.replace(/(^|[.!?]\s+)Die\b/g, '$1Dee');
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
