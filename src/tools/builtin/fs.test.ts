import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileTool, writeFileTool, resetWriteByteCounter } from './fs.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';

let dir: string;

beforeEach(() => {
  resetWriteByteCounter();
});

afterEach(async () => {
  clearTenantWorkspace();
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-fs-')));
  return dir;
}

describe('readFileTool', () => {
  it('reads existing file content', async () => {
    const d = await makeTempDir();
    const filePath = join(d, 'hello.txt');
    writeFileSync(filePath, 'hello world', 'utf-8');

    const result = await readFileTool.handler({ path: filePath }, {} as never);
    expect(result).toBe('hello world');
  });

  it('throws with cause for non-existent file', async () => {
    const d = await makeTempDir();
    const filePath = join(d, 'nope.txt');

    await expect(readFileTool.handler({ path: filePath }, {} as never))
      .rejects.toThrow('read_file:');

    try {
      await readFileTool.handler({ path: filePath }, {} as never);
    } catch (e) {
      expect((e as Error).cause).toBeInstanceOf(Error);
    }
  });
});

describe('writeFileTool', () => {
  it('creates and writes a file', async () => {
    const d = await makeTempDir();
    setTenantWorkspace(d);
    const filePath = join(d, 'out.txt');

    const result = await writeFileTool.handler({ path: filePath, content: 'data' }, {} as never);
    expect(result).toContain('Written to');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('data');
  });

  it('creates parent directories recursively', async () => {
    const d = await makeTempDir();
    setTenantWorkspace(d);
    const filePath = join(d, 'a', 'b', 'c', 'deep.txt');

    const result = await writeFileTool.handler({ path: filePath, content: 'nested' }, {} as never);
    expect(result).toContain('Written to');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('nested');
  });

  it('resolves symlinks when writing to existing file', async () => {
    const d = await makeTempDir();
    setTenantWorkspace(d);
    const realFile = join(d, 'real.txt');
    const linkFile = join(d, 'link.txt');
    writeFileSync(realFile, 'original', 'utf-8');
    await symlink(realFile, linkFile);

    const result = await writeFileTool.handler({ path: linkFile, content: 'updated' }, {} as never);
    expect(result).toContain('Written to');
    expect(result).toContain('real.txt');
    const content = await readFile(realFile, 'utf-8');
    expect(content).toBe('updated');
  });

  it('resolves parent symlink for new files in symlinked directories', async () => {
    const d = await makeTempDir();
    setTenantWorkspace(d);
    const realDir = join(d, 'realdir');
    mkdirSync(realDir);
    const linkDir = join(d, 'linkdir');
    await symlink(realDir, linkDir);

    const filePath = join(linkDir, 'newfile.txt');
    const result = await writeFileTool.handler({ path: filePath, content: 'hello' }, {} as never);
    expect(result).toContain('Written to');

    const content = await readFile(join(realDir, 'newfile.txt'), 'utf-8');
    expect(content).toBe('hello');
  });

  describe('session write byte limit', () => {
    it('normal write passes', async () => {
      const d = await makeTempDir();
      setTenantWorkspace(d);
      const result = await writeFileTool.handler(
        { path: join(d, 'small.txt'), content: 'hello' },
        {} as never,
      );
      expect(result).toContain('Written to');
    });

    it('over limit throws', async () => {
      const d = await makeTempDir();
      setTenantWorkspace(d);
      // Write 90MB in one go
      const bigContent = 'x'.repeat(90 * 1024 * 1024);
      await writeFileTool.handler(
        { path: join(d, 'big.txt'), content: bigContent },
        {} as never,
      );
      // Second write of 20MB should exceed the 100MB limit
      const moreContent = 'y'.repeat(20 * 1024 * 1024);
      await expect(
        writeFileTool.handler(
          { path: join(d, 'big2.txt'), content: moreContent },
          {} as never,
        ),
      ).rejects.toThrow(/Session write limit/);
    });

    it('cumulative tracking across multiple writes', async () => {
      const d = await makeTempDir();
      setTenantWorkspace(d);
      const chunk = 'z'.repeat(40 * 1024 * 1024); // 40MB each
      await writeFileTool.handler({ path: join(d, 'a.txt'), content: chunk }, {} as never);
      await writeFileTool.handler({ path: join(d, 'b.txt'), content: chunk }, {} as never);
      // Third 40MB write would total 120MB > 100MB limit
      await expect(
        writeFileTool.handler({ path: join(d, 'c.txt'), content: chunk }, {} as never),
      ).rejects.toThrow(/Session write limit/);
    });
  });
});
