import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDangerous } from './permission-guard.js';
import { writeFileTool, editFileTool } from './builtin/fs.js';
import { clearTenantWorkspace } from '../core/workspace.js';
import type { IAgent, ToolEntry } from '../types/index.js';

/**
 * The sensitive-path check reads the file `write_file` and `edit_file` write, not the path as the
 * model wrote it. Without a workspace (the CLI) both
 * tools confine a path to the data dir's workspace and follow a link that stays in its folder, so
 * the path as written and the file written are two different things.
 */

let root: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-wtarget-')));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = root;
  clearTenantWorkspace();
  await mkdir(join(root, 'workspace'), { recursive: true });
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  await rm(root, { recursive: true, force: true });
});

const asEntry = (t: unknown): ToolEntry => t as ToolEntry;

describe('the sensitive-path check reads the file the tool writes', () => {
  it.each([['write_file', writeFileTool], ['edit_file', editFileTool]] as const)('%s: a link in the workspace to a .env file is asked about', async (name, tool) => {
    await writeFile(join(root, 'workspace', '.env'), 'KEY=1\n');
    await symlink('.env', join(root, 'workspace', 'notes.txt'));
    const warning = isDangerous(name, { path: 'notes.txt', content: 'x', old_string: 'a', new_string: 'b' }, 'guided', asEntry(tool));
    expect(warning).toMatch(/sensitive path/);
    expect(warning).toContain('.env');
  });

  it.each([['write_file', writeFileTool], ['edit_file', editFileTool]] as const)('%s: a link that leaves its folder declares no target, the guard does not throw, and the tool refuses the write', async (name, tool) => {
    const away = await mkdtemp(join(tmpdir(), 'lynox-wtarget-out-'));
    try {
      await writeFile(join(away, 'out.txt'), 'x');
      await symlink(join(away, 'out.txt'), join(root, 'workspace', 'away.txt'));
      expect(tool.writeTarget?.('away.txt')).toBeNull();
      expect(() => isDangerous(name, { path: 'away.txt', content: 'x', old_string: 'x', new_string: 'y' }, 'guided', asEntry(tool))).not.toThrow();
      const agent = { sessionCounters: { writeBytes: 0 } } as unknown as IAgent;
      await expect(tool.handler({ path: 'away.txt', content: 'y', old_string: 'x', new_string: 'y' } as never, agent)).rejects.toThrow(/Blocked: .*(escapes the workspace|points outside)/);
      expect(await readFile(join(away, 'out.txt'), 'utf-8')).toBe('x');
    } finally {
      await rm(away, { recursive: true, force: true });
    }
  });

  it('edit_file declares an artifact path as its own target; write_file declares the workspace file', async () => {
    await mkdir(join(root, 'artifacts'), { recursive: true });
    const artifact = join(root, 'artifacts', 'report.html');
    await writeFile(artifact, 'x');
    expect(editFileTool.writeTarget?.(artifact)).toBe(artifact);
    expect(writeFileTool.writeTarget?.(artifact)).toBe(join(root, 'workspace', 'report.html'));
  });

  it.each([['write_file', writeFileTool], ['edit_file', editFileTool]] as const)('%s: control — a plain file in the workspace is not', async (name, tool) => {
    await writeFile(join(root, 'workspace', 'plain.txt'), 'x\n');
    expect(isDangerous(name, { path: 'plain.txt', content: 'x', old_string: 'a', new_string: 'b' }, 'guided', asEntry(tool))).toBeNull();
  });
});

