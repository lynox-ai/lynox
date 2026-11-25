import type { ToolEntry, IAgent, PromptText } from '../../types/index.js';
import { currentCallSignal } from '../../core/call-connection.js';
import type { GoogleAuth } from './google-auth.js';
import { SCOPES } from './google-auth.js';
import { GOOGLE_NOT_CONNECTED } from './not-connected.js';
import { refuseUnlessScoped } from './action-scopes.js';
import { getErrorMessage } from '../../core/utils.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';
import { pv, joinPrompts, singleLine } from '../../core/prompt-value.js';
import { deriveTurnUntrusted } from '../../core/untrusted-signals.js';
import { formulaCells, formulasAsText, type FormulaCell } from './sheets-formula.js';
import { googleFetch } from '../../core/connector-egress.js';
import { isInputRequired } from '../../core/input-required.js';
import { namedTarget, withoutAddresses } from '../../core/audit-log.js';

// === Types ===

interface SheetsInput {
  action: 'read' | 'write' | 'append' | 'create' | 'list' | 'format';
  spreadsheet_id?: string | undefined;
  range?: string | undefined;
  values?: unknown[][] | undefined;
  title?: string | undefined;
  sheet_names?: string[] | undefined;
  format_requests?: unknown[] | undefined;
}

interface SheetValuesResponse {
  range: string;
  majorDimension: string;
  values?: string[][];
}

interface SpreadsheetResponse {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties: { title: string };
  sheets?: Array<{ properties: { title: string; sheetId: number } }>;
}

interface DriveFileListResponse {
  files?: Array<{ id: string; name: string; modifiedTime: string; webViewLink: string }>;
}

// === Constants ===

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES_BASE = 'https://www.googleapis.com/drive/v3/files';

// `format` is included: handleFormat forwards `format_requests` verbatim to the
// Sheets :batchUpdate endpoint, which supports destructive request types
// (deleteSheet / deleteRange / deleteDimension / updateCells) — i.e. arbitrary
// spreadsheet mutation, not cosmetics. It must be confirmed + flagged destructive
// like write/append. (`create` only makes a NEW spreadsheet → left unconfirmed.)
const CONFIRM_ACTIONS = new Set(['write', 'append', 'format']);

/**
 * The scopes each action's own API call accepts — see `action-scopes.ts` for
 * why this is one table per tool rather than a read gate beside a write gate.
 *
 * `list` is the odd one: it queries Drive (`files.list`) rather than Sheets,
 * so it is authorised by Drive scopes and by no Sheets scope at all.
 */
const ACTION_SCOPES: Record<SheetsInput['action'], readonly string[]> = {
  read: [SCOPES.SHEETS_READONLY, SCOPES.SHEETS],
  list: [SCOPES.DRIVE_FILE, SCOPES.DRIVE_READONLY, SCOPES.DRIVE, SCOPES.DRIVE_METADATA_READONLY],
  write: [SCOPES.SHEETS],
  append: [SCOPES.SHEETS],
  create: [SCOPES.SHEETS],
  format: [SCOPES.SHEETS],
};

const ACTION_DESCRIPTIONS: Record<SheetsInput['action'], string> = {
  read: 'Reading a spreadsheet',
  list: 'Listing spreadsheets',
  write: 'Overwriting a range',
  append: 'Appending rows',
  create: 'Creating a spreadsheet',
  format: 'Applying batch changes',
};

// === Helpers ===

async function sheetsFetch(auth: GoogleAuth, url: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  const response = await googleFetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    // The 30 s limit always holds: a caller's signal is added to it, never in its place. Only
    // the read actions pass one — the call's (`currentCallSignal`), so a stop of the run ends
    // the read. A write takes none and runs to its end once it started. The token refresh
    // above takes no signal either: it is shared by every call waiting on it, and one stopped
    // call must not fail the others.
    signal: options?.signal ? AbortSignal.any([AbortSignal.timeout(30_000), options.signal]) : AbortSignal.timeout(30_000),
  }, auth.hostPolicy);
  return response;
}

