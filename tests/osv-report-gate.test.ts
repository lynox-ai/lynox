/**
 * Tests for scripts/osv-report-gate.mjs.
 *
 * The gate this replaces was green on a confirmed malicious package. So the
 * first test is not a unit test of a helper — it is that exact report, captured
 * from osv-scanner 2.5.1 on 2026-09-02, driven through the gate. Every other
 * test names one more thing that would otherwise pass.
 *
 * The rule the whole file is written against: a test that cannot fail is worse
 * than a missing one, because a green check reads as verification.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM CLI, no type declarations by design.
import { evaluate, resolveSeverity, bandForScore } from '../scripts/osv-report-gate.mjs';

const MALICIOUS_REPORT = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/osv-report-malicious.json', import.meta.url)), 'utf8'),
);

/** One finding, shaped like real scanner output, with everything overridable. */
function report(vuln: Record<string, unknown>, group: Record<string, unknown> = {}) {
  return {
    results: [
      {
        source: { path: 'pnpm-lock.yaml', type: 'lockfile' },
        packages: [
          {
            package: { name: 'left-pad', version: '1.0.0', ecosystem: 'npm' },
            vulnerabilities: [{ id: 'GHSA-test-test-test', ...vuln }],
            groups: [{ ids: ['GHSA-test-test-test'], max_severity: '', ...group }],
          },
        ],
      },
    ],
  };
}

describe('the case this gate was built for', () => {
  it('blocks a confirmed malicious package that the old jq counted as moderate/low', () => {
    const r = evaluate({ doc: MALICIOUS_REPORT, rc: 1 });
    expect(r.ok).toBe(false);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].id).toBe('MAL-2023-8697');
    expect(r.blocking[0].severity).toBe('UNRESOLVED');
    // The reason has to reach the log, not just the exit code: the old step
    // ALSO printed this finding — as "not blocking".
    expect(r.blocking[0].package).toBe('@ledgerhq/connect-kit@1.1.7');
  });

  it('is unresolvable for the reason the real entry is unresolvable, not by accident', () => {
    const vuln = MALICIOUS_REPORT.results[0].packages[0].vulnerabilities[0];
    expect(vuln.database_specific.severity).toBeUndefined();
    expect(vuln.severity).toBeNull();
    expect(MALICIOUS_REPORT.results[0].packages[0].groups[0].max_severity).toBe('');
    expect(resolveSeverity(vuln, '')).toBeNull();
  });
});

describe('severity resolution', () => {
  it('reads the named band when the report states one', () => {
    expect(resolveSeverity({ database_specific: { severity: 'CRITICAL' } }, '')).toBe('CRITICAL');
    expect(resolveSeverity({ database_specific: { severity: 'LOW' } }, '')).toBe('LOW');
  });

  it('normalises MEDIUM to MODERATE — OSV uses both spellings for one band', () => {
    expect(resolveSeverity({ database_specific: { severity: 'MEDIUM' } }, '')).toBe('MODERATE');
  });

  it('falls through a CVSS VECTOR to the group score, because a vector has no number in it', () => {
    // Measured 2026-09-02: every `severity[].score` in core's own report is a
    // vector string. A fallback that only parsed this field would never fire.
    const vuln = { severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] };
    expect(bandForScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBeNull();
    expect(resolveSeverity(vuln, '9.8')).toBe('CRITICAL');
    expect(resolveSeverity(vuln, '')).toBeNull();
  });

  it('bands the published CVSS v3 boundaries', () => {
    expect(bandForScore('9.0')).toBe('CRITICAL');
    expect(bandForScore('8.9')).toBe('HIGH');
    expect(bandForScore('7.0')).toBe('HIGH');
    expect(bandForScore('6.9')).toBe('MODERATE');
    expect(bandForScore('4.0')).toBe('MODERATE');
    expect(bandForScore('3.9')).toBe('LOW');
    expect(bandForScore(undefined)).toBeNull();
  });
});

describe('what blocks and what does not', () => {
  it('blocks HIGH and CRITICAL and lets MODERATE and LOW through', () => {
    for (const band of ['HIGH', 'CRITICAL']) {
      const r = evaluate({ doc: report({ database_specific: { severity: band } }), rc: 1 });
      expect(r.ok, band).toBe(false);
      expect(r.blocking.map((b: { severity: string }) => b.severity)).toEqual([band]);
    }
    for (const band of ['MODERATE', 'LOW']) {
      const r = evaluate({ doc: report({ database_specific: { severity: band } }), rc: 1 });
      expect(r.ok, band).toBe(true);
      expect(r.below.map((b: { severity: string }) => b.severity)).toEqual([band]);
    }
  });

  it('takes the band from `groups[].max_severity` when the entry itself has none', () => {
    // Drives the WIRING, not the helper: the group lookup in evaluate() is the
    // only thing that gets that number to resolveSeverity, and a test that
    // calls the helper with the number already in hand cannot see it break.
    const high = evaluate({
      doc: report({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }, { max_severity: '9.8' }),
      rc: 1,
    });
    expect(high.ok).toBe(false);
    expect(high.blocking.map((b: { severity: string }) => b.severity)).toEqual(['CRITICAL']);

    const low = evaluate({ doc: report({}, { max_severity: '2.4' }), rc: 1 });
    expect(low.ok).toBe(true);
    expect(low.below.map((b: { severity: string }) => b.severity)).toEqual(['LOW']);
  });

  it('passes a clean report', () => {
    expect(evaluate({ doc: { results: [] }, rc: 0 }).ok).toBe(true);
  });
});

describe('envelopes that must not read as clean', () => {
  it('refuses `results: null` — Go marshals a nil slice to null, and `[]?` reads it as zero', () => {
    const r = evaluate({ doc: { results: null }, rc: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('results');
  });

  it('refuses a report with no `results` key at all', () => {
    expect(evaluate({ doc: {}, rc: 0 }).ok).toBe(false);
  });
});

describe('the scanner exit code, which the old step discarded', () => {
  it('refuses 127 (unreadable lockfile) and 128 (lockfile yielded no packages)', () => {
    for (const rc of [127, 128]) {
      const r = evaluate({ doc: { results: [] }, rc });
      expect(r.ok, String(rc)).toBe(false);
      expect(r.errors.join(' ')).toContain(String(rc));
    }
  });

  it('names a MISSING exit code as missing, not as "exited undefined"', () => {
    // Both this branch and the 0-or-1 branch refuse an absent rc, so refusal
    // alone cannot tell them apart — delete the dedicated one and the report
    // still goes red, reading `osv-scanner exited undefined`. What the branch
    // is FOR is the sentence, so the sentence is what this asserts.
    const r = evaluate({ doc: { results: [] }, rc: undefined });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('was not handed in');
    expect(r.errors.join(' ')).not.toContain('exited undefined');
  });

  it('refuses a report that disagrees with the exit code in either direction', () => {
    const empty = evaluate({ doc: { results: [] }, rc: 1 });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(' ')).toContain('no findings');

    const found = evaluate({ doc: report({ database_specific: { severity: 'LOW' } }), rc: 0 });
    expect(found.ok).toBe(false);
    expect(found.errors.join(' ')).toContain('exited 0');
  });

  it('reports every reason it refuses, not the first', () => {
    // A run can be wrong in more than one way, and an author who fixes the one
    // error the log showed will simply be red again on the next push.
    const r = evaluate({ doc: { results: null }, rc: 42 });
    expect(r.errors.length).toBeGreaterThan(1);
  });
});
