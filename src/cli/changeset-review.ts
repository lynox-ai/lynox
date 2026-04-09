import { RESET, BOLD, DIM, RED, GREEN, BLUE, GRAY, CYAN, stripAnsi } from './ansi.js';
import type { ChangesetDiff, ChangesetResult } from '../types/index.js';

/**
 * Render colored unified diff output.
 */
function colorDiff(diff: string): string {
  return diff
    .split('\n')
    .map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return `${BOLD}${line}${RESET}`;
      if (line.startsWith('@@')) return `${CYAN}${line}${RESET}`;
      if (line.startsWith('+')) return `${GREEN}${line}${RESET}`;
      if (line.startsWith('-')) return `${RED}${line}${RESET}`;
      return line;
    })
    .join('\n');
}

/**
 * Count added/removed lines in a diff.
 */
function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/**
 * Read a single keypress from stdin in raw mode.
 */
function readKey(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise<string>((resolve) => {
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY && !wasRaw) stdin.setRawMode(true);
    stdin.resume();
    const onData = (data: Buffer) => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY && !wasRaw) stdin.setRawMode(false);
      resolve(data.toString());
    };
    stdin.on('data', onData);
  });
}

/**
 * Interactive changeset review — shows diffs and prompts for accept/rollback.
 * Returns the user's decision.
 */
export async function reviewChangeset(
  changes: ChangesetDiff[],
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<ChangesetResult> {
  // Summary header
  const added = changes.filter(c => c.status === 'added').length;
  const modified = changes.filter(c => c.status === 'modified').length;
  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
  if (added > 0) parts.push(`${added} file${added > 1 ? 's' : ''} added`);

  stdout.write(`\n${BLUE}${BOLD}Changeset Review${RESET} ${DIM}(${parts.join(', ')})${RESET}\n\n`);

  // File list with +/- counts
  for (const change of changes) {
    const { added: a, removed: r } = countLines(change.diff);
    const statusLabel = change.status === 'added' ? `${GREEN}new${RESET}` : `${BLUE}mod${RESET}`;
    const counts = `${GREEN}+${a}${RESET} ${RED}-${r}${RESET}`;
    stdout.write(`  ${statusLabel} ${change.file} ${DIM}(${stripAnsi(counts) ? counts : 'no changes'})${RESET}\n`);
  }
  stdout.write('\n');

  // Show all diffs
  for (const change of changes) {
    stdout.write(`${GRAY}${'─'.repeat(60)}${RESET}\n`);
    stdout.write(`${BOLD}${change.file}${RESET} ${DIM}(${change.status})${RESET}\n`);
    stdout.write(colorDiff(change.diff) + '\n');
  }
  stdout.write(`${GRAY}${'─'.repeat(60)}${RESET}\n\n`);

  // Prompt
  stdout.write(`  ${BOLD}[A]${RESET}ccept all  ${BOLD}[R]${RESET}ollback all  ${BOLD}[P]${RESET}artial review\n`);
  stdout.write(`${DIM}  Press a key: ${RESET}`);

  const key = (await readKey(stdin)).toLowerCase();
  stdout.write('\n');

  if (key === 'a') {
    return { action: 'accept', acceptedFiles: changes.map(c => c.absolutePath), rolledBackFiles: [] };
  }

  if (key === 'r') {
    return { action: 'rollback', acceptedFiles: [], rolledBackFiles: changes.map(c => c.absolutePath) };
  }

  if (key === 'p') {
    // Partial review: iterate files one by one
    const acceptedFiles: string[] = [];
    const rolledBackFiles: string[] = [];

    for (const change of changes) {
      stdout.write(`\n${BOLD}${change.file}${RESET} ${DIM}(${change.status})${RESET}\n`);
      stdout.write(colorDiff(change.diff) + '\n');
      stdout.write(`  ${GREEN}[A]${RESET}ccept  ${RED}[R]${RESET}ollback: `);

      const decision = (await readKey(stdin)).toLowerCase();
      stdout.write('\n');

      if (decision === 'r') {
        rolledBackFiles.push(change.absolutePath);
        stdout.write(`  ${RED}Rolled back${RESET}\n`);
      } else {
        acceptedFiles.push(change.absolutePath);
        stdout.write(`  ${GREEN}Accepted${RESET}\n`);
      }
    }

    return {
      action: rolledBackFiles.length > 0 ? 'partial' : 'accept',
      acceptedFiles,
      rolledBackFiles,
    };
  }

  // Default: accept
  return { action: 'accept', acceptedFiles: changes.map(c => c.absolutePath), rolledBackFiles: [] };
}
