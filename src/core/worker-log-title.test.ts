import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetErrorEgress, reduceErrorTextForProcess, scheduleInLog } from './error-egress.js';

/**
 * How the worker names a schedule in the container log (`scheduleInLog`): by title and id, and
 * on an instance with an exact connection by its id only, since the title is run text.
 */

afterEach(() => { _resetErrorEgress(); });

describe('scheduleInLog', () => {
  it('reads "<title>" (<id>) without an exact connection, as the log did before', () => {
    expect(scheduleInLog('Reprice the summer sandals', 'trg-1')).toBe('"Reprice the summer sandals" (trg-1)');
  });

  it('reads the id only once the process holds an exact connection', () => {
    reduceErrorTextForProcess();
    const line = scheduleInLog('Reprice the summer sandals', 'trg-1');
    expect(line).toBe('trg-1');
    expect(line).not.toContain('sandals');
  });
});

describe('the worker\'s log lines (source guard)', () => {
  // Every file that writes with the worker's prefix, and every line of it that carries the prefix.
  const files = ['worker-loop.ts', 'workflow-questions.ts'];
  const logLines = files.flatMap((f) => readFileSync(join(import.meta.dirname, f), 'utf8').split('\n')
    .filter((l) => l.includes('[lynox:worker]')).map((l) => ({ file: f, line: l })));
  // Run text a log line must not print of its own: a schedule's title, description, instruction,
  // goal or summary, a name or label held in a variable, a step's task.
  const RUN_TEXT = /\$\{[^}]*(\b(title|description|instruction|goal|summary|name|label)\b|\.task\b)/;

  it('names a schedule in a log line only through scheduleInLog, and prints no other run text of its own', () => {
    const offending = logLines.filter(({ line }) => RUN_TEXT.test(line.replaceAll(/scheduleInLog\([^)]*\)/g, '')));
    expect(offending).toEqual([]);
  });

  it('reads the lines it guards: the worker\'s 13 calls of the helper are among them', () => {
    // The positive control: the guard reads the files it means to, not an empty list.
    expect(logLines.filter(({ line }) => line.includes('scheduleInLog(')).length).toBe(13);
    expect(logLines.some(({ file }) => file === 'workflow-questions.ts')).toBe(true);
  });
});
