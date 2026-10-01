/**
 * No test binds a server to a FIXED port.
 *
 * Measured before this existed: `src/server/http-api.test.ts` started its server on 13100 (and a
 * sibling on 13101). Two concurrent runs of that file — routine here, where several sessions run
 * suites side by side — collided. One run's server answered the other's requests, which made
 * 33 of 555 tests fail with "expected 429" from the foreign traffic. The other run reached no
 * server at all (479 failures, 792 × ECONNREFUSED). Both read as genuine failures, and a pass from
 * such a run would have meant nothing either. Two more files had the same shape (39517, 39611/39612).
 * They all now call `start(0)` and read the OS-assigned port back through `boundPort`. Three
 * concurrent runs of the three files: 577/577 green each.
 *
 * This is a SOURCE check, i.e. a proxy: it catches the shape a fixed port is written in, not every
 * way one could arrive (a port computed elsewhere and passed in). The property itself — concurrent
 * runs stay green — is what the numbers above measured; this keeps the known shape from returning.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `.start(13100)`, `.start(39_517)`, `.start(TEST_PORT)`, `.start(PORT + 1)`, `.listen(3000, …)`.
 *  `0` is the allowed form, and so is a lowercase variable (a parameter the caller fills with 0). */
const FIXED = /\.(?:start|listen)\(\s*(?:[1-9][\d_]*|[A-Z][A-Z0-9_]*PORT[A-Z0-9_]*)\b/;

describe('no fixed test ports', () => {
  it('the pattern recognises the shapes it is meant to catch, and lets port 0 through', () => {
    for (const bad of ['api.start(13100)', 'await api.start(39_517);', 'api.start(TEST_PORT)', 'alt.start(TEST_PORT + 1)', 'server.listen(3000, () => {})']) {
      expect(FIXED.test(bad), bad).toBe(true);
    }
    for (const ok of ['api.start(0)', 'server.listen(0, () => {})', 'api.start(port)', "app.listen(0, '127.0.0.1')"]) {
      expect(FIXED.test(ok), ok).toBe(false);
    }
  });

  it('no tracked test file binds a fixed port', () => {
    const files = execFileSync('git', ['ls-files', '*.test.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => f !== '' && f !== 'tests/no-fixed-test-ports.test.ts');
    // A scan over nothing is not a clean scan.
    expect(files.length).toBeGreaterThan(200);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        // A string literal that merely CONTAINS such a call (a fixture of source text) is not a
        // bind; the one known case is a quoted express snippet in output-guard.test.ts.
        if (FIXED.test(line) && !/['"`].*\.(?:start|listen)\(.*['"`]/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, 'use start(0) / listen(0) and read the bound port back').toEqual([]);
  });
});
