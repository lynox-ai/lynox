import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchFilesTool } from './batch-files.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';

let dir: string;
let data: string | undefined;
let prevDataDir: string | undefined;

afterEach(async () => {
  if (data) {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    await rm(data, { recursive: true, force: true });
    data = undefined;
  }
});

/**
 * A directory under the workspace root of a fresh data dir: without isolation batch_files changes
 * files only there and in the artifacts directory.
 */
async function makeTempDir(): Promise<string> {
  data = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-batch-')));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = data;
  dir = join(data, 'workspace', 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('batchFilesTool', () => {
  it('returns "No files matching" when no files match pattern', async () => {
    const d = await makeTempDir();
    const result = await batchFilesTool.handler(
      { pattern: '*.xyz', directory: d, operation: 'rename' },
      {} as never,
    );
    expect(result).toContain('No files matching');
  });

  describe('rename', () => {
    it('renames files using $1 replacement pattern', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'report.txt'), 'data');
      writeFileSync(join(d, 'summary.txt'), 'data');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'rename',
          rename_pattern: '$1.md',
        },
        {} as never,
      );
      expect(result).toContain('Processed 2 file(s)');
      expect(existsSync(join(d, 'report.md'))).toBe(true);
      expect(existsSync(join(d, 'summary.md'))).toBe(true);
      expect(existsSync(join(d, 'report.txt'))).toBe(false);
    });

    it('returns error when rename_pattern is missing', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'file.txt'), 'data');

      const result = await batchFilesTool.handler(
        { pattern: '*.txt', directory: d, operation: 'rename' },
        {} as never,
      );
      expect(result).toBe('rename_pattern is required for rename operation');
    });

    it('blocks a rename whose target escapes the workspace (path traversal)', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'report.txt'), 'data');
      // realpath so the stored workspace matches the handler's realpath'd dir
      // (on macOS the tmpdir path is a /var → /private/var symlink).
      setTenantWorkspace(realpathSync(d)); // activate workspace isolation for this test
      try {
        const result = await batchFilesTool.handler(
          {
            pattern: '*.txt',
            directory: d,
            operation: 'rename',
            // The `../` climbs out of the workspace (to /etc). The new name is refused
            // BEFORE any rename; the block reason (not an OS error) proves the guard ran.
            rename_pattern: '../../../../../../../../../../etc/lynox-batch-traversal-test',
          },
          {} as never,
        );
        expect(result).toMatch(/leaves the workspace/);
        // The file was not moved out of the workspace.
        expect(existsSync(join(d, 'report.txt'))).toBe(true);
        expect(existsSync('/etc/lynox-batch-traversal-test')).toBe(false);
      } finally {
        clearTenantWorkspace();
      }
    });
  });

  describe('move', () => {
    it('moves files to destination directory, creating it if needed', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'a.txt'), 'aaa');
      writeFileSync(join(d, 'b.txt'), 'bbb');
      const dest = join(d, 'subdir', 'dest');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'move',
          destination: dest,
        },
        {} as never,
      );
      expect(result).toContain('Processed 2 file(s)');
      expect(existsSync(join(dest, 'a.txt'))).toBe(true);
      expect(existsSync(join(dest, 'b.txt'))).toBe(true);
      expect(existsSync(join(d, 'a.txt'))).toBe(false);
    });
  });

  describe('transform', () => {
    it('replaces text in matching files', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'config.txt'), 'host=localhost\nport=3000');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'localhost',
          replace: '0.0.0.0',
        },
        {} as never,
      );
      expect(result).toContain('Transformed');
      const content = await readFile(join(d, 'config.txt'), 'utf-8');
      expect(content).toBe('host=0.0.0.0\nport=3000');
    });

    it('reports "No changes" when find text is not present', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'clean.txt'), 'nothing to change');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'nonexistent',
          replace: 'replacement',
        },
        {} as never,
      );
      expect(result).toContain('No changes');
    });

    it('skips files larger than 10MB', async () => {
      const d = await makeTempDir();
      const largePath = join(d, 'large.txt');
      // Create a file just over 10MB
      const buf = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
      writeFileSync(largePath, buf);

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'x',
          replace: 'y',
        },
        {} as never,
      );
      expect(result).toContain('Skipped (too large)');
    });
  });

  describe('glob matching', () => {
    it('*.txt matches only .txt files', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'a.txt'), 'a');
      writeFileSync(join(d, 'b.md'), 'b');
      writeFileSync(join(d, 'c.txt'), 'c');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'a',
          replace: 'z',
        },
        {} as never,
      );
      expect(result).toContain('Processed 2 file(s)');
    });

    it('? matches a single character', async () => {
      const d = await makeTempDir();
      writeFileSync(join(d, 'a1.txt'), 'data');
      writeFileSync(join(d, 'ab.txt'), 'data');
      writeFileSync(join(d, 'abc.txt'), 'data');

      const result = await batchFilesTool.handler(
        {
          pattern: 'a?.txt',
          directory: d,
          operation: 'transform',
          find: 'data',
          replace: 'done',
        },
        {} as never,
      );
      // a?.txt matches a1.txt and ab.txt but not abc.txt
      expect(result).toContain('Processed 2 file(s)');
    });
  });

  describe('recursive', () => {
    it('finds files in subdirectories', async () => {
      const d = await makeTempDir();
      mkdirSync(join(d, 'sub'));
      writeFileSync(join(d, 'top.txt'), 'top');
      writeFileSync(join(d, 'sub', 'nested.txt'), 'nested');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'top',
          replace: 'replaced',
        },
        {} as never,
      );
      expect(result).toContain('Processed 2 file(s)');
    });
  });

  describe('resource limits', () => {
    it('respects MAX_FIND_DEPTH (file at depth 12 not found)', async () => {
      const d = await makeTempDir();
      let current = d;
      for (let i = 0; i < 12; i++) {
        current = join(current, `d${i}`);
        mkdirSync(current);
      }
      writeFileSync(join(current, 'deep.txt'), 'deep');
      // Also put a file at depth 1 so we get results
      writeFileSync(join(d, 'top.txt'), 'top');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'top',
          replace: 'replaced',
        },
        {} as never,
      );
      // Only top.txt should be found, not deep.txt
      expect(result).toContain('Processed 1 file(s)');
    });

    it('file at exact depth boundary (10) is found', async () => {
      const d = await makeTempDir();
      let current = d;
      for (let i = 0; i < 10; i++) {
        current = join(current, `d${i}`);
        mkdirSync(current);
      }
      writeFileSync(join(current, 'boundary.txt'), 'boundary');

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'boundary',
          replace: 'found',
        },
        {} as never,
      );
      expect(result).toContain('Processed 1 file(s)');
    });

    it('caps file count at MAX_FIND_FILES (10000)', async () => {
      const d = await makeTempDir();
      // Create 10002 files — only first 10000 should be collected
      for (let i = 0; i < 10002; i++) {
        writeFileSync(join(d, `file${i}.txt`), 'data');
      }

      const result = await batchFilesTool.handler(
        {
          pattern: '*.txt',
          directory: d,
          operation: 'transform',
          find: 'data',
          replace: 'updated',
        },
        {} as never,
      );
      expect(result).toContain('Processed 10000 file(s)');
    });
  });
});

