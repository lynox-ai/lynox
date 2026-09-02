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
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('the shape the gate refuses to guess at', () => {
  it('does not let a string `groups[].ids` substring-match a finding into a band', () => {
    // `(g?.ids ?? []).includes('A')` on the STRING "zzAzz" is true, and the
    // finding then inherits that group's max_severity. Measured before the fix:
    // an UNRESOLVED — blocking — finding came out as a non-blocking LOW. It is
    // the one shape found here that flips this gate from closed to open.
    const doc = {
      results: [{
        source: { path: 'pnpm-lock.yaml' },
        packages: [{
          package: { name: 'x', version: '1' },
          vulnerabilities: [{ id: 'A', database_specific: { 'malicious-packages-origins': [] }, severity: null }],
          groups: [{ ids: 'zzAzz', max_severity: '1.0' }],
        }],
      }],
    };
    const r = evaluate({ doc, rc: 1 });
    expect(r.ok).toBe(false);
    expect(r.blocking.map((b: { severity: string }) => b.severity)).toEqual(['UNRESOLVED']);
    expect(r.below).toHaveLength(0);
  });

  it('records a drifted nesting level instead of throwing a stack trace at it', () => {
    for (const doc of [
      { results: [{ packages: {} }] },
      { results: [{ packages: [{ package: { name: 'x', version: '1' }, vulnerabilities: 5 }] }] },
      { results: [{ packages: [{ package: { name: 'x', version: '1' }, vulnerabilities: [], groups: 'nope' }] }] },
    ]) {
      const r = evaluate({ doc, rc: 0 });
      expect(r.ok, JSON.stringify(doc)).toBe(false);
      expect(r.errors.join(' ')).toContain('where a list belongs');
    }
  });

  it('treats a NULL list as drift, not as an empty one', () => {
    // `?? []` and a null-tolerant guard both read `null` as "nothing here",
    // which under-counts while the json verdict still shows empty errors — and
    // the daily watch, which reads only counts, then reports all-clear. Same
    // swallow as `results: null`, one level down.
    for (const doc of [
      { results: [{ source: { path: 'p' }, packages: null }] },
      { results: [{ source: { path: 'p' }, packages: [{ package: { name: 'x', version: '1' }, vulnerabilities: null }] }] },
    ]) {
      const r = evaluate({ doc, rc: 0 });
      expect(r.ok, JSON.stringify(doc)).toBe(false);
      expect(r.errors.join(' ')).toContain('where a list belongs');
    }
    // An ABSENT key stays silent — that is the one shape the scanner really
    // emits, and reading it as drift would red every clean run.
    expect(evaluate({ doc: { results: [{ source: { path: 'p' }, packages: [] }] }, rc: 0 }).ok).toBe(true);
  });
});

describe('the contract CI actually depends on', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/osv-report-gate.mjs', import.meta.url));

  function run(doc: unknown, rc: string, extraArgs: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'osv-gate-'));
    const file = join(dir, 'osv.json');
    writeFileSync(file, JSON.stringify(doc));
    return spawnSync(process.execPath, [SCRIPT, '--report', file, '--rc', rc, ...extraArgs], { encoding: 'utf8' });
  }

  it('exits non-zero on a blocking finding and zero on a clean report', () => {
    // Driven as a PROCESS, because the exit status is the whole interface
    // between this script and the workflow. Calling evaluate() directly cannot
    // see `return ok ? 0 : 1` become `return 0`.
    expect(run(MALICIOUS_REPORT, '1').status).toBe(1);
    expect(run({ results: [] }, '0').status).toBe(0);
  });

  it('exits non-zero and says so when the report cannot be read at all', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--report', '/nonexistent/osv.json', '--rc', '0'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot read');
  });

  it('names the blocking finding in the output, not only in the exit code', () => {
    const r = run(MALICIOUS_REPORT, '1');
    expect(r.stderr).toContain('MAL-2023-8697');
    expect(r.stderr).toContain('UNRESOLVED');
  });

  it('keeps the below-floor findings as an annotation, as the step it replaces did', () => {
    // A line in a three-thousand-line log that nobody scrolls to is not a
    // report; the jq step this replaces emitted `::warning::` and losing that
    // silently would be a regression nothing else here would notice.
    const doc = {
      results: [{
        source: { path: 'pnpm-lock.yaml' },
        packages: [{
          package: { name: 'left-pad', version: '1.0.0' },
          vulnerabilities: [{ id: 'GHSA-a-b-c', database_specific: { severity: 'LOW' } }],
          groups: [{ ids: ['GHSA-a-b-c'], max_severity: '2.0' }],
        }],
      }],
    };
    const r = run(doc, '1');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::');
    expect(r.stdout).toContain('below the floor: left-pad@1.0.0 GHSA-a-b-c (LOW)');
  });

  it('refuses a --format it does not implement instead of falling back to prose', () => {
    const r = run({ results: [] }, '0', ['--format=yaml']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--format takes');
  });

  it('emits a machine-readable verdict for the daily watch, with both counts', () => {
    // Both spellings, because the workflow uses one and the first version of
    // parseArgs only understood the other — it ignored the flag and wrote the
    // human report into the file the next step parsed as JSON.
    for (const args of [['--format=json'], ['--format', 'json']]) {
      const r = run(MALICIOUS_REPORT, '1', args);
      const verdict = JSON.parse(r.stdout);
      expect(verdict.blocking, args.join(' ')).toHaveLength(1);
      expect(verdict.below, args.join(' ')).toHaveLength(0);
      expect(r.status).toBe(1);
    }
  });

  it('makes a REFUSAL distinguishable from a clean run in the json verdict', () => {
    // The daily watch reads counts, not an exit code. A refused verdict carries
    // `blocking: []` and `below: []` exactly like a clean tree, so a consumer
    // checking only that those keys EXIST reads "nothing found" and closes its
    // tracking issue. It happened in this PR. `errors` is the field that
    // separates the two — for THIS shape, a `results` that is not a list, which
    // is refused before any count is taken and therefore carries no rc
    // disagreement to fall back on.
    const r = run({ results: null }, '0', ['--format=json']);
    const v = JSON.parse(r.stdout);
    expect(v.blocking).toEqual([]);
    expect(v.below).toEqual([]);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
    expect(r.status).toBe(1);
  });

  it('refuses an option it does not understand rather than ignoring it', () => {
    const r = run({ results: [] }, '0', ['--formt=json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown option');
  });
});
