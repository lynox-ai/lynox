import { describe, it, expect } from 'vitest';
import { formatToolCallPreview } from './tool-call-preview.js';

describe('formatToolCallPreview (H-024 shadow mode)', () => {
  describe('read_file / write_file', () => {
    it('returns the path only for read_file', () => {
      const preview = formatToolCallPreview('read_file', { path: '/Users/foo/.env' });
      expect(preview).toBe('/Users/foo/.env');
    });

    it('returns the path only for write_file (NEVER the content)', () => {
      const preview = formatToolCallPreview('write_file', {
        path: '/tmp/out.txt',
        content: 'sk-secret-abcdef0123456789',
      });
      expect(preview).toBe('/tmp/out.txt');
      expect(preview).not.toContain('sk-secret');
    });

    it('truncates oversized paths to 80 chars', () => {
      const longPath = '/Users/' + 'a'.repeat(200) + '/.env';
      const preview = formatToolCallPreview('read_file', { path: longPath });
      expect(preview.length).toBeLessThanOrEqual(80);
    });
  });

  describe('http_request — secret safety', () => {
    it('returns "METHOD URL" with URL but NEVER the body', () => {
      const preview = formatToolCallPreview('http_request', {
        method: 'POST',
        url: 'https://api.example.com',
        body: '{"api_key": "sk-secret-12345"}',
      });
      expect(preview).toContain('POST');
      expect(preview).toContain('https://api.example.com');
      expect(preview).not.toContain('sk-secret-12345');
      expect(preview).not.toContain('api_key');
    });

    it('parseable via split(" ")[1] to extract the URL (contract with ToolCallTracker)', () => {
      const preview = formatToolCallPreview('http_request', {
        method: 'GET',
        url: 'https://api.frankfurter.app/latest',
      });
      const url = preview.split(' ')[1];
      expect(url).toBe('https://api.frankfurter.app/latest');
    });

    it('defaults method to GET when missing', () => {
      const preview = formatToolCallPreview('http_request', { url: 'https://example.com' });
      expect(preview).toBe('GET https://example.com');
    });
  });

  describe('google_* — action:resource shape', () => {
    it('returns "<action>:<resource>" for google_gmail', () => {
      const preview = formatToolCallPreview('google_gmail', {
        action: 'send',
        threadId: 'abc123',
      });
      expect(preview).toBe('send:abc123');
    });

    it('parseable via split(":")[0] to extract action (contract with ToolCallTracker)', () => {
      const preview = formatToolCallPreview('google_drive', { action: 'read', id: 'file_id' });
      const action = preview.split(':')[0];
      expect(action).toBe('read');
    });
  });

  describe('memory_store — secret safety', () => {
    it('does NOT leak the value field', () => {
      const preview = formatToolCallPreview('memory_store', {
        entity: 'X',
        property: 'Y',
        value: 'secret-data-here',
      });
      expect(preview).not.toContain('secret-data-here');
      // entity + property should be visible (they're metadata, not secrets)
      expect(preview).toContain('"entity":"X"');
      expect(preview).toContain('"property":"Y"');
    });

    it('strips other common secret-bearing field names', () => {
      const preview = formatToolCallPreview('some_tool', {
        apiKey: 'sk-xxx',
        api_key: 'sk-yyy',
        token: 'tok-zzz',
        password: 'p1',
        secret: 's1',
        authorization: 'Bearer abc',
        keep: 'visible',
      });
      expect(preview).not.toContain('sk-xxx');
      expect(preview).not.toContain('sk-yyy');
      expect(preview).not.toContain('tok-zzz');
      expect(preview).not.toContain('Bearer');
      expect(preview).toContain('keep');
    });
  });

  describe('catch-all / edge cases', () => {
    it('truncates JSON output to 80 chars', () => {
      const huge = { data: 'x'.repeat(500) };
      const preview = formatToolCallPreview('unknown_tool', huge);
      expect(preview.length).toBeLessThanOrEqual(80);
    });

    it('returns empty string for null / undefined input', () => {
      expect(formatToolCallPreview('any', null)).toBe('');
      expect(formatToolCallPreview('any', undefined)).toBe('');
    });

    it('handles primitive input', () => {
      expect(formatToolCallPreview('any', 'hello')).toBe('"hello"');
      expect(formatToolCallPreview('any', 42)).toBe('42');
    });

    it('does not throw on circular references', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(() => formatToolCallPreview('unknown_tool', circular)).not.toThrow();
    });
  });
});
