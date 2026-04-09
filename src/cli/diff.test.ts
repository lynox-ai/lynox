import { describe, it, expect } from 'vitest';
import { renderDiff, renderDiffHunks } from './diff.js';

describe('renderDiff', () => {
  it('includes header lines', () => {
    const result = renderDiff('a', 'b');
    expect(result).toContain('--- before');
    expect(result).toContain('+++ after');
  });

  it('shows identical lines as context (dimmed)', () => {
    const result = renderDiff('same\nline', 'same\nline');
    expect(result).toContain(' same');
    expect(result).toContain(' line');
    // Should not contain + or - for unchanged lines
    expect(result).not.toMatch(/^[+-]same/m);
  });

  it('marks removed lines in red with -', () => {
    const result = renderDiff('old', 'new');
    expect(result).toContain('\x1b[31m-old');
  });

  it('marks added lines in green with +', () => {
    const result = renderDiff('old', 'new');
    expect(result).toContain('\x1b[32m+new');
  });

  it('handles complete replacement', () => {
    const result = renderDiff('line1\nline2', 'lineA\nlineB');
    expect(result).toContain('-line1');
    expect(result).toContain('-line2');
    expect(result).toContain('+lineA');
    expect(result).toContain('+lineB');
  });

  it('handles empty before', () => {
    const result = renderDiff('', 'added');
    expect(result).toContain('+added');
  });

  it('handles empty after', () => {
    const result = renderDiff('removed', '');
    expect(result).toContain('-removed');
  });

  it('handles multi-line mixed changes', () => {
    const before = 'keep\nremove\nstay';
    const after = 'keep\nadd\nstay';
    const result = renderDiff(before, after);
    expect(result).toContain(' keep');
    expect(result).toContain('-remove');
    expect(result).toContain('+add');
    expect(result).toContain(' stay');
  });

  it('handles identical content', () => {
    const result = renderDiff('same', 'same');
    expect(result).not.toContain('-same');
    expect(result).not.toContain('+same');
    expect(result).toContain(' same');
  });

  it('handles empty strings for both', () => {
    const result = renderDiff('', '');
    expect(result).toContain('--- before');
    expect(result).toContain('+++ after');
  });
});

describe('renderDiffHunks', () => {
  it('shows hunk-based output with context lines', () => {
    const before = 'line1\nline2\nline3\nline4\nline5';
    const after = 'line1\nline2\nchanged\nline4\nline5';
    const result = renderDiffHunks(before, after, 1);
    expect(result).toContain('-line3');
    expect(result).toContain('+changed');
    // Context lines around the change
    expect(result).toContain(' line2');
    expect(result).toContain(' line4');
  });

  it('collapses unchanged regions between hunks', () => {
    // Create a file with changes far apart
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[2] = 'changed3';
    newLines[17] = 'changed18';
    const newContent = newLines.join('\n');

    const result = renderDiffHunks(oldContent, newContent, 1);
    // Should contain both changes
    expect(result).toContain('-line3');
    expect(result).toContain('+changed3');
    expect(result).toContain('-line18');
    expect(result).toContain('+changed18');
    // Should contain collapse separator between hunks
    expect(result).toContain('...');
    // Lines far from changes should NOT appear
    expect(result).not.toContain(' line10');
  });

  it('shows NEW FILE header when before is empty', () => {
    const result = renderDiffHunks('', 'line1\nline2\nline3');
    expect(result).toContain('NEW FILE');
    expect(result).toContain('3 lines');
    expect(result).toContain('+line1');
    expect(result).toContain('+line2');
    expect(result).toContain('+line3');
  });

  it('shows DELETE header when after is empty', () => {
    const result = renderDiffHunks('line1\nline2', '');
    expect(result).toContain('DELETE');
    expect(result).toContain('2 lines');
    expect(result).toContain('-line1');
    expect(result).toContain('-line2');
  });

  it('truncates NEW FILE preview to 20 lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const result = renderDiffHunks('', lines.join('\n'));
    expect(result).toContain('+line1');
    expect(result).toContain('+line20');
    expect(result).not.toContain('+line21');
    expect(result).toContain('10 more lines');
  });

  it('skips LCS for large files (>100KB) and shows summary', () => {
    const large = 'x'.repeat(101 * 1024); // >100KB
    const result = renderDiffHunks(large, large + '\nextra');
    expect(result).toContain('KB file');
    expect(result).toContain('diff skipped');
  });

  it('shows only relevant hunks for small changes in large file', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[50] = 'CHANGED';
    const newContent = newLines.join('\n');

    const result = renderDiffHunks(oldContent, newContent, 2);
    // The changed line and its context
    expect(result).toContain('-line51');
    expect(result).toContain('+CHANGED');
    expect(result).toContain(' line49');
    expect(result).toContain(' line50');
    expect(result).toContain(' line52');
    expect(result).toContain(' line53');
    // Lines far away should NOT appear
    expect(result).not.toContain(' line1');
    expect(result).not.toContain(' line100');
  });

  it('shows no-changes message for identical content', () => {
    const result = renderDiffHunks('same\ncontent', 'same\ncontent');
    expect(result).toContain('No changes');
  });

  it('includes header with before/after labels', () => {
    const result = renderDiffHunks('old', 'new');
    expect(result).toContain('--- before');
    expect(result).toContain('+++ after');
  });

  it('defaults to 3 context lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[10] = 'CHANGED';
    const newContent = newLines.join('\n');

    const result = renderDiffHunks(oldContent, newContent);
    // 3 lines of context before and after
    expect(result).toContain(' line8');
    expect(result).toContain(' line9');
    expect(result).toContain(' line10');
    expect(result).toContain('-line11');
    expect(result).toContain('+CHANGED');
    expect(result).toContain(' line12');
    expect(result).toContain(' line13');
    expect(result).toContain(' line14');
    // Beyond 3 lines of context
    expect(result).not.toContain(' line7');
    expect(result).not.toContain(' line15');
  });
});
