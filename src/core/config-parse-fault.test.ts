import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readUserConfig } from './config.js';
import { jsonFault } from './json-fault.js';

// Built at run time so the source holds no key-shaped literal.
const KEY = ['sk', 'ant', 'api03', 'PARSEFAULTSECRET0123456789'].join('-');

describe('a config file that does not parse', () => {
  let dir: string;
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-parse-fault-'));
    mkdirSync(dir, { recursive: true });
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the fault without quoting the key, where the parser would quote it', () => {
    // An unquoted value: V8 quotes the text around the unexpected token.
    writeFileSync(join(dir, 'config.json'), `{"api_key": ${KEY}}`);
    expect(() => JSON.parse(`{"api_key": ${KEY}}`)).toThrow(/sk-ant-api/);
    expect(readUserConfig()).toEqual({});
    const line = stderr.join('');
    expect(line).toContain('Failed to parse');
    expect(line).toContain('not valid JSON');
    expect(line).not.toContain('sk-ant');
    expect(line).not.toContain('api_key');
  });

  it('names the key-less position when the parser gives one', () => {
    writeFileSync(join(dir, 'config.json'), `{"api_key": "${KEY}",}`);
    expect(readUserConfig()).toEqual({});
    const line = stderr.join('');
    expect(line).toMatch(/not valid JSON at position \d+ \(line 1 column \d+\)/);
    expect(line).not.toContain('PARSEFAULTSECRET');
  });

  it('names a read failure by its code', () => {
    // A directory in the file's place fails the read for any user, root included.
    mkdirSync(join(dir, 'config.json'));
    expect(readUserConfig()).toEqual({});
    expect(stderr.join('')).toMatch(/Failed to parse .*config\.json: EISDIR\n/);
  });
});

describe('jsonFault', () => {
  it('keeps the position and drops every quoted character', () => {
    const quoted = (() => { try { JSON.parse(KEY); } catch (e) { return e as SyntaxError; } throw new Error('parsed'); })();
    expect(quoted.message).toContain('sk-ant-api');
    expect(jsonFault(quoted)).toBe('not valid JSON');
    expect(jsonFault(new SyntaxError('Unterminated string in JSON at position 62 (line 1 column 63)'))).toBe('not valid JSON at position 62 (line 1 column 63)');
    expect(jsonFault(new SyntaxError('Bad control character in string literal in JSON at position 22'))).toBe('not valid JSON at position 22');
    expect(jsonFault(new SyntaxError('Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)'))).toBe('not valid JSON at position 7 (line 1 column 8)');
    // The same words inside a quote are not a position.
    expect(jsonFault(new SyntaxError('Unexpected token \'a\', "x in JSON at position 7" is not valid JSON'))).toBe('not valid JSON');
  });
});
