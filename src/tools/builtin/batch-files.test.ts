import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchFilesTool } from './batch-files.js';

let dir: string;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'nodyn-batch-'));
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
