// Detects a reply that writes a tool call out as TEXT, over and over, instead of
// calling the tool. Some models, once they slip into a provider-specific call
// syntax as plain text, repeat the same call in the reply until the output limit:
// nothing runs, the user waits, and every token is billed.
//
// A candidate unit is one of:
//   (a) tool-call markup — `<tool_call>…</tool_call>`, `<|tool_call_begin|>…`,
//       `<function=NAME>…</function>`, `<invoke name="…">…</invoke>`,
//       `[TOOL_CALLS]…`, `<|python_tag|>…`;
//   (b) the name of a tool sent with the request, followed by `(` or `{` (Mistral
//       puts `[ARGS]` in between), up to the balanced close;
//   (c) a JSON object, not inside another JSON object, that names a sent tool in its
//       `name`, `tool` or `function` field, or whose top-level keys include at least
//       two input properties of ONE sent tool and carry a concrete value.
// A unit's signature is its text with whitespace collapsed. The detector trips
// when the SAME signature has appeared TOOL_CALL_IMITATION_REPEATS times in a row in
// one reply, each copy starting within MAX_COPY_GAP characters of the previous one,
// and the reply has not started a real tool call.
//
// Pure and incremental: text arrives in deltas of any size, and each push scans
// only from the first position that is not yet settled. The work per position is
// bounded by the unit length, so a reply costs linear time up to that bound.

/** How many identical copies of one unit in a single reply stop it. */
export const TOOL_CALL_IMITATION_REPEATS = 3;

/** Longest unit considered. */
export const MAX_UNIT_CHARS = 2000;

/** Most characters between the end of one copy and the start of the next for both to count
 *  as one run of copies. */
export const MAX_COPY_GAP = 300;

/** String values that hold a slot rather than a value (compared trimmed, case-insensitive);
 *  `<…>` in angle brackets counts too. */
export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(['', '...', '…', 'tbd', 'xxx', 'string', 'example', 'todo']);

function isPlaceholder(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return PLACEHOLDER_VALUES.has(s) || /^<[^<>]*>$/.test(s);
}

/** How far back a start token that may still be arriving is looked for (`<function=…>` is the longest). */
const START_TAIL = 256;

export interface ImitationTool {
  readonly name: string;
  /** Top-level property names of the tool's input schema. */
  readonly properties: readonly string[];
}

export interface ImitationHit {
  /** The tool the unit names or whose input it carries, when known. */
  readonly toolName: string | undefined;
  readonly signature: string;
  readonly count: number;
}

