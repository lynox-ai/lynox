import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCOPES,
  STANDARD_SCOPES,
  SENSITIVE_EXTRA_SCOPES,
  RESTRICTED_SCOPES,
  FULL_SCOPES,
  FULL_SCOPE_CONSUMERS,
} from './google-auth.js';

/**
 * ⚠ Its own file on purpose. `google-auth.test.ts` mocks `node:fs`, so a
 * source-scan written there reads a stub that answers `false` to every
 * `existsSync` — the check would have failed loudly here and, with the
 * assertion inverted, would have passed against nothing. A test whose
 * instrument the suite has disabled is worse than no test.
 *
 * The claim: `full` is a REQUEST bundle and must stay minimal, because
 * Google's verification requires "the least amount of access … necessary" and
 * a scope no code path exercises is by definition not necessary.
 */
describe('the full-consent bundle stays minimal', () => {
  const ACCEPTED: readonly string[] = [...STANDARD_SCOPES, ...SENSITIVE_EXTRA_SCOPES, ...RESTRICTED_SCOPES];
  const additions = FULL_SCOPES.filter((s) => !(STANDARD_SCOPES as readonly string[]).includes(s));

  it('every scope `full` adds over standard names a consumer', () => {
    expect(additions.sort()).toEqual(Object.keys(FULL_SCOPE_CONSUMERS).sort());
  });

  it('and every named consumer really exists in the tree', () => {
    // Without this the table is prose: an entry could name a deleted file and
    // the equality above would still hold.
    for (const [scope, { file, evidence }] of Object.entries(FULL_SCOPE_CONSUMERS)) {
      const path = fileURLToPath(new URL(`../../../${file}`, import.meta.url));
      expect(existsSync(path), `${scope}: ${file} does not exist`).toBe(true);
      const code = readFileSync(path, 'utf8');
      // Word-anchored: a bare `SCOPES.DRIVE` substring also matches
      // `SCOPES.DRIVE_READONLY`, which would let a deleted gate pass.
      const re = new RegExp(`${evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z_])`);
      expect(re.test(code), `${scope}: ${file} no longer contains ${evidence}`).toBe(true);
    }
  });

  it('the detector can tell a real consumer from a missing one', () => {
    // Positive control on the anchoring, which is the part that could silently
    // over-match, and on the file read itself — this suite must NOT be running
    // against a mocked fs.
    const code = readFileSync(fileURLToPath(new URL('./google-drive.ts', import.meta.url)), 'utf8');
    expect(code.length).toBeGreaterThan(1000);
    expect(/SCOPES\.DRIVE(?![A-Z_])/.test(code)).toBe(true);
    expect(/SCOPES\.GMAIL_COMPOSE(?![A-Z_])/.test(code)).toBe(false);
    expect(existsSync(fileURLToPath(new URL('./no-such-file.ts', import.meta.url)))).toBe(false);
  });

  it('requests none of the scopes that no code path exercises', () => {
    for (const unused of [
      SCOPES.GMAIL_COMPOSE, SCOPES.GMAIL_METADATA, SCOPES.MAIL_GOOGLE_COM,
      SCOPES.CALENDAR_LIST_READONLY, SCOPES.DRIVE_METADATA_READONLY, SCOPES.CALENDAR,
    ]) {
      expect(FULL_SCOPES, `${unused} must not be requested`).not.toContain(unused);
      // …but the acceptance allowlist still holds them, which is the whole
      // reason the classification sets and the request bundle are separate.
      expect(ACCEPTED, `${unused} must still be accepted`).toContain(unused);
    }
  });

  it('the bundle is a strict subset of what is accepted', () => {
    expect(FULL_SCOPES.length).toBeLessThan(ACCEPTED.length);
    for (const s of FULL_SCOPES) expect(ACCEPTED).toContain(s);
  });
});
