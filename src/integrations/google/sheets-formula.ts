/**
 * Formulas in what the sheets tool writes.
 *
 * `write` and `append` send their cells as user input (`valueInputOption=USER_ENTERED`), so Google
 * reads a cell as if it had been typed: a cell that starts with `=` becomes a formula, and Google
 * runs it on its side. Some formulas fetch an address named in them (`IMPORTXML`, `IMPORTDATA`,
 * `IMPORTHTML`, `IMPORTFEED`, `IMAGE`). The engine's request goes to Google, so no check on the
 * engine's own requests sees that address. After content from outside the chat, the model may be
 * choosing such a cell for someone else; these helpers find the cells so the owner sees them.
 */

/** A number as Sheets reads it: sign, digits with one decimal mark, an exponent, a percent. */
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?%?$/i;

/**
 * Whether Google may read this value as a formula when it is written as user input.
 *
 * `=` makes a formula. `+` and `-` are counted too unless the value is a plain number: whether
 * Sheets reads `+A1` as a formula is not measured here, and counting it only means the owner is
 * asked once more. Leading white space is skipped, for the same reason.
 */
export function startsLikeFormula(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trimStart();
  const first = text[0];
  if (first === '=') return true;
  if (first !== '+' && first !== '-') return false;
  return !PLAIN_NUMBER.test(text.trimEnd());
}

/**
 * The value written so that Google keeps it as text: a leading apostrophe, which user input
 * reads as "this is text" and does not store.
 */
export function asText(value: string): string {
  return `'${value}`;
}

export interface FormulaCell {
  /** Where the cell goes: an A1 address when the range names its first cell, else row and column. */
  readonly cell: string;
  readonly formula: string;
}

/** Column letters for a 0-based column index (0 → A, 26 → AA). */
function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** 0-based column index of column letters (A → 0, AA → 26). */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The first cell a range names, as column index and row number; undefined when it names none. */
function firstCell(range: string | undefined): { col: number; row: number } | undefined {
  if (range === undefined) return undefined;
  const local = range.slice(range.lastIndexOf('!') + 1);
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)/.exec(local);
  if (!match) return undefined;
  return { col: columnIndex(match[1]!), row: Number(match[2]) };
}

/** The first column a range names when it names no row (`A:C`, `Sheet1!B:B`); undefined otherwise. */
function firstColumn(range: string | undefined): number | undefined {
  if (range === undefined) return undefined;
  const local = range.slice(range.lastIndexOf('!') + 1);
  const match = /^\$?([A-Za-z]{1,3})\$?\d*:/.exec(local);
  return match ? columnIndex(match[1]!) : undefined;
}

/** 1 → 1st, 2 → 2nd, 11 → 11th, 23 → 23rd. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * Every cell of `values` that may be read as a formula, named as the owner finds it. A write
 * whose range names its first cell gives the address (`C2`). Otherwise the cell is named by its
 * place among the rows given — for an append, the new rows, which Google places after the
 * table — and by its column letter when the range names the first column.
 */
export function formulaCells(values: unknown, range: string | undefined, action: 'write' | 'append'): FormulaCell[] {
  if (!Array.isArray(values)) return [];
  const start = action === 'write' ? firstCell(range) : undefined;
  const col0 = start?.col ?? firstColumn(range);
  const rows = action === 'append' ? 'new row' : 'row';
  const found: FormulaCell[] = [];
  values.forEach((row, r) => {
    if (!Array.isArray(row)) return;
    row.forEach((value, c) => {
      if (!startsLikeFormula(value)) return;
      const column = col0 === undefined ? `column ${c + 1}` : `column ${columnName(col0 + c)}`;
      const cell = start
        ? `${columnName(start.col + c)}${start.row + r}`
        : `${ordinal(r + 1)} ${rows}, ${column}`;
      found.push({ cell, formula: value });
    });
  });
  return found;
}

/** `values` with every cell that may be read as a formula written as text instead. */
export function formulasAsText(values: unknown[][]): unknown[][] {
  return values.map((row) => (Array.isArray(row) ? row.map((v) => (startsLikeFormula(v) ? asText(v) : v)) : row));
}

/**
 * The formulas raw `batchUpdate` requests carry: every `formulaValue`, and every piece of a
 * `pasteData` or a `findReplace` replacement that starts like one (pasted data and a replacement
 * are read as typed).
 */
export function formulasInRequests(requests: unknown): string[] {
  const found: string[] = [];
  const pieces = (text: string, delimiter: string | undefined): void => {
    for (const line of text.split(/\r?\n/)) {
      for (const piece of delimiter ? line.split(delimiter) : [line]) {
        if (startsLikeFormula(piece)) found.push(piece);
      }
    }
  };
  const walk = (node: unknown, key: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, undefined);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (key === 'pasteData' && typeof obj['data'] === 'string') {
      // Sheets splits pasted data at `delimiter`; without one it reads commas.
      pieces(obj['data'], typeof obj['delimiter'] === 'string' && obj['delimiter'] !== '' ? obj['delimiter'] : ',');
    }
    if (key === 'findReplace' && typeof obj['replacement'] === 'string') pieces(obj['replacement'], undefined);
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'formulaValue' && typeof v === 'string') found.push(v);
      else walk(v, k);
    }
  };
  walk(requests, undefined);
  return found;
}
