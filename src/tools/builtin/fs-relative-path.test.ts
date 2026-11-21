import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileTool, writeFileTool, editFileTool, resolveWritablePath } from './fs.js';
import { batchFilesTool } from './batch-files.js';
import { setTenantWorkspace, clearTenantWorkspace, validatePath, resolveToolPath } from '../../core/workspace.js';
import { closeWorkspaceBase, toWorkspaceRel } from '../../core/workspace-rel.js';
import type { IAgent, SessionCounters } from '../../types/index.js';
import { isDangerous } from '../permission-guard.js';

function agent(): IAgent {
  const sessionCounters = { writeBytes: 0, httpRequests: 0 } as unknown as SessionCounters;
  return { sessionCounters } as unknown as IAgent;
}

let ws: string;
let cwd: string;

// The image runs with its WORKDIR as the process cwd, outside the workspace. Here the cwd is a
// directory of its own under /tmp — an allowed write root — so a relative path resolved against
// the cwd would land there and succeed, and the tests see which of the two it reached.
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-rel-ws-')));
  cwd = realpathSync(mkdtempSync('/tmp/lynox-rel-cwd-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  setTenantWorkspace(ws);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('with isolation, a relative path in the file tools is read from the workspace', () => {
  it('write_file with a relative path writes the file in the workspace, not in the process cwd', async () => {
    await writeFileTool.handler({ path: 'bulkwalk/prices.csv', content: 'sku,price\n' }, agent());
    expect(readFileSync(join(ws, 'bulkwalk', 'prices.csv'), 'utf8')).toBe('sku,price\n');
    expect(existsSync(join(cwd, 'bulkwalk'))).toBe(false);
  });

  it('read_file with a relative path reads the workspace file, not a same-named file in the cwd', async () => {
    writeFileSync(join(ws, 'notes.txt'), 'from the workspace');
    writeFileSync(join(cwd, 'notes.txt'), 'from the cwd');
    const out = await readFileTool.handler({ path: 'notes.txt' });
    expect(out).toContain('from the workspace');
    expect(out).not.toContain('from the cwd');
  });

  it('edit_file with a relative path changes the workspace file and leaves the cwd one alone', async () => {
    writeFileSync(join(ws, 'a.txt'), 'old');
    writeFileSync(join(cwd, 'a.txt'), 'old');
    await editFileTool.handler({ path: 'a.txt', old_string: 'old', new_string: 'new' }, agent());
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('old');
  });

  it('batch_files with a relative directory and destination moves inside the workspace', async () => {
    mkdirSync(join(ws, 'in'));
    writeFileSync(join(ws, 'in', 'x.txt'), 'x');
    await batchFilesTool.handler({ operation: 'move', directory: 'in', pattern: '*.txt', destination: 'out' }, agent());
    expect(readFileSync(join(ws, 'out', 'x.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(cwd, 'out'))).toBe(false);
  });

  it('a relative path that climbs out of the workspace is still refused for a write', async () => {
    // ws lives under os.tmpdir(); climbing past it to the filesystem root and into /etc leaves
    // every allowed root, so the write is refused and nothing is written.
    const climb = `${'../'.repeat(ws.split('/').length)}etc/lynox-rel-probe`;
    await expect(writeFileTool.handler({ path: climb, content: 'x' }, agent())).rejects.toThrow(/outside allowed directories/);
    expect(existsSync('/etc/lynox-rel-probe')).toBe(false);
  });

  it('maps a relative path onto the workspace in every resolver, the same way', () => {
    expect(resolveToolPath('d/f.txt')).toBe(join(ws, 'd', 'f.txt'));
    expect(toWorkspaceRel('d/f.txt', ws)).toEqual({ kind: 'inside', rel: join('d', 'f.txt'), shown: join(ws, 'd', 'f.txt') });
    expect(validatePath('d/f.txt', 'write')).toBe(join(ws, 'd', 'f.txt'));
    expect(resolveWritablePath('d/f.txt')).toBe(join(ws, 'd', 'f.txt'));
    // An absolute path is unchanged.
    expect(resolveToolPath(join(cwd, 'f.txt'))).toBe(join(cwd, 'f.txt'));
  });
});

describe('with isolation, the permission guard judges a relative path where the tool reads it', () => {
  it('names the workspace file in the warning on a relative read of a sensitive name', () => {
    const warning = isDangerous('read_file', { path: 'config/.env' });
    expect(warning).toContain(join(ws, 'config', '.env'));
    expect(warning).not.toContain(cwd);
  });

  it('names the workspace file when asking about emptying it by a relative path', () => {
    writeFileSync(join(ws, 'report.md'), 'text');
    writeFileSync(join(cwd, 'report.md'), 'text');
    const warning = isDangerous('write_file', { path: 'report.md', content: '' });
    expect(warning).toContain(join(ws, 'report.md'));
    expect(warning).not.toContain(cwd);
  });

  it('lets an unattended move within the workspace by relative paths through, and blocks one out of it', () => {
    mkdirSync(join(ws, 'in'));
    expect(isDangerous('batch_files', { directory: 'in', pattern: '*.txt', operation: 'move', destination: 'out' }, 'autonomous')).toBeNull();
    expect(isDangerous('batch_files', { directory: 'in', pattern: '*.txt', operation: 'move', destination: join(cwd, 'out') }, 'autonomous'))
      .toContain('move destination outside project');
  });
});

describe('without isolation, a relative path still means the process cwd', () => {
  it('resolveToolPath falls back to the cwd', () => {
    clearTenantWorkspace();
    expect(resolveToolPath('f.txt')).toBe(join(cwd, 'f.txt'));
  });
});
