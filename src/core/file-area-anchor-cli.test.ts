import { describe, expect, it, vi } from 'vitest';

/** Without isolation the chat upload keeps its old path, by name in the file area. */
const h = vi.hoisted(() => ({ calls: [] as Array<[string, string]> }));

vi.mock('./workspace.js', async () => {
  const actual = await vi.importActual<typeof import('./workspace.js')>('./workspace.js');
  return {
    ...actual,
    persistChatUpload: (name: string, text: string) => {
      h.calls.push([name, text]);
      return { rel: 'uploads/old-path', abs: '/old-path' };
    },
  };
});

const { persistChatUploadInArea } = await import('./file-area-anchor.js');
const { clearTenantWorkspace } = await import('./workspace.js');

describe('persistChatUploadInArea without isolation', () => {
  it('hands the upload to the old path', () => {
    clearTenantWorkspace();
    expect(process.env['LYNOX_WORKSPACE']).toBeUndefined();
    expect(persistChatUploadInArea('c.txt', 'cli')).toEqual({ rel: 'uploads/old-path', abs: '/old-path' });
    expect(h.calls).toEqual([['c.txt', 'cli']]);
  });
});
