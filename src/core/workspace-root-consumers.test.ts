import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRoot } from './workspace-root.js';

/**
 * The places that used to build `<data>/workspace` themselves (P18 D3) and the translation of the
 * old path (D7) go through the root. With the default root the two spellings are the same string,
 * so this hands them a root that is NOT `<data>/workspace` — the state this engine still refuses
 * at boot, reached here by replacing the root's resolver — and looks where they land.
 */
let root: WorkspaceRoot;
vi.mock('./workspace-root.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./workspace-root.js')>();
  return { ...real, resolveWorkspaceRoot: () => root, getWorkspaceRoot: () => root.path };
});

const { resolveContext } = await import('./context.js');
const { getFileAreaDir, resolveFileAreaPath, validatePath, setTenantWorkspace, clearTenantWorkspace, _resetCache } = await import('./workspace.js');
const { writeFileTool } = await import('../tools/builtin/fs.js');

describe('consumers of the workspace root (D3, D7)', () => {
  let tmp: string;
  let data: string;
  let legacy: string;
  let volume: string;
  let prevData: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ws-consumers-')));
    data = join(tmp, 'data');
    legacy = join(data, 'workspace');
    volume = join(tmp, 'volume');
    mkdirSync(data);
    mkdirSync(volume);
    prevData = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = data;
    root = { path: volume, mode: 'external' };
    _resetCache();
  });

  afterEach(() => {
    if (prevData === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prevData;
    clearTenantWorkspace();
    _resetCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the context directory is under the root, for the server and the CLI', () => {
    const server = resolveContext({ context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' } } as never);
    expect(server.workspaceDir).toBe(join(volume, 'http-api'));
    expect(resolveContext({} as never).workspaceDir.startsWith(volume + '/')).toBe(true);
  });

  it('the file area falls back to the root', () => {
    expect(getFileAreaDir()).toBe(volume);
  });

  it('write_file without isolation writes under the root', async () => {
    await writeFileTool.handler({ path: 'note.txt', content: 'x' }, { sessionCounters: { httpRequests: 0, writeBytes: 0 } } as never);
    expect(readFileSync(join(volume, 'note.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(legacy, 'note.txt'))).toBe(false);
  });

  // `validatePath` also admits /tmp, where these temp dirs live, so a check of the confinement
  // needs a root outside /tmp. It is never created: the resolver walks up to `/` and re-attaches
  // the rest, so nothing is written there.
  const OUTSIDE_TMP = '/lynox-test-volume-never-created';

  it('an old path is translated before it is confined, in both resolvers', () => {
    const ws = join(volume, 'http-api');
    mkdirSync(ws);
    writeFileSync(join(ws, 'a.txt'), 'x');
    setTenantWorkspace(ws);
    expect(validatePath(join(legacy, 'http-api', 'a.txt'), 'read')).toBe(join(ws, 'a.txt'));
    expect(resolveFileAreaPath(join(legacy, 'http-api', 'a.txt'))).toBe(join(ws, 'a.txt'));
  });

  it('a translated path is still confined: the old prefix does not widen the area (I4)', () => {
    root = { path: OUTSIDE_TMP, mode: 'external' };
    setTenantWorkspace(join(OUTSIDE_TMP, 'http-api'));
    // Inside the context directory once translated: admitted (the twin of the refusals below).
    expect(validatePath(join(legacy, 'http-api', 'a.txt'), 'read')).toBe(join(OUTSIDE_TMP, 'http-api', 'a.txt'));
    // Under the old prefix but outside the context directory once translated: refused.
    expect(() => validatePath(join(legacy, 'other-context', 'b.txt'), 'read')).toThrow(/outside allowed directories/);
    expect(resolveFileAreaPath(join(legacy, 'other-context', 'b.txt'))).toBeNull();
    expect(resolveFileAreaPath(join(legacy, 'http-api', 'a.txt'))).toBe(join(OUTSIDE_TMP, 'http-api', 'a.txt'));
  });

  it('refuses an old path while files are left in the old place', () => {
    const ws = join(volume, 'http-api');
    mkdirSync(ws);
    setTenantWorkspace(ws);
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'left.txt'), 'x');
    expect(() => validatePath(join(legacy, 'http-api', 'a.txt'), 'read')).toThrow(/still holds files/);
  });
});
