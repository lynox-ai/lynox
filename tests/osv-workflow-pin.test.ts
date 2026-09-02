/**
 * The workflow half of the osv gate.
 *
 * scripts/osv-report-gate.mjs is tested by its own file, and that proves the
 * gate is CORRECT — not that CI runs it, nor that the binary it runs is the one
 * that was reviewed. Both halves were unguarded before: `releases/latest` had
 * fetched a different executable on every run for months, and nothing would
 * have gone red if it were put back.
 *
 * These assertions read the workflow the way CI does — after stripping shell
 * comments. That layer is not a detail: a naive `includes('sudo mv')` matched a
 * mention inside a comment in this file's sibling in lynox-pro, and it failed
 * LOUDLY only by luck. It fails silently in the other direction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string };

function steps(): Step[] {
  const doc = parse(readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  return doc.jobs.test.steps;
}

/** One step, by name prefix — and exactly one, so a duplicate is not silently ignored. */
function step(prefix: string): Step {
  const hits = steps().filter((s) => (s.name ?? '').startsWith(prefix));
  expect(hits, `expected exactly one step named ${prefix}`).toHaveLength(1);
  return hits[0] as Step;
}

/** Drop a trailing `#` comment, respecting quotes so a `#` inside a string survives. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string;
    if (c === '\\' && quote !== "'") { i += 1; continue; }
    if (quote !== null) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) return line.slice(0, i);
  }
  return line;
}

/** The executable lines of a step: no comments, no blanks. */
function commands(run: string): string[] {
  return run.split('\n').map(stripComment).map((l) => l.trim()).filter((l) => l.length > 0);
}

describe('the parsing layer these assertions read through', () => {
  it('removes a trailing comment and keeps a `#` that is inside a string', () => {
    expect(stripComment('sudo mv a b # not this one')).toBe('sudo mv a b ');
    expect(stripComment('# whole line')).toBe('');
    expect(stripComment('echo "a # b"')).toBe('echo "a # b"');
    expect(stripComment("echo 'a # b' # tail")).toBe("echo 'a # b' ");
    expect(stripComment('echo "a \\" # b"')).toBe('echo "a \\" # b"');
    expect(stripComment('echo a#b')).toBe('echo a#b');
  });

  it('sees no command lines in a run block that is only comments', () => {
    expect(commands('# one\n\n  # two\n')).toEqual([]);
  });
});

describe('Install osv-scanner', () => {
  const install = () => step('Install osv-scanner');

  it('downloads a pinned version, never `releases/latest`', () => {
    const lines = commands(install().run ?? '');
    const curls = lines.filter((l) => /\bcurl\b/.test(l));
    expect(curls.length).toBeGreaterThan(0);
    for (const c of curls) expect(c).not.toContain('releases/latest');
    expect(curls.some((c) => c.includes('releases/download/v${OSV_SCANNER_VERSION}'))).toBe(true);
    expect(install().env?.OSV_SCANNER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins a 64-hex checksum in this file and checks it', () => {
    expect(install().env?.OSV_SCANNER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(commands(install().run ?? '').some((l) => /\bsha256sum -c\b/.test(l))).toBe(true);
  });

  it('verifies provenance against the bundle and the publishing repo', () => {
    const run = commands(install().run ?? '').join(' ');
    expect(run).toContain('gh attestation verify');
    // Without --bundle this queries the attestations API, which 404s for a
    // SLSA-generator artefact — a check that measures the wrong thing.
    expect(run).toContain('--bundle');
    expect(run).toContain('--repo google/osv-scanner');
  });

  it('does both checks BEFORE the binary reaches PATH', () => {
    const lines = commands(install().run ?? '');
    const mv = lines.findIndex((l) => /^sudo mv\b/.test(l));
    expect(mv, 'no `sudo mv` line found').toBeGreaterThan(-1);
    expect(lines.findIndex((l) => /sha256sum -c/.test(l))).toBeLessThan(mv);
    expect(lines.findIndex((l) => /gh attestation verify/.test(l))).toBeLessThan(mv);
  });
});

describe('Scan dependencies', () => {
  const scan = () => step('Scan dependencies');

  it('hands the scanner exit code to the gate instead of discarding it', () => {
    const lines = commands(scan().run ?? '');
    expect(lines.some((l) => /OSV_RC=\$\?/.test(l))).toBe(true);
    const gate = lines.find((l) => l.includes('osv-report-gate.mjs'));
    expect(gate, 'the scan step does not run the gate').toBeDefined();
    expect(gate).toContain('--rc');
  });

  it('swallows no exit code in either osv step', () => {
    for (const s of [install_(), scan()]) {
      for (const line of commands(s.run ?? '')) {
        expect(line, `\`|| true\` in step ${s.name}`).not.toMatch(/\|\|\s*true\s*$/);
      }
    }
  });

  it('runs under `set -euo pipefail`', () => {
    expect(commands(scan().run ?? '')[0]).toBe('set -euo pipefail');
  });
});

function install_(): Step {
  return step('Install osv-scanner');
}
