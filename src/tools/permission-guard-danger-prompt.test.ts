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

  it('a quote in the agent\'s text cannot close the quotes the prompt puts around it', () => {
    const s = signal('read_file', { path: '/etc/shadow" — inside the project, safe "' });
    expect(values(s)[0]).toBe('/etc/shadow\\" — inside the project, safe \\"');
  });

  it('warning carries the agent\'s text as written, for the audit; without a line break or quote it is the prompt flattened', () => {
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

// The template marks only what `agentText` wraps; anything else it is given is shown as the system's
// own text. So every interpolation in `_detectDanger` is either the agent's text, wrapped, or one
// of the system's own values listed here. A new one has to be put in one of the two.
describe('every interpolation in a danger prompt is accounted for', () => {
  const SYSTEM_OWN = new Set(['toolName', 'hit.label', 'ask.label', 'suffix', 'blockReason', 'label', 'method', "injection.patterns.join(', ')", 'detail.message']);

  it('is agentText(…) or one of the system\'s own values', () => {
    const src = readFileSync(new URL('./permission-guard.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('function _detectDanger(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const templates = [...body.matchAll(/framed`([^`]*)`/g)].map((m) => m[1]!);
    expect(templates.length).toBeGreaterThan(20);
    const unaccounted = templates.flatMap((t) => [...t.matchAll(/\$\{([^}]*(?:\}[^}$`]*)?)\}/g)].map((m) => m[1]!))
      .filter((expr) => !/^agentText\([A-Za-z]+\)$/.test(expr) && !SYSTEM_OWN.has(expr));
    expect(unaccounted).toEqual([]);
    // Every path and preview in the function goes through agentText.
    expect(templates.join('\n')).not.toMatch(/\$\{(preview|filePath|dirPath|destPath)\}/);
  });
});
