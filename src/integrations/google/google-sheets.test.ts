import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSheetsTool } from './google-sheets.js';
import type { IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockAuth(scopes: string[] = []): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockImplementation((s: string) => scopes.includes(s)),
  } as unknown as GoogleAuth;
}

function createMockAgent(promptAnswer?: string): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    promptUser: promptAnswer !== undefined
      ? vi.fn().mockResolvedValue(promptAnswer)
      : undefined,
  } as unknown as IAgent;
}

describe('google_sheets tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('read', () => {
    it('reads range and returns markdown table', async () => {
      const auth = createMockAuth();
      const tool = createSheetsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          range: 'Sheet1!A1:C3',
          majorDimension: 'ROWS',
          values: [
            ['Name', 'Age', 'City'],
            ['Alice', '30', 'Berlin'],
            ['Bob', '25', 'Munich'],
          ],
        }),
      });

      const result = await tool.handler({
        action: 'read',
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1:C3',
      }, createMockAgent());

      expect(result).toContain('Sheet1!A1:C3');
      expect(result).toContain('Name');
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
      expect(result).toContain('|');
      expect(result).toContain('---');
    });

    it('handles empty range', async () => {
      const auth = createMockAuth();
      const tool = createSheetsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          range: 'Sheet1!A1:A1',
          majorDimension: 'ROWS',
          values: [],
        }),
      });

      const result = await tool.handler({
        action: 'read',
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1:A1',
      }, createMockAgent());

      expect(result).toContain('empty');
    });

    it('requires spreadsheet_id and range', async () => {
      const auth = createMockAuth();
      const tool = createSheetsTool(auth);

      let result = await tool.handler({ action: 'read' }, createMockAgent());
      expect(result).toContain('spreadsheet_id');

      result = await tool.handler({ action: 'read', spreadsheet_id: 'id' }, createMockAgent());
      expect(result).toContain('range');
    });
  });

  describe('write', () => {
    it('requires write scope', async () => {
      const auth = createMockAuth([]); // No write scope
      const tool = createSheetsTool(auth);

      const result = await tool.handler({
        action: 'write',
        spreadsheet_id: 'test-id',
        range: 'A1:B2',
        values: [['a', 'b']],
      }, createMockAgent('Yes'));

      expect(result).toContain('requires write permissions');
    });

    it('writes data with confirmation', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/spreadsheets']);
      const tool = createSheetsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          updatedRange: 'Sheet1!A1:B2',
          updatedRows: 2,
          updatedColumns: 2,
          updatedCells: 4,
        }),
      });

      const result = await tool.handler({
        action: 'write',
        spreadsheet_id: 'test-id',
        range: 'A1:B2',
        values: [['Name', 'Score'], ['Alice', '100']],
      }, createMockAgent('Yes'));

      expect(result).toContain('Data written successfully');
      expect(result).toContain('Cells: 4');
    });

    it('cancels on user decline', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/spreadsheets']);
      const tool = createSheetsTool(auth);

      const result = await tool.handler({
        action: 'write',
        spreadsheet_id: 'id',
        range: 'A1',
        values: [['x']],
      }, createMockAgent('No'));

      expect(result).toBe('Action cancelled by user.');
    });
  });

  describe('append', () => {
    it('appends rows with confirmation', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/spreadsheets']);
      const tool = createSheetsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          updates: {
            updatedRange: 'Sheet1!A4:B4',
            updatedRows: 1,
            updatedCells: 2,
          },
        }),
      });

      const result = await tool.handler({
        action: 'append',
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A:B',
        values: [['Charlie', '35']],
      }, createMockAgent('Yes'));

      expect(result).toContain('Data appended');
      expect(result).toContain('Rows added: 1');
    });
  });

  describe('create', () => {
    it('creates new spreadsheet', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/spreadsheets']);
      const tool = createSheetsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          spreadsheetId: 'new-id',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-id',
          properties: { title: 'Test Sheet' },
        }),
      });

      const result = await tool.handler({
        action: 'create',
        title: 'Test Sheet',
        sheet_names: ['Data', 'Summary'],
      }, createMockAgent());

      expect(result).toContain('Spreadsheet created');
      expect(result).toContain('Test Sheet');
      expect(result).toContain('new-id');
    });
  });

  describe('list', () => {
    it('lists spreadsheets from Drive', async () => {
      const auth = createMockAuth();
      const tool = createSheetsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [
            { id: 'sheet1', name: 'Budget 2026', modifiedTime: '2026-03-15T10:00:00Z', webViewLink: 'https://docs.google.com/...' },
          ],
        }),
      });

      const result = await tool.handler({ action: 'list' }, createMockAgent());

      expect(result).toContain('Budget 2026');
      expect(result).toContain('sheet1');
    });
  });

  describe('tool definition', () => {
    it('has correct name and schema', () => {
      const auth = createMockAuth();
      const tool = createSheetsTool(auth);

      expect(tool.definition.name).toBe('google_sheets');
      expect(tool.definition.input_schema.required).toEqual(['action']);
    });
  });
});
