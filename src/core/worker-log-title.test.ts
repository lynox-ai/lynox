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
  const source = readFileSync(join(import.meta.dirname, 'worker-loop.ts'), 'utf8');
  // A worker log line is any template that carries the `[lynox:worker]` prefix.
  const logLines = source.split('\n').filter((l) => l.includes('[lynox:worker]'));

  it('names a schedule in a log line only through scheduleInLog, never by a title of its own', () => {
    const titled = logLines.filter((l) => /\$\{[^}]*\btitle\b/.test(l.replaceAll(/scheduleInLog\([^)]*\)/g, '')));
    expect(titled).toEqual([]);
  });

  it('finds the lines it guards: every schedule the worker names in its log goes through the helper', () => {
    // The positive control: the guard reads the file it means to, and its 13 lines are there.
    expect(logLines.filter((l) => l.includes('scheduleInLog(')).length).toBe(13);
  });
});
