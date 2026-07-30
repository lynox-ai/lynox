import { describe, it, expect } from 'vitest';
import {
  parsePortableMemoryKey,
  MEMORY_NAMESPACE_FILES,
  trimMemoryContent,
  MAX_MEMORY_FILE_BYTES,
} from './memory-file.js';
import { scopeToDir } from './scope-resolver.js';

describe('parsePortableMemoryKey', () => {
  it('derives namespace file names from the namespace enum, not a hand-written list', () => {
    expect([...MEMORY_NAMESPACE_FILES].sort()).toEqual([
      'knowledge.txt', 'learnings.txt', 'methods.txt', 'status.txt',
    ]);
  });

  it('accepts every directory shape scopeToDir can produce', () => {
    const dirs = [
      scopeToDir({ type: 'global', id: 'global' }),
      scopeToDir({ type: 'context', id: 'http-api' }),
      scopeToDir({ type: 'user', id: 'rafael' }),
    ];
    for (const dir of dirs) {
      expect(parsePortableMemoryKey(`${dir}/knowledge.txt`)).toEqual({
        scopeDir: dir,
        fileName: 'knowledge.txt',
      });
    }
  });

  it.each([
    ['../../etc/passwd', 'parent traversal'],
    ['../knowledge.txt', 'parent segment'],
    ['..%2fknowledge.txt', 'encoded traversal is not decoded, but the dot prefix is rejected'],
    ['./knowledge.txt', 'current-dir segment'],
    ['.hidden/knowledge.txt', 'dot-prefixed directory'],
    ['/etc/knowledge.txt', 'absolute path'],
    ['a/b/knowledge.txt', 'nested directory'],
    ['global', 'no file segment'],
    ['global/', 'empty file segment'],
    ['global/passwd', 'unknown namespace file'],
    ['global/knowledge.txt.bak', 'namespace lookalike'],
    ['global/preferences.txt', 'namespace that the enum does not contain'],
    ['gl obal/knowledge.txt', 'space in scope dir'],
  ])('rejects %s (%s)', (key) => {
    expect(parsePortableMemoryKey(key)).toBeNull();
  });

  it('rejects a scope directory that exceeds the length ceiling', () => {
    const tooLong = 'a'.repeat(161);
    expect(parsePortableMemoryKey(`${tooLong}/knowledge.txt`)).toBeNull();
  });

  it('accepts a max-length user scope dir (the user- prefix must still fit)', () => {
    const maxId = 'u'.repeat(128);
    const dir = scopeToDir({ type: 'user', id: maxId });
    expect(parsePortableMemoryKey(`${dir}/methods.txt`)).toEqual({
      scopeDir: dir,
      fileName: 'methods.txt',
    });
  });
});

describe('trimMemoryContent', () => {
  const bytes = (s: string): number => Buffer.byteLength(s, 'utf-8');

  it('leaves content under the ceiling untouched', () => {
    expect(trimMemoryContent('a\nb\nc')).toBe('a\nb\nc');
  });

  it('drops oldest lines and keeps the newest under the ceiling', () => {
    const line = `${'z'.repeat(199)}\n`;
    const content = `FIRST\n${line.repeat(2000)}LAST`;
    expect(bytes(content)).toBeGreaterThan(MAX_MEMORY_FILE_BYTES);

    const trimmed = trimMemoryContent(content);
    expect(bytes(trimmed)).toBeLessThanOrEqual(MAX_MEMORY_FILE_BYTES);
    expect(trimmed.endsWith('LAST')).toBe(true);
    expect(trimmed.startsWith('FIRST')).toBe(false);
    expect(trimmed.startsWith('z')).toBe(true); // cut lands on a line boundary
  });

  it('cannot shrink a single line — parity with what Memory itself can produce', () => {
    const oneLine = 'z'.repeat(MAX_MEMORY_FILE_BYTES * 2);
    expect(trimMemoryContent(oneLine)).toBe(oneLine);
  });

  it('keeps only the final line when that line alone exceeds the ceiling', () => {
    const tail = 'z'.repeat(MAX_MEMORY_FILE_BYTES * 2);
    expect(trimMemoryContent(`a\nb\n${tail}`)).toBe(tail);
  });

  it('never splits a multi-byte character at the cut', () => {
    const line = `${'ä'.repeat(100)}\n`; // 2 bytes per char
    const trimmed = trimMemoryContent(line.repeat(3000));
    expect(bytes(trimmed)).toBeLessThanOrEqual(MAX_MEMORY_FILE_BYTES);
    expect(trimmed).not.toContain('\uFFFD');
    expect(trimmed.startsWith('ä')).toBe(true);
  });

  it('is linear: a 20 MB file trims well inside the default test timeout', () => {
    // Doubles as the guard against the quadratic shift-and-rejoin loop, which
    // needed >20k full re-splits (minutes) for this input. Memory tolerated it
    // because it trims after each append; the migration importer does not.
    const content = `${'z'.repeat(199)}\n`.repeat(100_000);
    expect(bytes(content)).toBeGreaterThan(19_000_000);
    const trimmed = trimMemoryContent(content);
    expect(bytes(trimmed)).toBeLessThanOrEqual(MAX_MEMORY_FILE_BYTES);
  });
});
