/**
 * Every secret scanner that reads outside text stays fast on adversarial input.
 *
 * Measured through the real entry points, not the patterns alone: a scanner that clones a
 * pattern with `new RegExp(p.source, …)` would rebuild a slow regex the pattern list had
 * replaced, and only the entry point shows that. Each input is 128 KB, built from one
 * shape's own prefix and the separators it reacts to; the budget per call is generous.
 */
import { describe, it, expect } from 'vitest';
import {
  maskSecretPatterns, maskSecretsAndPatterns, matchesSecretPattern, matchesSecretPatternStrict,
} from './secret-store.js';
import { detectSecretInContent } from '../tools/builtin/http.js';
import { detectSensitiveContent, scrubErrorMessage } from '../integrations/inbox/sensitive-content.js';
import { maskTokenPatterns } from './debug-subscriber.js';
import { maskSecrets as maskAuditPreview } from './security-audit.js';
import { redactSecrets, VALUE_SECRET_PATTERNS } from './process-capture.js';
import { LinearJwtRegExp, JWT_PROCESS_CAPTURE } from './jwt-scan.js';

const ENTRY_POINTS: ReadonlyArray<readonly [string, (text: string) => unknown]> = [
  ['maskSecretPatterns', (t) => maskSecretPatterns(t)],
  ['maskSecretPatterns + generic', (t) => maskSecretPatterns(t, { includeGeneric: true })],
  ['maskSecretsAndPatterns', (t) => maskSecretsAndPatterns(t, [])],
  ['matchesSecretPattern', (t) => matchesSecretPattern(t)],
  ['matchesSecretPatternStrict', (t) => matchesSecretPatternStrict(t)],
  ['http detectSecretInContent', (t) => detectSecretInContent(t)],
  ['inbox detectSensitiveContent', (t) => detectSensitiveContent({ subject: '', body: t })],
  ['inbox scrubErrorMessage', (t) => scrubErrorMessage(t)],
  ['debug maskTokenPatterns', (t) => maskTokenPatterns(t)],
  ['security-audit preview', (t) => maskAuditPreview(t)],
  ['process-capture redactSecrets', (t) => redactSecrets(t)],
];

// The prefixes the scanners above look for, assembled so no commit scan reads them as keys.
const PREFIXES = [
  'sk-' + 'ant-api03-', 'sk-' + 'proj-', 'sk-', 'sk' + '_live_', 'rk' + '_test_', 'whsec' + '_', 'pk' + '_',
  'gh' + 'p_', 'gh' + 'o_', 'github' + '_pat_', 'AK' + 'IA', 'AI' + 'za', 'xo' + 'xb-', 'xa' + 'pp-', 'shp' + 'at_',
  'ya' + '29.', 'ey' + 'J', 'Bearer ', 'token ', '-----BEGIN ', 'postgres://u:p@', 'tv' + 'ly-',
];
const SIZE = 128 * 1024;
// Wide on purpose: the CI run measures with coverage on, several times slower than a plain
// run, while a quadratic scan takes seconds already at this size.
const BUDGET_MS = 1_000;

function adversarialInputs(): Array<[string, string]> {
  const units: string[] = [];
  for (const p of PREFIXES) units.push(p, p + 'aaa', p + '9'.repeat(12), p + '.', '_' + p + '9', '\\n' + p, p + '-');
  units.push('a', '9', '_', '-', '.', 'a.', '%41', '=', '+/', 'eyJ---', '_eyJ9aaaaaaaaaaaa');
  return units.map((u) => [u, u.repeat(Math.ceil(SIZE / u.length)).slice(0, SIZE)]);
}

describe('secret scanners on adversarial input', () => {
  it(`every entry point answers within ${BUDGET_MS} ms on every 128 KB input`, () => {
    const slow: string[] = [];
    for (const [unit, text] of adversarialInputs()) {
      for (const [name, scan] of ENTRY_POINTS) {
        const started = performance.now();
        scan(text);
        const ms = performance.now() - started;
        if (ms > BUDGET_MS) slow.push(`${name} on ${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 300_000);

  // process-capture scans only the first 10 000 characters of a field, which keeps a slow
  // rule under the budget above — so check the rule itself is the linear-time one.
  it('process-capture uses the linear-time JWT rule', () => {
    const jwt = VALUE_SECRET_PATTERNS.find((p) => p.source === JWT_PROCESS_CAPTURE.regex.source);
    expect(jwt).toBeInstanceOf(LinearJwtRegExp);
  });
});
