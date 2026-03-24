import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDocsTool } from './google-docs.js';
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

describe('google_docs tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('read', () => {
    it('reads document and converts to markdown', async () => {
      const auth = createMockAuth();
      const tool = createDocsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentId: 'doc1',
          title: 'My Document',
          body: {
            content: [
              {
                startIndex: 0,
                endIndex: 1,
                sectionBreak: {},
              },
              {
                startIndex: 1,
                endIndex: 14,
                paragraph: {
                  elements: [{
                    startIndex: 1,
                    endIndex: 14,
                    textRun: { content: 'Hello World\n' },
                  }],
                  paragraphStyle: { namedStyleType: 'HEADING_1' },
                },
              },
              {
                startIndex: 14,
                endIndex: 30,
                paragraph: {
                  elements: [{
                    startIndex: 14,
                    endIndex: 30,
                    textRun: { content: 'Some content\n' },
                  }],
                  paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
                },
              },
            ],
          },
        }),
      });

      const result = await tool.handler({ action: 'read', document_id: 'doc1' }, createMockAgent());

      expect(result).toContain('My Document');
      expect(result).toContain('# Hello World');
      expect(result).toContain('Some content');
    });

    it('requires document_id', async () => {
      const auth = createMockAuth();
      const tool = createDocsTool(auth);
      const result = await tool.handler({ action: 'read' }, createMockAgent());
      expect(result).toContain('"document_id" is required');
    });
  });

  describe('create', () => {
    it('requires write scope', async () => {
      const auth = createMockAuth([]);
      const tool = createDocsTool(auth);

      const result = await tool.handler({
        action: 'create',
        title: 'Test',
        content: 'Hello',
      }, createMockAgent('Yes'));

      expect(result).toContain('requires document write permissions');
    });

    it('creates document via Drive HTML upload', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/documents']);
      const tool = createDocsTool(auth);

      // Drive multipart upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'new-doc', name: 'Test Document' }),
      });

      const result = await tool.handler({
        action: 'create',
        title: 'Test Document',
        content: '# Heading\n\nSome text',
      }, createMockAgent('Yes'));

      expect(result).toContain('Document created');
      expect(result).toContain('new-doc');
      expect(result).toContain('https://docs.google.com/document/d/new-doc/edit');

      // Verify Drive upload was called with multipart/related
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('upload/drive/v3/files'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('append', () => {
    it('appends text to existing document', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/documents']);
      const tool = createDocsTool(auth);

      // Read doc for end index
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentId: 'doc1',
          title: 'Existing Doc',
          body: {
            content: [{
              startIndex: 0,
              endIndex: 50,
              paragraph: {
                elements: [{ startIndex: 0, endIndex: 50, textRun: { content: 'Existing content\n' } }],
              },
            }],
          },
        }),
      });
      // batchUpdate
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ documentId: 'doc1', replies: [] }),
      });

      const result = await tool.handler({
        action: 'append',
        document_id: 'doc1',
        content: 'New appended text',
      }, createMockAgent());

      expect(result).toContain('Content appended');
      expect(result).toContain('Existing Doc');
    });
  });

  describe('replace', () => {
    it('replaces text with confirmation', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/documents']);
      const tool = createDocsTool(auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentId: 'doc1',
          replies: [{}],
        }),
      });

      const result = await tool.handler({
        action: 'replace',
        document_id: 'doc1',
        find: 'old text',
        replace_with: 'new text',
      }, createMockAgent('Yes'));

      expect(result).toContain('Text replaced');
    });

    it('requires find and replace_with', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/documents']);
      const tool = createDocsTool(auth);

      let result = await tool.handler({
        action: 'replace',
        document_id: 'doc1',
      }, createMockAgent('Yes'));
      expect(result).toContain('"find" is required');

      result = await tool.handler({
        action: 'replace',
        document_id: 'doc1',
        find: 'something',
      }, createMockAgent('Yes'));
      expect(result).toContain('"replace_with" is required');
    });
  });

  describe('tool definition', () => {
    it('has correct name and schema', () => {
      const auth = createMockAuth();
      const tool = createDocsTool(auth);

      expect(tool.definition.name).toBe('google_docs');
      expect(tool.definition.input_schema.required).toEqual(['action']);
    });
  });
});
