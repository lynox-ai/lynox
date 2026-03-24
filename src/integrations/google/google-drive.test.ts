import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDriveTool } from './google-drive.js';
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

describe('google_drive tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('search', () => {
    it('searches files and returns results', async () => {
      const auth = createMockAuth();
      const tool = createDriveTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [
            { id: 'file1', name: 'Report.pdf', mimeType: 'application/pdf', modifiedTime: '2026-03-15T10:00:00Z', size: '1048576', webViewLink: 'https://drive.google.com/...' },
          ],
        }),
      });

      const result = await tool.handler({ action: 'search', query: 'name contains "Report"' }, createMockAgent());

      expect(result).toContain('Report.pdf');
      expect(result).toContain('file1');
      expect(result).toContain('1.0 MB');
    });

    it('requires query parameter', async () => {
      const auth = createMockAuth();
      const tool = createDriveTool(auth);
      const result = await tool.handler({ action: 'search' }, createMockAgent());
      expect(result).toContain('Error: "query" is required');
    });
  });

  describe('read', () => {
    it('exports Google Docs as text', async () => {
      const auth = createMockAuth();
      const tool = createDriveTool(auth);

      // Metadata
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'doc1',
          name: 'My Document',
          mimeType: 'application/vnd.google-apps.document',
        }),
      });
      // Export
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => 'This is the document content.',
      });

      const result = await tool.handler({ action: 'read', file_id: 'doc1' }, createMockAgent());

      expect(result).toContain('My Document');
      expect(result).toContain('This is the document content.');
    });

    it('downloads text files directly', async () => {
      const auth = createMockAuth();
      const tool = createDriveTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'file1',
          name: 'data.csv',
          mimeType: 'text/csv',
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/csv']]),
        text: async () => 'name,age\nAlice,30',
      });

      const result = await tool.handler({ action: 'read', file_id: 'file1' }, createMockAgent());

      expect(result).toContain('data.csv');
      expect(result).toContain('name,age');
    });
  });

  describe('upload', () => {
    it('requires drive.file scope', async () => {
      const auth = createMockAuth([]);
      const tool = createDriveTool(auth);

      const result = await tool.handler({
        action: 'upload',
        file_name: 'test.txt',
        content: 'Hello',
      }, createMockAgent('Yes'));

      expect(result).toContain('requires drive.file scope');
    });

    it('uploads file with confirmation', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/drive.file']);
      const tool = createDriveTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'uploaded1',
          name: 'test.txt',
          mimeType: 'text/plain',
        }),
      });

      const result = await tool.handler({
        action: 'upload',
        file_name: 'test.txt',
        content: 'Hello World',
      }, createMockAgent('Yes'));

      expect(result).toContain('File uploaded');
      expect(result).toContain('uploaded1');
    });
  });

  describe('list', () => {
    it('lists folder contents', async () => {
      const auth = createMockAuth();
      const tool = createDriveTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [
            { id: 'folder1', name: 'Documents', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-03-15T10:00:00Z' },
            { id: 'file1', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '2026-03-14T10:00:00Z', size: '1024' },
          ],
        }),
      });

      const result = await tool.handler({ action: 'list' }, createMockAgent());

      expect(result).toContain('[Folder]');
      expect(result).toContain('Documents');
      expect(result).toContain('notes.txt');
    });
  });

  describe('share', () => {
    it('requires full Drive scope', async () => {
      const auth = createMockAuth([]);
      const tool = createDriveTool(auth);

      const result = await tool.handler({
        action: 'share',
        file_id: 'file1',
        email: 'user@example.com',
      }, createMockAgent('Yes'));

      expect(result).toContain('requires full Drive scope');
    });
  });

  describe('tool definition', () => {
    it('has correct name and schema', () => {
      const auth = createMockAuth();
      const tool = createDriveTool(auth);

      expect(tool.definition.name).toBe('google_drive');
      expect(tool.definition.input_schema.required).toEqual(['action']);
    });
  });
});