describe('without isolation, batch_files changes files only where edit_file writes', () => {
  let outside: string;

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  /** A directory beside the data dir, outside the workspace root and the artifacts directory. */
  function makeOutside(): string {
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-batch-outside-')));
    writeFileSync(join(outside, 'a.txt'), 'kept');
    return outside;
  }

  it.each([
    ['rename', { rename_pattern: 'b' }],
    ['move', { destination: 'unused' }],
    ['transform', { find: 'kept', replace: 'changed' }],
  ] as const)('refuses a directory outside both for %s, and the file stays as it was', async (operation, extra) => {
    await makeTempDir();
    const out = makeOutside();
    const input = { pattern: '*.txt', directory: out, operation, ...extra, ...(operation === 'move' ? { destination: join(dir, 'dest') } : {}) };
    await expect(batchFilesTool.handler(input as never, {} as never)).rejects.toThrow(/is outside the workspace/);
    expect(readFileSync(join(out, 'a.txt'), 'utf-8')).toBe('kept');
  });

  it('refuses a move destination outside both, and the file stays', async () => {
    const d = await makeTempDir();
    writeFileSync(join(d, 'a.txt'), 'kept');
    const out = makeOutside();
    await expect(batchFilesTool.handler({ pattern: '*.txt', directory: d, operation: 'move', destination: join(out, 'dest') }, {} as never))
      .rejects.toThrow(/is outside the workspace/);
    expect(existsSync(join(d, 'a.txt'))).toBe(true);
    expect(existsSync(join(out, 'dest'))).toBe(false);
  });

  // ux U-021: the way out depends on who reads it. Each branch asserts its whole sentence, and each
  // asserts that the other branch's way out is absent, so a swapped branch fails both tests.
  describe('the refusal names the way out this instance has', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    const refusal = async (): Promise<string> => {
      await makeTempDir();
      const out = makeOutside();
      try {
        await batchFilesTool.handler({ pattern: '*.txt', directory: out, operation: 'transform', find: 'kept', replace: 'changed' } as never, {} as never);
      } catch (err: unknown) {
        return (err as Error).message;
      }
      throw new Error('batch_files did not refuse');
    };
    const head = (msg: string): RegExp => new RegExp(`^Not changed: .+ is outside the workspace \\(.+\\) and the artifacts directory; batch_files changes files only there\\. Do not retry with this path\\. ${msg}$`);

    it('self-hosted (no billing tier): restart with LYNOX_WORKSPACE, told to the user', async () => {
      vi.stubEnv('LYNOX_BILLING_TIER', '');
      vi.stubEnv('LYNOX_MANAGED_MODE', '');
      const msg = await refusal();
      expect(msg).toMatch(head('Tell the user in one sentence: to work on files in another directory, they can restart lynox with LYNOX_WORKSPACE set to that directory\\.'));
      expect(msg).not.toMatch(/attach it in the chat/);
    });

    it('managed (billing tier set): stay in the workspace or attach the file, never the env var', async () => {
      vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
      const msg = await refusal();
      expect(msg).toMatch(head('Work only with files inside the workspace; if the user means a file from their computer, ask them to attach it in the chat\\.'));
      expect(msg).not.toMatch(/LYNOX_WORKSPACE/);
    });
  });

  it('refuses a rename whose pattern climbs out of the workspace root', async () => {
    const d = await makeTempDir();
    writeFileSync(join(d, 'a.txt'), 'kept');
    // `../../../` from `<data>/workspace/files` is the directory beside the data dir; the name is
    // this test's own, and it is removed whatever the asserts say.
    const own = `${basename(data!)}-escaped`;
    const escaped = join(dirname(data!), `${own}-a.txt`);
    try {
      const result = await batchFilesTool.handler({ pattern: '*.txt', directory: d, operation: 'rename', rename_pattern: `../../../${own}-$1.txt` }, {} as never);
      expect(result).toMatch(/is outside the workspace/);
      expect(existsSync(join(d, 'a.txt'))).toBe(true);
      expect(existsSync(escaped)).toBe(false);
    } finally {
      rmSync(escaped, { force: true });
    }
  });

  it('refuses a directory in the workspace root that is a link to one outside', async () => {
    const d = await makeTempDir();
    const out = makeOutside();
    symlinkSync(out, join(d, 'link'));
    await expect(batchFilesTool.handler({ pattern: '*.txt', directory: join(d, 'link'), operation: 'transform', find: 'kept', replace: 'changed' }, {} as never))
      .rejects.toThrow(/is outside the workspace/);
    expect(readFileSync(join(out, 'a.txt'), 'utf-8')).toBe('kept');
  });

  it('refuses a move destination in the workspace root that is a link to one outside', async () => {
    const d = await makeTempDir();
    writeFileSync(join(d, 'a.txt'), 'kept');
    const out = makeOutside();
    symlinkSync(out, join(d, 'out-link'));
    await expect(batchFilesTool.handler({ pattern: '*.txt', directory: d, operation: 'move', destination: join(d, 'out-link', 'dest') }, {} as never))
      .rejects.toThrow(/is outside the workspace/);
    expect(existsSync(join(d, 'a.txt'))).toBe(true);
    expect(existsSync(join(out, 'dest'))).toBe(false);
  });

  it('changes files in the artifacts directory, where edit_file writes too (control)', async () => {
    await makeTempDir();
    const artifacts = join(data!, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(join(artifacts, 'a.txt'), 'kept');
    const result = await batchFilesTool.handler({ pattern: '*.txt', directory: artifacts, operation: 'transform', find: 'kept', replace: 'changed' }, {} as never);
    expect(result).toContain('Transformed');
    expect(readFileSync(join(artifacts, 'a.txt'), 'utf-8')).toBe('changed');
  });
});