/** The tools of a request, in the shape the detector reads. Entries without a name are skipped. */
export function imitationToolsFrom(tools: readonly unknown[]): ImitationTool[] {
  const out: ImitationTool[] = [];
  for (const t of tools) {
    if (typeof t !== 'object' || t === null) continue;
    const name = (t as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const schema = (t as { input_schema?: unknown }).input_schema;
    const props = typeof schema === 'object' && schema !== null ? (schema as { properties?: unknown }).properties : undefined;
    const properties = typeof props === 'object' && props !== null && !Array.isArray(props) ? Object.keys(props) : [];
    out.push({ name, properties });
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Markup openers and how each unit ends: a closing tag, or the end of the line. */
const MARKUP: ReadonlyArray<{ open: RegExp; close: (opener: string) => string }> = [
  { open: /^<tool_call>/, close: () => '</tool_call>' },
  { open: /^<\|tool_calls?(?:_section)?_begin\|>/, close: (o) => o.replace('_begin', '_end') },
  { open: /^<function=[^>\n]{1,200}>/, close: () => '</function>' },
  { open: /^<invoke\s+name="[^"\n]{1,200}"\s*>/, close: () => '</invoke>' },
  // These two have no closing tag: a unit ends at the end of the line or where the next
  // one opens, whichever comes first.
  { open: /^\[TOOL_CALLS\]/, close: () => '\n' },
  { open: /^<\|python_tag\|>/, close: () => '\n' },
];
const MARKUP_START = String.raw`<tool_call>|<\|tool_calls?(?:_section)?_begin\|>|<function=[^>\n]{1,200}>|<invoke\s+name="[^"\n]{1,200}"\s*>|\[TOOL_CALLS\]|<\|python_tag\|>`;

type Resolved =
  | { kind: 'unit'; end: number; toolName: string | undefined }
  | { kind: 'none' }
  | { kind: 'pending' };

export class ToolCallImitationDetector {
  private readonly tools: ReadonlyMap<string, ImitationTool>;
  private readonly start: RegExp;
  /** The reply from shortly before `pos` on; settled text is dropped. */
  private buf = '';
  /** Position in the whole reply of `buf[0]`. */
  private base = 0;
  /** Every candidate start before this position is settled. */
  private pos = 0;
  /** End, in the whole reply, of the last JSON object read; an object starting before it is nested. */
  private jsonSpanEnd = 0;
  /** Starts below this were already resolved; the tail kept for a partly arrived start token
   *  is scanned again, but what was resolved there is not resolved twice. */
  private resolvedUpTo = 0;
  /** Per signature: copies in the current run, and where (in the whole reply) the last one ended. */
  private readonly runs = new Map<string, { count: number; end: number }>();
  private toolUseSeen = false;

  constructor(tools: readonly ImitationTool[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    const names = tools.map((t) => escapeRe(t.name)).sort((a, b) => b.length - a.length);
    const nameStart = names.length > 0 ? String.raw`|(?<![A-Za-z0-9_-])(?:${names.join('|')})\s*(?:\[ARGS\])?[({]` : '';
    this.start = new RegExp(`${MARKUP_START}${nameStart}|\\{`, 'g');
  }

  /** A real tool call has started in this reply. */
  noteToolUse(): void {
    this.toolUseSeen = true;
  }

  /** Feed the next text delta. Returns the hit when the reply has to stop, else null. */
  push(text: string): ImitationHit | null {
    if (text.length === 0) return null;
    // Only the unsettled text is kept (plus one character for the name look-behind): a
    // growing string would be copied whole on every scan.
    if (this.pos > 1) {
      const cut = this.pos - 1;
      this.buf = this.buf.slice(cut);
      this.base += cut;
      this.pos -= cut;
      this.resolvedUpTo = Math.max(0, this.resolvedUpTo - cut);
    }
    this.buf += text;
    const re = this.start;
    re.lastIndex = this.pos;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf)) !== null) {
      const at = m.index;
      if (at < this.resolvedUpTo) {
        re.lastIndex = at + 1;
        continue;
      }
      const r = this.resolve(at, m[0]);
      if (r.kind === 'pending') {
        this.pos = at;
        return null;
      }
      this.resolvedUpTo = at + 1;
      if (r.kind === 'none') {
        re.lastIndex = at + 1;
        continue;
      }
      this.pos = r.end;
      re.lastIndex = r.end;
      const signature = this.buf.slice(at, r.end).replace(/\s+/g, ' ').trim();
      const prev = this.runs.get(signature);
      const count = prev !== undefined && this.base + at - prev.end <= MAX_COPY_GAP ? prev.count + 1 : 1;
      this.runs.set(signature, { count, end: this.base + r.end });
      if (count >= TOOL_CALL_IMITATION_REPEATS && !this.toolUseSeen) {
        return { toolName: r.toolName, signature, count };
      }
    }
    this.keepPartialStart();
    return null;
  }

  /**
   * Moves `pos` to the end of the text, except for a start token that may still be
   * arriving: an unclosed `<…` or `[…`, or a trailing word that may be a tool's name.
   * Only the last START_TAIL characters are looked at, so a push costs its own length.
   */
  private keepPartialStart(): void {
    const len = this.buf.length;
    const from = Math.max(this.pos, len - START_TAIL);
    const tail = this.buf.slice(from);
    let keep = len;
    const lt = tail.lastIndexOf('<');
    if (lt >= 0 && !tail.includes('>', lt)) keep = Math.min(keep, from + lt);
    const lb = tail.lastIndexOf('[');
    if (lb >= 0 && !tail.includes(']', lb)) keep = Math.min(keep, from + lb);
    const word = /[A-Za-z0-9_-]+\s*(?:\[[A-Z]*\]?)?$/.exec(tail);
    if (word) keep = Math.min(keep, from + word.index);
    this.pos = Math.max(this.pos, keep);
  }

  private resolve(at: number, matched: string): Resolved {
    if (matched === '{') return this.resolveJson(at);
    for (const mk of MARKUP) {
      if (!mk.open.test(matched)) continue;
      const close = mk.close(matched);
      const from = at + matched.length;
      let idx = this.buf.indexOf(close, from);
      if (close === '\n') {
        const next = this.buf.indexOf(matched, from);
        if (next >= 0 && (idx < 0 || next < idx)) idx = next;
      }
      const limit = at + MAX_UNIT_CHARS;
      if (idx >= 0 && idx + close.length <= limit) {
        const end = close === '\n' ? idx : idx + close.length;
        return { kind: 'unit', end, toolName: this.markupTool(matched, from, idx) };
      }
      return this.buf.length < limit ? { kind: 'pending' } : { kind: 'none' };
    }
    // A tool's name followed by `(` or `{`.
    const open = at + matched.length - 1;
    const name = matched.slice(0, matched.length - 1).replace(/\[ARGS\]$/, '').trimEnd();
    const end = this.balanced(open);
    if (end === 'pending') return { kind: 'pending' };
    if (end === null) return { kind: 'none' };
    // A call carries something between its brackets.
    if (this.buf.slice(open + 1, end - 1).trim().length === 0) return { kind: 'none' };
    return { kind: 'unit', end, toolName: name };
  }

  private resolveJson(at: number): Resolved {
    if (this.base + at < this.jsonSpanEnd) return { kind: 'none' };
    const end = this.balanced(at);
    if (end === 'pending') return { kind: 'pending' };
    if (end === null) return { kind: 'none' };
    let parsed: unknown;
    try { parsed = JSON.parse(this.buf.slice(at, end)); } catch { return { kind: 'none' }; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'none' };
    this.jsonSpanEnd = this.base + end;
    const named = this.namedTool(parsed as Record<string, unknown>);
    if (named !== undefined) return { kind: 'unit', end, toolName: named };
    if (Object.values(parsed).every(isPlaceholder)) return { kind: 'none' };
    const keys = Object.keys(parsed);
    // The tool sharing the most keys; on a tie the one with fewer properties fits closer.
    let best: ImitationTool | undefined;
    let bestShared = 0;
    for (const tool of this.tools.values()) {
      let shared = 0;
      for (const k of keys) if (tool.properties.includes(k)) shared++;
      if (shared > bestShared || (shared === bestShared && best !== undefined && tool.properties.length < best.properties.length)) {
        best = tool;
        bestShared = shared;
      }
    }
    return best !== undefined && bestShared >= 2 ? { kind: 'unit', end, toolName: best.name } : { kind: 'none' };
  }

  /** The sent tool an object names in `name`, `tool`, `function` or `function.name`. */
  private namedTool(o: Record<string, unknown>): string | undefined {
    const fn = o['function'];
    const fnName = typeof fn === 'object' && fn !== null ? (fn as Record<string, unknown>)['name'] : fn;
    for (const v of [o['name'], o['tool'], fnName]) {
      if (typeof v === 'string' && this.tools.has(v)) return v;
    }
    return undefined;
  }

  /** The tool a markup unit names, when one of the sent tools appears in it. */
  private markupTool(opener: string, from: number, to: number): string | undefined {
    const head = opener + this.buf.slice(from, Math.min(to, from + 200));
    let best: string | undefined;
    for (const name of this.tools.keys()) {
      if (head.includes(name) && (best === undefined || name.length > best.length)) best = name;
    }
    return best;
  }

  /**
   * End (exclusive) of the bracket group opening at `open`, skipping double-quoted
   * strings; 'pending' when the text so far ends inside it, null when it does not
   * close within MAX_UNIT_CHARS.
   */
  private balanced(open: number): number | 'pending' | null {
    const limit = open + MAX_UNIT_CHARS;
    const stop = Math.min(this.buf.length, limit);
    let depth = 0;
    let inStr = false;
    for (let i = open; i < stop; i++) {
      const c = this.buf.charCodeAt(i);
      if (inStr) {
        if (c === 92 /* \ */) i++;
        else if (c === 34 /* " */) inStr = false;
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 40 /* ( */ || c === 123 /* { */ || c === 91 /* [ */) depth++;
      else if (c === 41 /* ) */ || c === 125 /* } */ || c === 93 /* ] */) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return this.buf.length < limit ? 'pending' : null;
  }
}
