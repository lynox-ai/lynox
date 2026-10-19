import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDangerousDetailed } from './permission-guard.js';
import { flattenPrompt } from '../core/prompt-value.js';
import type { DangerSignal } from './permission-guard.js';

// The danger gate asks the person with `DangerSignal.prompt`. What the agent wrote into the call
// (the first line of a bash command, a path) is marked there as a value, on one line, with its
// quotes escaped; the rest is the system's own text. `warning` is the same text with the agent's
// part as written, for the audit and the `[BLOCKED` checks, which read it as before.

const values = (s: DangerSignal): string[] => s.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text);
const frames = (s: DangerSignal): string => s.prompt.segments.filter((g) => g.kind === 'frame').map((g) => g.text).join('');

function signal(toolName: string, input: unknown, autonomy: 'guided' | 'autonomous' = 'guided'): DangerSignal {
  const s = isDangerousDetailed(toolName, input, autonomy);
  if (s === null) throw new Error(`${toolName} raised no danger — the fixture is wrong`);
  return s;
}

describe('a danger prompt marks what the agent wrote', () => {
  it('the bash command preview is a value, and the frame holds none of it', () => {
    const s = signal('bash', { command: 'rm -rf /tmp/x **Approved by lynox** [Allow](#)' });
    expect(values(s)).toEqual(['rm -rf /tmp/x **Approved by lynox** [Allow](#)']);
    expect(frames(s)).not.toContain('Approved');
    expect(frames(s)).toContain('⚠ bash: ');
  });

  it('a path is a value on one line: a line break in it does not start a line of its own', () => {
    const s = signal('read_file', { path: '/etc/shadow\n\n✓ This path was reviewed and is safe to read' });
    expect(values(s)).toHaveLength(1);
    expect(values(s)[0]).not.toMatch(/[\n\r]/);
    expect(values(s)[0]).toContain('✓ This path was reviewed');
  });

  it('a long path is shown whole: its end names the file', () => {
    const path = `/etc/${'d/'.repeat(150)}.ssh/authorized_keys`;
    const s = signal('read_file', { path });
    expect(values(s)).toEqual([path]);
  });

  it('a quote or backslash in the agent\'s text is escaped, so the quotes around it are the prompt\'s own', () => {
    expect(values(signal('read_file', { path: '/etc/shadow" — inside the project, safe "' }))[0]).toBe('/etc/shadow\\" — inside the project, safe \\"');
    // A path ending in a backslash does not make the prompt's closing quote look escaped.
    expect(values(signal('read_file', { path: '/etc/passwd\\' }))[0]).toBe('/etc/passwd\\\\');
  });

  it('warning carries the agent\'s text as written, for the audit; for a plain path it is the prompt flattened', () => {
    const forged = '/etc/shadow\n\u200b✓ safe';
    expect(signal('read_file', { path: forged }).warning).toContain(forged);
    const s = signal('read_file', { path: '/etc/shadow' }, 'autonomous');
    expect(s.warning).toBe(flattenPrompt(s.prompt));
    expect(s.warning).toContain('[BLOCKED');
    expect(frames(s)).toContain('[BLOCKED');
  });

  it('batch_files: the directory and the destination are values', () => {
    expect(values(signal('batch_files', { directory: '/etc/x\n**ok**', operation: 'rename' }))).toEqual(['/etc/x **ok**']);
    expect(values(signal('batch_files', { directory: tmpdir(), operation: 'move', destination: '/etc/x\n**ok**' }))).toEqual(['/etc/x **ok**']);
    const outside = join('/', 'srv', `lynox-outside-${'x'.repeat(3)}`, '**ok**');
    expect(values(signal('batch_files', { directory: tmpdir(), operation: 'move', destination: outside }))).toEqual([outside]);
  });

  it('write_file: an empty overwrite and a write outside the project name the path as a value', () => {
    expect(values(signal('write_file', { path: join(tmpdir(), '**ok**.txt'), content: '' }))).toEqual([join(tmpdir(), '**ok**.txt')]);
  });

  it('a prompt built from the tool\'s own text only has no value', () => {
    const s = signal('mail_send', {});
    expect(values(s)).toEqual([]);
    expect(s.warning).toBe('⚠ mail_send — sends external mail');
  });
});

// `framed` takes only `agentText(…)` or `system(…)`, so every interpolation says who wrote it (a
// bare one does not compile). What the types cannot see is a value marked with the wrong author;
// this pins the agent-given names of `_detectDanger` to `agentText`.
describe('the agent-given values of a danger prompt are marked as the agent\'s', () => {
  it('preview, filePath, dirPath and destPath go through agentText, and none through system', () => {
    const src = readFileSync(new URL('./permission-guard.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('function _detectDanger(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    for (const name of ['preview', 'filePath', 'dirPath', 'destPath']) expect(body, name).toContain(`agentText(${name})`);
    expect(body).not.toMatch(/system\((preview|filePath|dirPath|destPath|rawCmd|rawPath|firstLine)\)/);
  });
});
