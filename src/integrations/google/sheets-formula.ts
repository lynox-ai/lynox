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
 * asked once more. For the same reason the value is read as Google might normalise it: with
 * compatibility forms folded (a full-width `＝` reads as `=`), invisible format characters
 * (`\p{Cf}`) dropped wherever they stand, and white space trimmed at both ends. That is where
 * it stops: a value that starts with another invisible character (a combining mark, a Hangul
 * filler, the blank braille cell) is not counted. What Google itself strips before reading a formula is not measured.
 */
export function startsLikeFormula(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
  const first = text[0];
  if (first === '=') return true;
  if (first !== '+' && first !== '-') return false;
  return !PLAIN_NUMBER.test(text);
}

/**
 * The value written so that Google keeps it as text: a leading apostrophe, which user input
 * reads as "this is text" and does not store.
 */
export function asText(value: string): string {
  return `'${value}`;
}

export interface FormulaCell {
  /** Where the cell goes: its address when the write names its first cell, else its place. */
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

/**
 * The first cell a range names in A1 form (`B2`, `Sheet1!$B$2:D5`), as column index and row
 * number; undefined when it names none (`Sheet1`, `B:D`, `R2C3`).
 */
function firstCell(range: string | undefined): { col: number; row: number } | undefined {
  if (range === undefined) return undefined;
  const local = range.slice(range.lastIndexOf('!') + 1);
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)(?=$|:)/.exec(local);
  if (!match) return undefined;
  return { col: columnIndex(match[1]!), row: Number(match[2]) };
}

/** 1 → 1st, 2 → 2nd, 11 → 11th, 23 → 23rd. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * Every cell of `values` that may be read as a formula, named as the owner finds it. A write
 * whose range names its first cell starts there, so the cell gets its address (`C2`). Otherwise
 * it is named by its place in the values given (`1st row, 2nd value`): an append's rows go where
 * Google finds the end of the table, and where its columns start is Google's to find too.
 */
export function formulaCells(values: unknown, range: string | undefined, action: 'write' | 'append'): FormulaCell[] {
  if (!Array.isArray(values)) return [];
  const start = action === 'write' ? firstCell(range) : undefined;
  const rows = action === 'append' ? 'new row' : 'row';
  const found: FormulaCell[] = [];
  values.forEach((row, r) => {
    if (!Array.isArray(row)) return;
    row.forEach((value, c) => {
      if (!startsLikeFormula(value)) return;
      const cell = start
        ? `${columnName(start.col + c)}${start.row + r}`
        : `${ordinal(r + 1)} ${rows}, ${ordinal(c + 1)} value`;
      found.push({ cell, formula: value });
    });
  });
  return found;
}

/** `values` with every cell that may be read as a formula written as text instead. */
export function formulasAsText(values: unknown[][]): unknown[][] {
  return values.map((row) => (Array.isArray(row) ? row.map((v) => (startsLikeFormula(v) ? asText(v) : v)) : row));
}
