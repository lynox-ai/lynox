/**
 * The workflow half of the osv gate.
 *
 * scripts/osv-report-gate.mjs has its own tests, and they prove the gate is
 * CORRECT — not that CI runs it, nor that the binary it runs is the one that was
 * reviewed. Both halves were unguarded: three workflows installed osv-scanner
 * from `releases/latest`, and one of them described itself in a comment as
 * "mirrored verbatim" from another with nothing checking that.
 *
 * So this file asserts across ALL workflows rather than one. A fix that has to
 * be re-applied per copy is cut in the wrong place, and the copy nobody
 * remembers is the one that keeps the defect.
 *
 * The assertions read the shell the way CI does — after stripping comments. That
 * layer is load-bearing rather than tidy: these files discuss `sudo mv` and
 * `|| true` in prose *because* those are the things being removed, so a matcher
 * that cannot tell a command from a sentence about a command reds a correct
 * workflow. The fixture in the first describe block is what proves it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const WORKFLOW_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const ACTION = fileURLToPath(new URL('../.github/actions/install-osv-scanner/action.yml', import.meta.url));
const ACTION_REF = './.github/actions/install-osv-scanner';

type Step = { name?: string; run?: string; with?: Record<string, string>; uses?: string };

function stepsOf(yamlText: string): Step[] {
  const doc = parseYaml(yamlText) as { jobs?: Record<string, { steps?: Step[] }>; runs?: { steps?: Step[] } };
  const fromJobs = Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
  return [...fromJobs, ...(doc.runs?.steps ?? [])];
}

function workflows(): { file: string; text: string; steps: Step[] }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => {
      const text = readFileSync(WORKFLOW_DIR + f, 'utf8');
      return { file: f, text, steps: stepsOf(text) };
    });
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

/** The executable lines of a run block: no comments, no blanks. */
function commands(run: string | undefined): string[] {
  return (run ?? '').split('\n').map(stripComment).map((l) => l.trim()).filter((l) => l.length > 0);
}

const actionStep = (): Step => {
  const doc = parseYaml(readFileSync(ACTION, 'utf8')) as { runs: { steps: Step[] } };
  expect(doc.runs.steps, 'the install action should have exactly one step').toHaveLength(1);
  return doc.runs.steps[0] as Step;
};

const actionInputs = (): Record<string, { default?: string }> =>
  (parseYaml(readFileSync(ACTION, 'utf8')) as { inputs: Record<string, { default?: string }> }).inputs;

describe('the parsing layer these assertions read through', () => {
  it('removes a trailing comment and keeps a `#` that is inside a string', () => {
    expect(stripComment('sudo mv a b # not this one')).toBe('sudo mv a b ');
    expect(stripComment('# whole line')).toBe('');
    expect(stripComment('echo "a # b"')).toBe('echo "a # b"');
    expect(stripComment("echo 'a # b' # tail")).toBe("echo 'a # b' ");
    expect(stripComment('echo "a \\" # b"')).toBe('echo "a \\" # b"');
    expect(stripComment('echo a#b')).toBe('echo a#b');
  });

  it('is what keeps a comment ABOUT a banned command from reading as one', () => {
    // Not hypothetical: the real files below carry both of these phrases in
    // prose. Make stripComment a no-op and this fixture — and then the real
    // assertions — go red on a workflow that is entirely correct.
    const run = [
      '# this used to be: curl -sSfL .../osv-scanner && sudo mv it || true',
      'osv-scanner scan source --lockfile=pnpm-lock.yaml --format=json --output-file=/tmp/osv.json',
    ].join('\n');
    expect(commands(run)).toEqual([
      'osv-scanner scan source --lockfile=pnpm-lock.yaml --format=json --output-file=/tmp/osv.json',
    ]);
    expect(commands(run).some((l) => /\|\|\s*true\s*$/.test(l))).toBe(false);
    expect(commands(run).some((l) => /^sudo mv\b/.test(l))).toBe(false);
  });
});

