import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { isSameModule, resolveDefaultOrigin } from './index.js';

describe('isSameModule (BI-002 — npx silent-exit on macOS)', () => {
  it('returns false when mainArg is undefined (boot without argv[1])', () => {
    expect(isSameModule('/abs/path/dist/index.js', undefined)).toBe(false);
  });

  it('returns true on exact-string match (no symlinks involved)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lynox-bi002-eq-'));
    try {
      const real = join(tmp, 'index.js');
      writeFileSync(real, '// fake entry\n');
      expect(isSameModule(real, real)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true when argv[1] is a symlink pointing at the realpath of import.meta.url (npm bin shim case)', () => {
    // Simulates the npm-install layout that broke `npx @lynox-ai/core`:
    //   realFile = node_modules/@lynox-ai/core/dist/index.js   (← fileURLToPath result)
    //   shim     = node_modules/.bin/lynox  (symlink → realFile) (← process.argv[1])
    // Strict-equality compared the two strings and always returned false.
    const tmp = mkdtempSync(join(tmpdir(), 'lynox-bi002-symlink-'));
    try {
      const realFile = join(tmp, 'real-entry.js');
      writeFileSync(realFile, '// fake compiled entry\n');
      const shim = join(tmp, 'bin-shim');
      symlinkSync(realFile, shim);
      expect(isSameModule(realFile, shim)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true when import.meta.url resolves via a symlink and argv[1] is the realpath (covers /tmp → /private/tmp on macOS)', () => {
    // Inverse direction: ensures realpath-resolve happens on BOTH sides.
    const tmp = mkdtempSync(join(tmpdir(), 'lynox-bi002-rev-'));
    try {
      const realFile = join(tmp, 'real-entry.js');
      writeFileSync(realFile, '// fake compiled entry\n');
      const aliased = join(tmp, 'aliased');
      symlinkSync(realFile, aliased);
      expect(isSameModule(aliased, realFile)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves the .ts → .js dev-loop heuristic when tsx runs the source file directly', () => {
    // tsx scenario: import.meta.url points at the .ts source, argv[1] at the
    // compiled .js entry. Both paths may not exist on disk simultaneously,
    // so realpath falls back to the literal string and the .ts→.js rewrite
    // still has to win.
    expect(isSameModule('/no/such/path/index.ts', '/no/such/path/index.js')).toBe(true);
  });

  it('returns false for unrelated paths', () => {
    expect(isSameModule('/abs/path/dist/index.js', '/totally/different/script.js')).toBe(false);
  });
});

describe('resolveDefaultOrigin (--http-api boot)', () => {
  it('returns undefined when operator already set ORIGIN (override wins)', () => {
    expect(
      resolveDefaultOrigin({
        origin: 'https://my.example.com',
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBeUndefined();
  });

  it('treats empty-string ORIGIN as unset (don\'t propagate ""):', () => {
    expect(
      resolveDefaultOrigin({
        origin: '',
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('http://localhost:3100');
  });

  it('uses first entry of LYNOX_ALLOWED_ORIGINS when present', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: 'https://a.example.com,https://b.example.com',
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('https://a.example.com');
  });

  it('trims whitespace around the first allowed origin', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: '   https://a.example.com ,https://b.example.com',
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('https://a.example.com');
  });

  it('falls back to http://localhost:<port> when no allowed-origins and no TLS', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 3000,
      }),
    ).toBe('http://localhost:3000');
  });

  it('uses https when LYNOX_TLS_CERT is set', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: undefined,
        tlsCert: '/etc/ssl/cert.pem',
        port: 8443,
      }),
    ).toBe('https://localhost:8443');
  });

  it('skips empty LYNOX_ALLOWED_ORIGINS string and uses localhost fallback', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: '',
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('http://localhost:3100');
  });

  it('uses the resolved port (not the LYNOX_HTTP_PORT default) in the fallback', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 9999,
      }),
    ).toBe('http://localhost:9999');
  });
});
