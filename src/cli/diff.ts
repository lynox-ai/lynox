import { RED, GREEN, DIM, RESET, GRAY, CYAN, BOLD } from './ansi.js';

const SIZE_LIMIT = 100 * 1024; // 100KB

export function renderDiffHunks(before: string, after: string, contextLines = 3): string {
  // NEW FILE
  if (before === '') {
    const lines = after.split('\n');
    const header = `${CYAN}${BOLD}NEW FILE${RESET} ${DIM}(${lines.length} lines)${RESET}`;
    const preview = lines.slice(0, 20).map(l => `${GREEN}+${l}${RESET}`).join('\n');
    const truncated = lines.length > 20 ? `\n${DIM}... ${lines.length - 20} more lines${RESET}` : '';
    return `${header}\n${preview}${truncated}\n`;
  }

  // DELETE
  if (after === '') {
    const lines = before.split('\n');
    const header = `${CYAN}${BOLD}DELETE${RESET} ${DIM}(${lines.length} lines)${RESET}`;
    const preview = lines.slice(0, 20).map(l => `${RED}-${l}${RESET}`).join('\n');
    const truncated = lines.length > 20 ? `\n${DIM}... ${lines.length - 20} more lines${RESET}` : '';
    return `${header}\n${preview}${truncated}\n`;
  }

  // Large file skip: avoid LCS on huge content
  if (before.length > SIZE_LIMIT || after.length > SIZE_LIMIT) {
    const oldCount = before.split('\n').length;
    const newCount = after.split('\n').length;
    const changed = Math.abs(newCount - oldCount);
    const sizeKB = Math.round(Math.max(before.length, after.length) / 1024);
    return `${DIM}${sizeKB}KB file, ~${changed || 'unknown number of'} lines changed (diff skipped)${RESET}\n`;
  }

  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const lcs = computeLCS(oldLines, newLines);

  // Build raw diff lines with tags
  type DiffLine = { tag: 'ctx'; text: string } | { tag: 'del'; text: string } | { tag: 'add'; text: string };
  const rawDiff: DiffLine[] = [];

  let oi = 0;
  let ni = 0;
  let li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      rawDiff.push({ tag: 'ctx', text: oldLines[oi]! });
      oi++;
      ni++;
      li++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      rawDiff.push({ tag: 'del', text: oldLines[oi]! });
      oi++;
    } else if (ni < newLines.length) {
      rawDiff.push({ tag: 'add', text: newLines[ni]! });
      ni++;
    }
  }

  // Extract hunks: find changed regions and include context lines around them
  const changedIndices: number[] = [];
  for (let i = 0; i < rawDiff.length; i++) {
    if (rawDiff[i]!.tag !== 'ctx') {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) {
    return `${DIM}No changes${RESET}\n`;
  }

  // Build ranges of lines to show (changed + context)
  const showLines = new Set<number>();
  for (const idx of changedIndices) {
    for (let c = Math.max(0, idx - contextLines); c <= Math.min(rawDiff.length - 1, idx + contextLines); c++) {
      showLines.add(c);
    }
  }

  const header = `${GRAY}--- before${RESET}\n${GRAY}+++ after${RESET}`;
  const result: string[] = [header];
  let inHunk = false;

  for (let i = 0; i < rawDiff.length; i++) {
    if (!showLines.has(i)) {
      if (inHunk) {
        inHunk = false;
      }
      continue;
    }

    if (!inHunk) {
      // Start a new hunk separator (except before the very first hunk)
      if (result.length > 1) {
        result.push(`${GRAY}...${RESET}`);
      }
      inHunk = true;
    }

    const line = rawDiff[i]!;
    switch (line.tag) {
      case 'ctx':
        result.push(`${DIM} ${line.text}${RESET}`);
        break;
      case 'del':
        result.push(`${RED}-${line.text}${RESET}`);
        break;
      case 'add':
        result.push(`${GREEN}+${line.text}${RESET}`);
        break;
    }
  }

  return result.join('\n') + '\n';
}

export function renderDiff(before: string, after: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  // Simple line-by-line diff using LCS
  const lcs = computeLCS(oldLines, newLines);
  const result: string[] = [];

  let oi = 0;
  let ni = 0;
  let li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      result.push(`${DIM} ${oldLines[oi]}${RESET}`);
      oi++;
      ni++;
      li++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      result.push(`${RED}-${oldLines[oi]}${RESET}`);
      oi++;
    } else if (ni < newLines.length) {
      result.push(`${GREEN}+${newLines[ni]}${RESET}`);
      ni++;
    }
  }

  const header = `${GRAY}--- before${RESET}\n${GRAY}+++ after${RESET}`;
  return `${header}\n${result.join('\n')}\n`;
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = (dp[i - 1]?.[j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
      }
    }
  }

  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]!);
      i--;
      j--;
    } else if ((dp[i - 1]?.[j] ?? 0) > (dp[i]?.[j - 1] ?? 0)) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