function valuesToMarkdownTable(values: string[][]): string {
  if (values.length === 0) return '(Empty range)';

  // First row as header
  const header = values[0]!;
  const rows = values.slice(1);

  // Calculate column widths
  const widths = header.map((h, i) => {
    const colValues = [h, ...rows.map(r => r[i] ?? '')];
    return Math.max(...colValues.map(v => v.length), 3);
  });

  const headerLine = '| ' + header.map((h, i) => h.padEnd(widths[i]!)).join(' | ') + ' |';
  const separatorLine = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const dataLines = rows.map(row =>
    '| ' + header.map((_, i) => (row[i] ?? '').padEnd(widths[i]!)).join(' | ') + ' |'
  );

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

// === Formulas after content from outside ===

const WRITE_AS_TEXT = 'Write as text';
const WRITE_AS_FORMULAS = 'Write as formulas';
const DONT_WRITE = 'Don’t write';
/** Listed first: the choice that writes no formula. */
const FORMULA_OPTIONS = [WRITE_AS_TEXT, WRITE_AS_FORMULAS, DONT_WRITE];
/**
 * When some formulas are only counted: writing formulas the owner was not shown is not offered,
 * since a harmless five could stand in front of the one that fetches.
 */
const FORMULA_OPTIONS_SOME_HIDDEN = [WRITE_AS_TEXT, DONT_WRITE];
/** Formula lines shown before the rest is counted. */
export const FORMULAS_SHOWN = 5;

/** The cells of a write or an append that may be read as a formula, in call order. */
function formulasToShow(input: SheetsInput): FormulaCell[] {
  if (input.action === 'write') return formulaCells(input.values, input.range, 'write');
  if (input.action === 'append') return formulaCells(input.values, input.range, 'append');
  return [];
}

/** The option an answer names: by its label, or by its number in the list (1-based). */
function chosenOption(answer: string, options: readonly string[]): string | undefined {
  const byLabel = options.find((o) => o.toLowerCase() === answer.trim().toLowerCase());
  if (byLabel !== undefined) return byLabel;
  const index = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1;
  return options[index];
}

/**
 * What the question adds: why it asks, then each cell and its whole formula as a value. A
 * formula is never shortened, since the address in it is what the owner decides on; a line
 * break in it is not kept, so it cannot draw another cell's line.
 */
function formulaNote(formulas: readonly FormulaCell[]): PromptText {
  const n = formulas.length;
  const head = n === 1
    ? pv`This chat has read content from outside lynox, such as a web page, an email or a file. 1 of these cells starts like a formula, and Google runs a formula when it is written. A formula can make Google fetch an address named in it, with data from the sheet in that address.`
    : pv`This chat has read content from outside lynox, such as a web page, an email or a file. ${n} of these cells start like a formula, and Google runs a formula when it is written. A formula can make Google fetch an address named in it, with data from the sheet in that address.`;
  const lines = formulas.slice(0, FORMULAS_SHOWN).map(({ cell, formula }) => pv`${cell}: ${singleLine(formula)}`);
  // With some only counted, the question offers no "Write as formulas" and says why, and how
  // to get it: each call is asked about on its own, so a call with at most FORMULAS_SHOWN shows
  // every formula. The sentence writes that number out, so it stays the question's own words;
  // tests hold the sentence to a copy of it and the copy's number to the constant.
  const more = n > FORMULAS_SHOWN
    ? [pv`and ${n - FORMULAS_SHOWN} more`, pv`Writing as formulas is offered only when every formula is shown here. To write them as formulas, ask in the chat to write at most 5 at a time.`]
    : [];
  return joinPrompts([head, ...lines, ...more], '\n');
}

/**
 * Request types that only change how cells look or how rows and columns are sized: none of them
 * carries cell content or a rule, so none can hold a formula. A list of what may pass, never of
 * what may not: a type missing here, or one Google adds later, is shown in full.
 * `updateDimensionProperties` is checked further, since it can also hide rows (see below).
 */
const PURE_FORMAT_TYPES = new Set([
  'updateBorders', 'mergeCells', 'unmergeCells', 'autoResizeDimensions',
  'addBanding', 'updateBanding', 'deleteBanding',
]);

/**
 * The parts of a cell format that change only how a cell looks, never what it reads as. Left out
 * on purpose: `numberFormat` (its pattern can show literal text or hide the value),
 * `textFormat.link` (a link to any address), `hyperlinkDisplayType` and `textDirection` (both
 * change how existing text reads). A part missing here is shown in full.
 */
const FORMAT_FIELDS = new Set(['backgroundColor', 'backgroundColorStyle', 'borders', 'padding', 'horizontalAlignment', 'verticalAlignment', 'wrapStrategy', 'textRotation']);
const TEXT_FORMAT_FIELDS = new Set(['bold', 'italic', 'underline', 'strikethrough', 'fontFamily', 'fontSize', 'foregroundColor', 'foregroundColorStyle']);

/** Deeper groups than this are not read as a mask; such a request is shown. */
const MASK_DEPTH = 8;

/**
 * The full paths a field mask names, or null when it is not a mask in Google's grammar: paths of
 * names joined by `.`, separated by `,`, where `a(b,c)` stands for `a.b,a.c`. Read whole, so a
 * path that only starts with an allowed name cannot carry another one behind it.
 */
function maskPaths(fields: string): string[] | null {
  let i = 0;
  const spaces = (): void => { while (fields[i] === ' ') i++; };
  const name = (): string | null => {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(fields.slice(i));
    if (m === null) return null;
    i += m[0].length;
    return m[0];
  };
  const list = (depth: number): string[] | null => {
    if (depth > MASK_DEPTH) return null;
    const out: string[] = [];
    for (;;) {
      spaces();
      let path = name();
      if (path === null) return null;
      while (fields[i] === '.') {
        i++;
        const next = name();
        if (next === null) return null;
        path += `.${next}`;
      }
      spaces();
      if (fields[i] === '(') {
        i++;
        const inner = list(depth + 1);
        if (inner === null || fields[i] !== ')') return null;
        i++;
        const prefix = path;
        out.push(...inner.map((p) => `${prefix}.${p}`));
        spaces();
      } else {
        out.push(path);
      }
      if (fields[i] !== ',') return out;
      i++;
    }
  };
  const paths = list(0);
  return paths !== null && i === fields.length ? paths : null;
}

/** Whether a full mask path lies inside one of the parts of a cell format that only change looks. */
function looksOnlyPath(path: string): boolean {
  const [root, field, sub] = path.split('.');
  if (root !== 'userEnteredFormat' || field === undefined) return false;
  if (FORMAT_FIELDS.has(field)) return true;
  return field === 'textFormat' && sub !== undefined && TEXT_FORMAT_FIELDS.has(sub);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysWithin(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || (isPlainObject(value) && Object.keys(value).every((k) => allowed.has(k)));
}

const CELL_KEYS = new Set(['userEnteredFormat']);
const CELL_FORMAT_KEYS = new Set([...FORMAT_FIELDS, 'textFormat']);
const PIXEL_SIZE = new Set(['pixelSize']);

/**
 * Whether one :batchUpdate request can write no cell content, no rule, and nothing that changes
 * what a cell reads as. A request names its type as its only key; anything else is not taken as
 * pure. `repeatCell` is pure only when every path of its mask, and every part of its cell, is one
 * of the looks-only parts above; `updateDimensionProperties` only when it sets sizes, since it
 * can also hide rows.
 */
function isPureFormatRequest(request: unknown): boolean {
  if (!isPlainObject(request)) return false;
  const keys = Object.keys(request);
  if (keys.length !== 1) return false;
  const type = keys[0]!;
  if (PURE_FORMAT_TYPES.has(type)) return true;
  const body = request[type];
  if (!isPlainObject(body) || typeof body['fields'] !== 'string') return false;
  const paths = maskPaths(body['fields']);
  if (paths === null) return false;
  if (type === 'updateDimensionProperties') {
    return paths.every((p) => p === 'pixelSize') && keysWithin(body['properties'], PIXEL_SIZE);
  }
  if (type !== 'repeatCell' || !paths.every(looksOnlyPath)) return false;
  const cell = body['cell'];
  if (!keysWithin(cell, CELL_KEYS)) return false;
  const format = isPlainObject(cell) ? cell['userEnteredFormat'] : undefined;
  if (!keysWithin(format, CELL_FORMAT_KEYS)) return false;
  return keysWithin(isPlainObject(format) ? format['textFormat'] : undefined, TEXT_FORMAT_FIELDS);
}

/** Requests that can write cells shown with one question, and the length of each line. */
export const FORMAT_REQUESTS_SHOWN = 5;
export const FORMAT_LINE_MAX = 1000;

/**
 * A character a reader cannot see, or that changes how the text around it reads (format and
 * direction characters, separators, combining marks, fillers, any space but the plain one),
 * written as its escape, so nothing in a request can hide in a short line.
 */
const UNSEEN = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Mn}\p{Me}ᅟᅠㅤﾠ]|[^\S ]/gu;
function seen(text: string): string {
  return text.replace(UNSEEN, (c) => {
    const cp = c.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

/** The line a request is shown on: its type and its body as JSON, each character visible. */
function requestLine(request: unknown): { type: string | null; body: string; length: number } {
  const type = isPlainObject(request) && Object.keys(request).length === 1 ? Object.keys(request)[0]! : null;
  const body = seen(JSON.stringify(type === null ? request : (request as Record<string, unknown>)[type]) ?? 'null');
  const shownType = type === null ? 'request' : seen(type);
  return { type: type === null ? null : shownType, body, length: [...`${shownType}: ${body}`].length };
}

/**
 * What a format question adds after content from outside, when some requests can write cell
 * content or a rule: why it asks, then each of those requests in full, on one line each, so the
 * range and the content the owner decides on are in front of them. Null when every request is
 * pure formatting. A request is never shortened, since the part a line would lose is the part
 * that fetches; when more requests, or a longer one, than a question can show come in one call,
 * the call is refused instead, and the refusal says how to split it.
 */
function formatRequestsNote(requests: readonly unknown[]): { note: PromptText } | { refusal: string } | null {
  const shown = requests.filter((r) => !isPureFormatRequest(r));
  if (shown.length === 0) return null;
  const n = shown.length;
  const lines = shown.map(requestLine);
  if (n > FORMAT_REQUESTS_SHOWN || lines.some((l) => l.length > FORMAT_LINE_MAX)) {
    return { refusal: `Error: this chat has read content from outside lynox, so a "format" call is asked about with every request that can write cell content or a rule shown in full. This call has ${n} such request(s); a question shows at most ${FORMAT_REQUESTS_SHOWN}, each at most ${FORMAT_LINE_MAX} characters as shown. Split it: send pure formatting (borders, merges, sizes, bands, colours, bold) in one call, and at most ${FORMAT_REQUESTS_SHOWN} requests that write cells per call, each small enough to show in full (fewer cells or rows per request). Nothing was sent.` };
  }
  const head = n === 1
    ? pv`This chat has read content from outside lynox, such as a web page, an email or a file. 1 of these requests can write cell content or a rule, which can hold a formula, and Google runs a formula on its side. A formula can make Google fetch an address named in it, with data from the sheet in that address. It is shown here in full:`
    : pv`This chat has read content from outside lynox, such as a web page, an email or a file. ${n} of these requests can write cell content or a rule, which can hold a formula, and Google runs a formula on its side. A formula can make Google fetch an address named in it, with data from the sheet in that address. They are shown here in full:`;
  const shownLines = lines.map((l) => (l.type === null ? pv`request: ${l.body}` : pv`${l.type}: ${l.body}`));
  const rest = requests.length - n;
  const more = rest === 0 ? [] : [rest === 1 ? pv`and 1 formatting request that writes no cell content` : pv`and ${rest} formatting requests that write no cell content`];
  return { note: joinPrompts([head, ...shownLines, ...more], '\n') };
}

// === Tool Creation ===

// Actions flagged destructive to the permission guard. `format` is included
// because handleFormat forwards raw :batchUpdate requests that can delete/
// overwrite cells + sheets (see CONFIRM_ACTIONS). `create` only makes a new
// spreadsheet (no existing data at risk) → left out. Do not silently expand
// this set: changing it changes user-visible permission prompts.
const SHEETS_WRITE_ACTIONS = new Set<SheetsInput['action']>(['write', 'append', 'format']);
// What a call writes at Google, which is wider than what the guard asks about: `create`
// makes a new spreadsheet in the account. Read by the actor trail, not the guard.
const SHEETS_OUTWARD_ACTIONS = new Set<string>([...SHEETS_WRITE_ACTIONS, 'create']);

export function createSheetsTool(getAuth: () => GoogleAuth | null): ToolEntry<SheetsInput> {
  return {
    outwardWrite: (input) => (SHEETS_OUTWARD_ACTIONS.has(input.action) ? input.action : null),
    outwardRead: (input) => {
      if (input.action === 'read') return `read ${namedTarget([['spreadsheet', input.spreadsheet_id === undefined ? undefined : withoutAddresses(input.spreadsheet_id)], ['range', input.range === undefined ? undefined : withoutAddresses(input.range)]])}`.trimEnd();
      if (input.action === 'list') return 'list';
      return null;
    },
    destructive: {
      mode: 'external',
      check: (input) => {
        const action = (input as { action?: unknown } | null)?.action;
        return typeof action === 'string' && (SHEETS_WRITE_ACTIONS as Set<string>).has(action) ? action : null;
      },
    },
    definition: {
      name: 'google_sheets',
      description: 'Interact with Google Sheets: read data as markdown table, write/overwrite ranges (requires confirmation), append rows, create new spreadsheets, list spreadsheets, apply formatting. Use action "read" with spreadsheet_id and range (A1 notation), "write" to overwrite a range with values, "append" to add rows after existing data, "create" with title and optional sheet_names, "list" to find spreadsheets, "format" with batchUpdate requests.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'append', 'create', 'list', 'format'],
            description: 'Sheets action to perform',
          },
          spreadsheet_id: {
            type: 'string',
            description: 'Spreadsheet ID (from URL). Required for: read, write, append, format',
          },
          range: {
            type: 'string',
            description: 'Cell range in A1 notation, e.g. "Sheet1!A1:D10" or "A1:Z". Required for: read, write, append',
          },
          values: {
            type: 'array',
            items: { type: 'array', items: {} },
            description: 'Array of row arrays. Required for: write, append. Example: [["Name","Age"],["Alice",30]]',
          },
          title: {
            type: 'string',
            description: 'Spreadsheet title (for action: create)',
          },
          sheet_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sheet tab names (for action: create). Default: ["Sheet1"]',
          },
          format_requests: {
            type: 'array',
            items: { type: 'object' },
            description: 'BatchUpdate requests for formatting (action: format). See Google Sheets API batchUpdate docs.',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: SheetsInput, agent: IAgent): Promise<string> => {
      // Registered from boot, connected or not — see google/index.ts.
      const auth = getAuth();
      if (!auth) return GOOGLE_NOT_CONNECTED;
      // The call as it is carried out: the owner may choose to write formula cells as text.
      let call = input;
      try {
        // `hasOwn`, not a truthiness check on the lookup: `input.action` is
        // typed but arrives from the model, so an unrecognised value is
        // reachable at runtime and must fall through to the unknown-action
        // error below rather than be silently admitted.
        if (Object.hasOwn(ACTION_SCOPES, input.action)) {
          const refusal = refuseUnlessScoped(auth, ACTION_SCOPES[input.action], ACTION_DESCRIPTIONS[input.action]);
          if (refusal) return refusal;
        }

        // Read as a list before anything is asked: the question shows the requests it covers.
        if (input.action === 'format' && input.format_requests !== undefined && !Array.isArray(input.format_requests)) {
          return 'Error: "format_requests" must be an array of batchUpdate requests.';
        }

        // Confirmation for destructive actions — fail-safe: block if no prompt available
        if (CONFIRM_ACTIONS.has(input.action) && !agent.promptUser) {
          return `Error: "${input.action}" requires user confirmation but no interactive prompt is available (autonomous/background mode). Use assistant mode for this action.`;
        }
        if (CONFIRM_ACTIONS.has(input.action) && agent.promptUser) {
          // `pv` splits frame from value, so the renderer can put the id and
          // the range in text nodes — see core/prompt-value.ts. They are no
          // longer collapsed on the way in, which means the prompt now shows
          // the value that is actually about to be used.
          // An append inserts its rows (`insertDataOption=INSERT_ROWS`), so it overwrites nothing
          // and is not asked about as if it did.
          const confirmMsg: PromptText = input.action === 'format'
            ? pv`Apply batch changes to spreadsheet ${input.spreadsheet_id ?? '(unknown)'}? Formatting requests can delete or overwrite cells and sheets.`
            : input.action === 'append'
              ? pv`Add rows to range "${input.range ?? '(unspecified)'}" in spreadsheet ${input.spreadsheet_id ?? '(unknown)'}? Nothing is overwritten.`
              : pv`Overwrite range "${input.range ?? '(unspecified)'}" in spreadsheet ${input.spreadsheet_id ?? '(unknown)'}? This will replace existing data.`;
          // After content from outside the chat, a cell that starts like a formula is shown with
          // the question: Google runs it on its side, where no check on the engine's requests
          // sees the address it may fetch. Before that, the question is the plain one above.
          const tainted = deriveTurnUntrusted(agent);
          const formulas = tainted ? formulasToShow(input) : [];
          // A format call is asked about as one batch: a request that can write cell content or a
          // rule is shown in full beside the question, and the answer covers every request in it.
          const requests = tainted && input.action === 'format' ? formatRequestsNote(input.format_requests ?? []) : null;
          if (requests !== null && 'refusal' in requests) return requests.refusal;
          if (formulas.length === 0) {
            const answer = await agent.promptUser(requests === null ? confirmMsg : joinPrompts([confirmMsg, requests.note], '\n\n'), ['Yes', 'No']);
            if (answer.toLowerCase() !== 'yes' && answer !== '1') {
              return 'Action cancelled by user.';
            }
          } else {
            const options = formulas.length > FORMULAS_SHOWN ? FORMULA_OPTIONS_SOME_HIDDEN : FORMULA_OPTIONS;
            const chosen = chosenOption(await agent.promptUser(joinPrompts([confirmMsg, formulaNote(formulas)], '\n\n'), options), options);
            if (chosen === WRITE_AS_TEXT) {
              call = { ...input, values: formulasAsText(input.values ?? []) };
            } else if (chosen !== WRITE_AS_FORMULAS) {
              return 'Action cancelled by user.';
            }
          }
        }

        switch (call.action) {
          case 'read': return await handleRead(auth, call);
          case 'write': return await handleWrite(auth, call);
          case 'append': return await handleAppend(auth, call);
          case 'create': return await handleCreate(auth, call);
          case 'list': return await handleList(auth);
          case 'format': return await handleFormat(auth, call);
          default: return `Error: Unknown action "${input.action}". Valid: read, write, append, create, list, format.`;
        }
      } catch (err: unknown) {
        // A confirmation nobody can answer ends the run; as text, the model would work around it.
        if (isInputRequired(err)) throw err;
        return `Sheets error: ${getErrorMessage(err)}`;
      }
    },
  };
}

// === Action Handlers ===

async function handleRead(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "read".';
  if (!input.range) return 'Error: "range" is required for action "read".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}/values/${encodeURIComponent(input.range)}`;
  const response = await sheetsFetch(auth, url, { signal: currentCallSignal() ?? null });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to read range (${response.status}): ${text}`;
  }

  const data = await response.json() as SheetValuesResponse;
  if (!data.values || data.values.length === 0) {
    return `Range "${data.range}" is empty.`;
  }

  const table = valuesToMarkdownTable(data.values);
  const rowCount = data.values.length - 1; // Subtract header
  const result = `**${data.range}** (${rowCount} data rows)\n\n${table}`;
  // Wrap as untrusted — cell values are attacker-controlled if spreadsheet is shared
  return wrapUntrustedData(result, 'google_sheets:read');
}

async function handleWrite(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "write".';
  if (!input.range) return 'Error: "range" is required for action "write".';
  if (!input.values || input.values.length === 0) return 'Error: "values" is required for action "write".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}/values/${encodeURIComponent(input.range)}?valueInputOption=USER_ENTERED`;
  const response = await sheetsFetch(auth, url, {
    method: 'PUT',
    body: JSON.stringify({
      range: input.range,
      majorDimension: 'ROWS',
      values: input.values,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to write data (${response.status}): ${text}`;
  }

  const result = await response.json() as { updatedRange: string; updatedRows: number; updatedColumns: number; updatedCells: number };
  return `Data written successfully.\nRange: ${result.updatedRange}\nRows: ${result.updatedRows}, Columns: ${result.updatedColumns}, Cells: ${result.updatedCells}`;
}

async function handleAppend(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "append".';
  if (!input.range) return 'Error: "range" is required for action "append".';
  if (!input.values || input.values.length === 0) return 'Error: "values" is required for action "append".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}/values/${encodeURIComponent(input.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await sheetsFetch(auth, url, {
    method: 'POST',
    body: JSON.stringify({
      range: input.range,
      majorDimension: 'ROWS',
      values: input.values,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to append data (${response.status}): ${text}`;
  }

  const result = await response.json() as { updates: { updatedRange: string; updatedRows: number; updatedCells: number } };
  return `Data appended successfully.\nRange: ${result.updates.updatedRange}\nRows added: ${result.updates.updatedRows}`;
}

async function handleCreate(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  const title = input.title ?? 'New Spreadsheet';
  const sheetNames = input.sheet_names ?? ['Sheet1'];

  const response = await sheetsFetch(auth, SHEETS_BASE, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: sheetNames.map(name => ({
        properties: { title: name },
      })),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to create spreadsheet (${response.status}): ${text}`;
  }

  const result = await response.json() as SpreadsheetResponse;
  return `Spreadsheet created.\nTitle: ${result.properties.title}\nID: ${result.spreadsheetId}\nURL: ${result.spreadsheetUrl}`;
}

async function handleList(auth: GoogleAuth): Promise<string> {
  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet'",
    fields: 'files(id,name,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '20',
  });

  const response = await sheetsFetch(auth, `${DRIVE_FILES_BASE}?${params}`, { signal: currentCallSignal() ?? null });
  if (!response.ok) {
    return `Error: Failed to list spreadsheets (${response.status}).`;
  }

  const data = await response.json() as DriveFileListResponse;
  if (!data.files || data.files.length === 0) {
    return 'No spreadsheets found.';
  }

  const lines = data.files.map(f =>
    `- **${f.name}**\n  ID: ${f.id}\n  Modified: ${f.modifiedTime.slice(0, 10)}\n  URL: ${f.webViewLink}`
  );

  return `Spreadsheets (${data.files.length}):\n\n${lines.join('\n\n')}`;
}

async function handleFormat(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "format".';
  if (!input.format_requests || input.format_requests.length === 0) return 'Error: "format_requests" is required for action "format".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}:batchUpdate`;
  const response = await sheetsFetch(auth, url, {
    method: 'POST',
    body: JSON.stringify({ requests: input.format_requests }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to apply formatting (${response.status}): ${text}`;
  }

  const result = await response.json() as { replies: unknown[] };
  return `Formatting applied. ${result.replies.length} operations completed.`;
}
