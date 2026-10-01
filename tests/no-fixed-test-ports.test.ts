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

/** `.start(13100)`, `.start(39_517)`, `.start(PORT)`, `.start(TEST_PORT + 1)`, `.listen(3000, …)`,
 *  `.listen({ port: 3000 })`. `0` is the allowed form, and so is a lowercase variable (a parameter
 *  the caller fills with 0) — which is also this check's blind spot: `boot(39_611)` feeding
 *  `start(port)` was exactly that shape on main, and only the call SITE would show it. */
const FIXED = /\.(?:start|listen)\(\s*(?:[1-9][\d_]*|(?:[A-Z][A-Z0-9_]*)?PORT[A-Z0-9_]*|\{\s*port\s*:\s*[1-9][\d_]*)\b/;

/** True when the match at `index` sits inside a string literal on that line — the one legitimate
 *  non-bind: a test fixture that holds source TEXT (e.g. a quoted express snippet). Counted per
 *  quote kind, so `stubEnv("A","b"); api.start(13100)` is NOT exempt — its quotes are closed. */
function insideString(line: string, index: number): boolean {
  for (const q of ["'", '"', '`']) {
    let open = false;
    for (let i = 0; i < index; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === q) open = !open;
    }
    if (open) return true;
  }
  return false;
}

/** A comment binds nothing: a line that opens as a comment, or a `//` before the match. */
function insideComment(line: string, index: number): boolean {
  if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return true;
  const slashes = line.indexOf('//');
  return slashes !== -1 && slashes < index && !insideString(line, slashes);
}

/** Is this match a real bind — not quoted source text, not a comment? */
function isBind(line: string, index: number): boolean {
  return !insideString(line, index) && !insideComment(line, index);
}

describe('no fixed test ports', () => {
  it('the pattern recognises the shapes it is meant to catch, and lets port 0 through', () => {
    const bad = [
      // The three shapes main actually had, verbatim:
      '  await api.start(TEST_PORT);',
      '  await api.start(PORT);',
      "  b = await boot(39_611, undefined);".replace('boot(', 'x.start('), // the literal at the call site
      // and the obvious neighbours:
      'api.start(13100)', 'alt.start(TEST_PORT + 1)', 'api.start(PORT + 1)', 'server.listen(3000, () => {})',
      'server.listen({ port: 3000 })',
      // closed quotes earlier on the line do not make the call a string:
      'vi.stubEnv("A","b"); await api.start(13100, "x")',
    ];
    for (const b of bad) {
      const m = FIXED.exec(b);
      expect(m !== null && isBind(b, m.index), b).toBe(true);
    }
    for (const ok of ['api.start(0)', 'server.listen(0, () => {})', 'api.start(port)', "app.listen(0, '127.0.0.1')", 'server.listen({ port: 0 })']) {
      expect(FIXED.test(ok), ok).toBe(false);
    }
    // The one legitimate non-bind: source text inside a string.
    const snippet = `'import express from "express";\\nconst app = express();\\napp.listen(3000);',`;
    const m = FIXED.exec(snippet);
    expect(m !== null && !isBind(snippet, m.index), snippet).toBe(true);
    // And a comment that names the old call (oauth-callback-route.test.ts has one) is no bind.
    for (const c of ['  // api.start(PORT)` and close `server`', ' * e.g. api.start(13100)', 'x(); // was api.start(13100)']) {
      const mc = FIXED.exec(c);
      expect(mc !== null && !isBind(c, mc.index), c).toBe(true);
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
        // A call that sits inside a string literal (a fixture of source text) is not a bind; the
        // one known case is a quoted express snippet in output-guard.test.ts.
        const m = FIXED.exec(line);
        if (m !== null && isBind(line, m.index)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, 'use start(0) / listen(0) and read the bound port back').toEqual([]);
  });
});
