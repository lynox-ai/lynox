import { describe, it, expect } from 'vitest';
import { collectWriteNotes } from '../tools/builtin/pipeline.js';
import { UNGRANTED_WRITE_PREFIX, ungrantedWriteNote, writeForShortNote } from './write-notes.js';

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', ...Array.from({ length: 22 }, (_, i) => `X${String.fromCharCode(65 + i)}`)];
const UNTRUSTED = 'The run read external content before this call, and its grant does not cover writes after that.';
const HEADERS = 'which a run under a reviewed grant may not set.';

/** The line as the run report keeps it: what `collectWriteNotes` takes from a refusal. */
function kept(line: string): string {
  const notes = new Set<string>();
  collectWriteNotes(notes)({ toolName: 'http_request', outputJson: `Permission denied (non-interactive): http_request\n${line}` });
  return [...notes][0] ?? '';
}

describe('the line a run report keeps of a refused write', () => {
  // A long path cut the reason off the end of the line (26 methods and a 150-character path came
  // to 364 characters). The URL now gives way, marked, and the reason stays whole.
  it('keeps the reason whole when the path is long; the path is cut at its end and marked', () => {
    const method = writeForShortNote('POST', 'POST', METHODS);
    const url = `https://api.example.com/${'segment/'.repeat(19)}`;
    const line = ungrantedWriteNote(method, url, true, ['X-One', 'X-Two']);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toMatch(/^Not granted for an unattended run: POST \(also naming PUT, PATCH, DELETE and 22 more\) https:\/\/api\.example\.com\/(segment\/)*…\. /);
    expect(line).toContain('…');
    expect(line).toContain(UNTRUSTED);
    expect(line.endsWith(HEADERS)).toBe(true);
    expect(kept(line)).toBe(line);
  });

  // The line is masked after it is built, so a cut inside a segment could keep part of a stored
  // secret that the mask then no longer knows. A segment is kept whole or not at all.
  it('never keeps part of a path segment', () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const line = ungrantedWriteNote('POST', `https://api.example.com/${'hooks/'.repeat(20)}${token}/run`, true, ['X-One', 'X-Two']);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toContain('ghp_');
    expect(line).toMatch(/https:\/\/api\.example\.com\/(hooks\/)+…\. /);
  });

  // The URL may carry a stored value resolved, and the mask knows it only whole: it is masked
  // before the URL is cut, so a value with a `/` of its own is never cut at it. Every length of
  // the path before it is tried, so the line's end falls inside the value at least once.
  it('masks a stored value before it cuts the URL, so no part of it is kept', () => {
    const value = ['Q7x9', 'pL2m', 'Zr4t'].join('/') + 'Vw8k';
    const mask = (t: string): string => t.replaceAll(value, '***');
    for (let pad = 0; pad < 80; pad++) {
      const line = ungrantedWriteNote('POST', `https://api.example.com/${'p'.repeat(pad)}/${value}/run`, true, ['X-One', 'X-Two'], false, mask);
      expect(line.length).toBeLessThanOrEqual(300);
      expect(line).not.toContain('Q7x9');
    }
  });

  it('leaves out a host that holds a stored secret when asked to', () => {
    expect(ungrantedWriteNote('POST', 'https://sk-live-canary.h.example/a', false, undefined, true)).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://(host not shown: its address holds a stored secret)/a.`);
  });

  it('CONTROL: a short path is named whole, unmarked', () => {
    const line = ungrantedWriteNote('POST', 'https://api.example.com/v1/items?token=x', true);
    expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/items. ${UNTRUSTED}`);
    expect(kept(line)).toBe(line);
  });

  it('keeps the start of the URL however long the rest of the line is', () => {
    // Header names of 64 characters leave the URL no room: it keeps scheme, host and its `/`.
    const line = ungrantedWriteNote('POST', `https://api.example.com/${'x'.repeat(200)}`, true, Array.from({ length: 4 }, (_, i) => `X-${String(i)}${'a'.repeat(61)}`));
    expect(line).toMatch(/^Not granted for an unattended run: POST https:\/\/api\.example\.com\/…\./);
  });
});
