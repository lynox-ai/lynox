import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs } from './s3-backfill.js';

describe('s3-backfill parseArgs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults: dry-run, no json, no data-dir override', () => {
    expect(parseArgs([])).toEqual({ apply: false, json: false, dataDir: null });
  });

  it('parses every flag', () => {
    expect(parseArgs(['--apply', '--json', '--data-dir=/srv/.lynox']))
      .toEqual({ apply: true, json: true, dataDir: '/srv/.lynox' });
  });

  it('exits 2 on an unknown arg', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    parseArgs(['--nope']);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 0 on --help', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    parseArgs(['--help']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