describe('the install action, which is the only place the pin lives', () => {
  it('downloads a pinned version, never `releases/latest`', () => {
    const curls = commands(actionStep().run).filter((l) => /\bcurl\b/.test(l));
    expect(curls.length).toBeGreaterThan(0);
    for (const c of curls) expect(c).not.toContain('releases/latest');
    expect(curls.some((c) => c.includes('releases/download/v${OSV_SCANNER_VERSION}'))).toBe(true);
    expect(actionInputs().version?.default).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins a 64-hex checksum in the repository and checks it', () => {
    expect(actionInputs().sha256?.default).toMatch(/^[0-9a-f]{64}$/);
    expect(commands(actionStep().run).some((l) => /\bsha256sum -c\b/.test(l))).toBe(true);
  });

  it('verifies provenance against the bundle and the publishing repo', () => {
    const run = commands(actionStep().run).join(' ');
    expect(run).toContain('gh attestation verify');
    // Without --bundle the command queries the attestations API, which 404s for
    // a SLSA-generator artefact: a check that passes for the wrong reason.
    expect(run).toContain('--bundle');
    expect(run).toContain('--repo google/osv-scanner');
  });

  it('does both checks BEFORE the binary reaches PATH', () => {
    const lines = commands(actionStep().run);
    const at = (re: RegExp, what: string): number => {
      const i = lines.findIndex((l) => re.test(l));
      expect(i, `${what} is missing from the install action`).toBeGreaterThan(-1);
      return i;
    };
    const mv = at(/^sudo mv\b/, '`sudo mv`');
    expect(at(/sha256sum -c/, 'the checksum check')).toBeLessThan(mv);
    expect(at(/gh attestation verify/, 'the attestation check')).toBeLessThan(mv);
  });

  it('runs under `set -euo pipefail`, which is what makes those two checks abort', () => {
    // Without it a failed `sha256sum -c` and a failed attestation are both
    // survivable, and the step's status becomes the trailing version grep —
    // which a substituted binary satisfies by printing the expected string.
    expect(commands(actionStep().run)[0]).toBe('set -euo pipefail');
  });

  it('scopes the token to the attestation command, not the whole step', () => {
    const lines = commands(actionStep().run);
    expect(lines.some((l) => /^GH_TOKEN=.*gh attestation verify/.test(l))).toBe(true);
    // A step-wide GH_TOKEN would be in the environment of the third-party
    // binary this step downloads and then executes.
    const doc = parseYaml(readFileSync(ACTION, 'utf8')) as { runs: { steps: { env?: Record<string, string> }[] } };
    expect(Object.keys(doc.runs.steps[0]?.env ?? {})).not.toContain('GH_TOKEN');
  });
});

describe('every workflow that touches osv-scanner', () => {
  const mentions = () => workflows().filter((w) => w.text.includes('osv-scanner'));

  it('is more than one, so this sweep is doing something', () => {
    expect(mentions().length).toBeGreaterThan(1);
  });

  it('installs it only through the shared action', () => {
    for (const w of mentions()) {
      for (const s of w.steps) {
        for (const line of commands(s.run)) {
          expect(line, `${w.file}: installs osv-scanner outside the shared action`)
            .not.toMatch(/curl[^|]*osv-scanner_linux/);
        }
      }
      expect(w.steps.some((s) => s.uses === ACTION_REF), `${w.file}: mentions osv-scanner but never installs it`).toBe(true);
    }
  });

  it('classifies with the shared gate script and never with an inline jq severity rule', () => {
    for (const w of mentions()) {
      const all = w.steps.flatMap((s) => commands(s.run));
      expect(all.some((l) => l.includes('scripts/osv-report-gate.mjs')), `${w.file}: no gate`).toBe(true);
      for (const line of all) {
        expect(line, `${w.file}: an inline severity rule beside the shared one`)
          .not.toContain('database_specific.severity');
      }
    }
  });

  it('hands the captured exit code to the gate, from the file the scan wrote', () => {
    for (const w of mentions()) {
      const lines = w.steps.flatMap((s) => commands(s.run));
      const scan = lines.find((l) => /osv-scanner scan source.*--output-file=/.test(l));
      expect(scan, `${w.file}: no scan writing a report`).toBeDefined();
      const out = /--output-file=(\S+)/.exec(scan as string)?.[1];

      const capture = lines.findIndex((l) => /^OSV_RC=\$\?$/.test(l));
      expect(capture, `${w.file}: the exit code is never captured`).toBeGreaterThan(-1);
      expect(lines[capture - 1], `${w.file}: OSV_RC captures the wrong command`).toBe(scan);

      const gate = lines.find((l) => l.includes('scripts/osv-report-gate.mjs')) as string;
      // `--rc 0` would satisfy a bare `toContain('--rc')` while re-introducing
      // exactly the discarded-exit-code defect this replaced.
      expect(gate, `${w.file}: the gate is not given the captured code`).toMatch(/--rc\s+"\$\{OSV_RC\}"/);
      expect(gate, `${w.file}: the gate reads a different file than the scan wrote`).toContain(`--report ${out}`);
    }
  });

  it('swallows no exit code on an osv-scanner or gate line', () => {
    for (const w of mentions()) {
      for (const s of w.steps) {
        for (const line of commands(s.run)) {
          if (!/osv-scanner|osv-report-gate/.test(line)) continue;
          expect(line, `${w.file}: \`|| true\` on ${line.slice(0, 40)}`).not.toMatch(/\|\|\s*true\s*$/);
        }
      }
    }
  });
});
