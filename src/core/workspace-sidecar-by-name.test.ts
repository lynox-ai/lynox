import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In shell sidecar mode nothing below `/workspace` is reached by name (PRD shell-sidecar-activation
 * D3): not written, and not looked up either. The image may hold a `/workspace` of its own, so a
 * lookup by name can answer, and a key or a check built on that answer is about another directory.
 * This records every `node:fs` call whose path argument names `/workspace` or a path below it,
 * while the workspace operations run in sidecar mode, and expects none. It does not depend on the
 * test machine: a call is caught whether or not the path exists here.
 */
const touched: string[] = [];
const LABEL = '/workspace';
const namesLabel = (a: unknown): boolean =>
  typeof a === 'string' && (a === LABEL || a.startsWith(`${LABEL}/`));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    wrapped[name] = typeof value === 'function' && /^[a-z]/.test(name)
      ? (...args: unknown[]) => {
        if (args.some(namesLabel)) touched.push(`${name}(${String(args.find(namesLabel))})`);
        return (value as (...a: unknown[]) => unknown)(...args);
      }
      : value;
  }
  return { ...wrapped, default: wrapped };
});

const { constants, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL } = await import('./shell-isolation.js');
const { anchorFromFd, closeAnchor } = await import('./workspace-fd.js');
const { ensureWorkspaceRoot, resolveWorkspaceRoot, translateLegacyWorkspacePath, workspaceLegacyPending, workspaceRootIsMount } = await import('./workspace-root.js');
const { _resetWorkspaceAccess, workspaceAccess } = await import('./workspace-access.js');
const { closeWorkspaceBase, toWorkspaceRel, workspaceBase } = await import('./workspace-rel.js');
const { _resetCache, setTenantWorkspace, validatePath } = await import('./workspace.js');
const { workspaceChangeset } = await import('./changeset.js');
const { bulkFileKey } = await import('./bulk-plan.js');
const { readFileTool, writeFileTool, editFileTool } = await import('../tools/builtin/fs.js');
const { isDangerous } = await import('../tools/permission-guard.js');
const { diffPreviewText } = await import('./agent.js');
const { batchFilesTool } = await import('../tools/builtin/batch-files.js');

describe('in shell sidecar mode nothing below /workspace is reached by name (D3)', () => {
  let tmp: string;
  let tree: string;
  let anchor: ReturnType<typeof anchorFromFd>;
  let prevData: string | undefined;
  const agent = { sessionCounters: { httpRequests: 0, writeBytes: 0 } } as never;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ws-byname-')));
    tree = join(tmp, 'tree');
    mkdirSync(join(tree, 'ctx1'), { recursive: true });
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tree, 'ctx1', 'a.txt'), 'v1\n');
    prevData = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = join(tmp, 'data');
    anchor = anchorFromFd(openSync(tree, constants.O_RDONLY | constants.O_DIRECTORY), WORKSPACE_LABEL);
    setShellIsolationForTest({ kind: 'sidecar', socket: join(tmp, 'exec.sock'), root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } });
    _resetCache();
    setTenantWorkspace(`${WORKSPACE_LABEL}/ctx1`);
    touched.length = 0;
  });

  afterEach(() => {
    closeWorkspaceBase();
    _resetWorkspaceAccess();
    _resetCache();
    resetShellIsolationForTest();
    closeAnchor(anchor);
    if (prevData === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prevData;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the root, its access, the context workspace and the old-path mapping', () => {
    ensureWorkspaceRoot();
    const root = resolveWorkspaceRoot();
    workspaceAccess();
    workspaceBase();
    workspaceLegacyPending(root);
    translateLegacyWorkspacePath(join(tmp, 'data', 'workspace', 'ctx1', 'a.txt'), root);
    workspaceRootIsMount(root.path);
    toWorkspaceRel(`${WORKSPACE_LABEL}/ctx1/a.txt`, `${WORKSPACE_LABEL}/ctx1`);
    expect(touched.join(' ; ')).toBe('');
  });

  it('the file tools read, write and edit a workspace file', async () => {
    await writeFileTool.handler({ path: `${WORKSPACE_LABEL}/ctx1/b.txt`, content: 'b\n' }, agent);
    await readFileTool.handler({ path: `${WORKSPACE_LABEL}/ctx1/b.txt` }, agent);
    await editFileTool.handler({ path: `${WORKSPACE_LABEL}/ctx1/b.txt`, old_string: 'b', new_string: 'c' }, agent);
    expect(readFileSync(join(tree, 'ctx1', 'b.txt'), 'utf8')).toBe('c\n');
    // The preview of a write reads the file through fd 3 as well.
    expect(diffPreviewText(`${WORKSPACE_LABEL}/ctx1/b.txt`)).toBe('c\n');
    // A path outside the workspace is still checked against it, by the label's spelling.
    await writeFileTool.handler({ path: join(tmp, 'outside.txt'), content: 'o' }, agent);
    expect(touched.join(' ; ')).toBe('');
  });

  it('batch_files in a directory outside the workspace checks it against the label by its spelling', async () => {
    const outside = join(tmp, 'outside-dir');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.txt'), 'old');
    await batchFilesTool.handler({ pattern: '*.txt', directory: outside, operation: 'transform', find: 'old', replace: 'new' }, agent);
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('new');
    expect(touched.join(' ; ')).toBe('');
  });

  it('the permission guard judges a workspace path', () => {
    isDangerous('read_file', { path: `${WORKSPACE_LABEL}/ctx1/a.txt` }, 'autonomous');
    isDangerous('write_file', { path: `${WORKSPACE_LABEL}/ctx1/a.txt`, content: 'x' }, 'autonomous');
    isDangerous('bash', { command: 'cat a.txt' }, 'autonomous');
    expect(touched.join(' ; ')).toBe('');
  });

  it('a run\'s changeset saves, shows and rolls back a workspace file', () => {
    const cs = workspaceChangeset('run-1');
    try {
      const shown = `${WORKSPACE_LABEL}/ctx1/a.txt`;
      expect(cs.backupBeforeWrite(shown)).toBe(true);
      writeFileSync(join(tree, 'ctx1', 'a.txt'), 'v2\n');
      cs.recordWritten(shown);
      expect(cs.getChanges().map(c => c.file)).toEqual(['a.txt']);
      expect(cs.rollbackAll()).toEqual([]);
    } finally {
      cs.cleanup();
    }
    expect(touched.join(' ; ')).toBe('');
  });

  it('a bulk run keys a workspace file', () => {
    bulkFileKey('rows.csv');
    expect(touched.join(' ; ')).toBe('');
  });

  it('a path below the label is refused by the by-name check, and without a context everything is', () => {
    expect(() => validatePath(`${WORKSPACE_LABEL}/ctx1/a.txt`, 'read')).toThrow(/through its open directory/);
    setTenantWorkspace(null);
    expect(() => validatePath(join(tmp, 'x.txt'), 'write')).toThrow(/no context workspace is set/);
    expect(touched.join(' ; ')).toBe('');
  });
});