describe('a data dir under /root/ or .config/ (an install as root, an XDG layout)', () => {
  const withDataDir = (dir: string, run: () => void): void => {
    const prev = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dir;
    try { run(); } finally { if (prev === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prev; }
  };
  it.each([
    ['/root/.lynox', '/root/.lynox/artifacts/report.html'],
    ['/home/op/.config/lynox', '/home/op/.config/lynox/artifacts/report.html'],
    ['/home/op/.config/lynox', '/home/op/.config/lynox/workspace/notes.txt'],
  ])('a file of the agent in %s (%s) is not asked about', (dir, path) => {
    withDataDir(dir, () => {
      expect(isDangerous('edit_file', { path, old_string: 'a', new_string: 'b' }, 'guided')).toBeNull();
      expect(isDangerous('write_file', { path, content: 'x' }, 'guided')).toBeNull();
    });
  });
  it.each([
    ['/root/.lynox', '/root/.ssh/authorized_keys'],
    ['/root/.lynox', '/root/notes.txt'],
    ['/root/.lynox', '/root/.lynox/http-secret'],
    ['/home/op/.config/lynox', '/home/op/.config/other-app/settings.json'],
    // The data dir's own secrets, where no `.lynox/` rule reaches them.
    ['/home/op/.config/lynox', '/home/op/.config/lynox/config.json'],
    ['/home/op/.config/lynox', '/home/op/.config/lynox/vault.db'],
    ['/home/op/.config/lynox', '/home/op/.config/lynox/http-secret'],
    ['/root/lynox', '/root/lynox/config.json'],
    ['/root', '/root/.config/gh/hosts.yml'],
  ])('control: with the data dir at %s, %s is still asked about', (dir, path) => {
    withDataDir(dir, () => {
      expect(isDangerous('write_file', { path, content: 'x' }, 'guided')).toMatch(/sensitive path/);
      expect(isDangerous('read_file', { path }, 'guided')).toMatch(/sensitive path/);
    });
  });

  it('a data dir reached through a link: an artifact is not asked about, spelled either way', async () => {
    const base = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-wtarget-link-')));
    try {
      // Spelled through a link named .config: the real dir has no .config in its path.
      await mkdir(join(base, 'real', 'lynox', 'artifacts'), { recursive: true });
      await mkdir(join(base, 'home'));
      await symlink(join(base, 'real'), join(base, 'home', '.config'));
      withDataDir(join(base, 'home', '.config', 'lynox'), () => {
        const spelled = join(base, 'home', '.config', 'lynox', 'artifacts', 'r.html');
        expect(isDangerous('write_file', { path: spelled, content: 'x' }, 'guided')).toBeNull();
        // read_file also judges the path as written, which has .config in it.
        expect(isDangerous('read_file', { path: spelled }, 'guided')).toBeNull();
      });
      // The real dir has .config in its path; the data dir is set through a link without it.
      await mkdir(join(base, 'x', '.config', 'lynox', 'artifacts'), { recursive: true });
      await symlink(join(base, 'x', '.config', 'lynox'), join(base, 'dl'));
      withDataDir(join(base, 'dl'), () => {
        expect(isDangerous('write_file', { path: join(base, 'x', '.config', 'lynox', 'artifacts', 'r.html'), content: 'x' }, 'guided')).toBeNull();
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('a link in the data dir workspace to a .config folder elsewhere is judged at its target', async () => {
    const base = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-wtarget-gh-')));
    try {
      await mkdir(join(base, 'data', 'workspace'), { recursive: true });
      await mkdir(join(base, 'home', '.config', 'gh'), { recursive: true });
      await writeFile(join(base, 'home', '.config', 'gh', 'hosts.yml'), 'token: x\n');
      await symlink(join(base, 'home', '.config', 'gh'), join(base, 'data', 'workspace', 'gh'));
      withDataDir(join(base, 'data'), () => {
        const path = join(base, 'data', 'workspace', 'gh', 'hosts.yml');
        expect(isDangerous('read_file', { path }, 'guided')).toMatch(/sensitive path/);
        expect(isDangerous('write_file', { path, content: 'x' }, 'guided')).toMatch(/sensitive path/);
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('credentials in a file or folder name is asked about, a document about them is not', () => {
  it.each(['write_file', 'edit_file'])('%s: a guide whose name contains the word is not asked about', (name) => {
    expect(isDangerous(name, { path: '/home/user/project/client-credentials-guide.md', content: 'x' }, 'guided')).toBeNull();
  });
  it.each([
    '/home/user/project/credentials.json',
    '/home/user/Downloads/credentials (1).json',
    '/home/user/project/credentials-prod.json',
    '/home/user/project/credentials.json~',
    '/home/user/project/credentials.json.2024-11-04',
    '/home/user/project/credentials.d/x',
    '/home/user/project/aws-credentials/x',
    '/home/user/Downloads/credentials.html',
    '/home/user/project/credentials.json.md',
    '/home/user/.config-free/application_default_credentials.json',
    '/home/user/project/.git-credentials',
    '/home/user/project/credentials',
    '/run/credentials/app/token',
  ])('still asks for %s', (path) => {
    expect(isDangerous('write_file', { path, content: 'x' }, 'guided')).toMatch(/sensitive path/);
  });
});
