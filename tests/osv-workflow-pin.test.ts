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
const ACTION_DIR = fileURLToPath(new URL('../.github/actions/', import.meta.url));
const ACTION = fileURLToPath(new URL('../.github/actions/install-osv-scanner/action.yml', import.meta.url));
const ACTION_REF = './.github/actions/install-osv-scanner';

type Step = {
  name?: string;
  run?: string;
  with?: Record<string, string>;
  uses?: string;
  'continue-on-error'?: boolean | string;
  if?: string;
};
type Job = {
  where: string;
  steps: Step[];
  usesWorkflow: boolean;
  if?: string;
  continueOnError?: boolean | string;
};

/**
 * Every job of every workflow, kept SEPARATE.
 *
 * Flattening a whole file into one step list was the first version, and it
 * proved the wrong thing: with the install action in one job and the scan in
 * another, "this workflow installs it and scans with it" is true of the file
 * and false of anything that runs. A job that delegates to a reusable workflow
 * contributes no steps, so it is flagged rather than counted as empty.
 */
function jobsOf(file: string, yamlText: string): Job[] {
  const doc = parseYaml(yamlText) as {
    jobs?: Record<string, { steps?: Step[]; uses?: string; if?: string; 'continue-on-error'?: boolean | string }>;
  };
  return Object.entries(doc.jobs ?? {}).map(([name, j]) => ({
    where: `${file}:${name}`,
    steps: j.steps ?? [],
    usesWorkflow: typeof j.uses === 'string',
    // Read at JOB level too, because `if:` and `continue-on-error:` exist at
    // both, and the step-level check alone passed on a required gate switched
    // off one level up.
    if: j.if,
    continueOnError: j['continue-on-error'],
  }));
}

/** Workflows AND composite actions — a second action could install it by hand too. */
function allJobs(): Job[] {
  const wf = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap((f) => jobsOf(f, readFileSync(WORKFLOW_DIR + f, 'utf8')));
  const actions = readdirSync(ACTION_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = `${ACTION_DIR}${d.name}/action.yml`;
      const doc = parseYaml(readFileSync(file, 'utf8')) as { runs?: { steps?: Step[] } };
      return { where: `actions/${d.name}`, steps: doc.runs?.steps ?? [], usesWorkflow: false } as Job;
    });
  return [...wf, ...actions];
}

/** The jobs that MUST carry the gate. Named, so deleting one is not "no match". */
const REQUIRED_GATE_JOBS = ['ci.yml:test', 'release.yml:test', 'dep-scan-daily.yml:dep-scan'];
/** The one place allowed to fetch the binary, and the reason the rest may not. */
const SANCTIONED_INSTALLER = 'actions/install-osv-scanner';

/** Anything that runs the binary or installs it, wherever it lives. */
const INSTALLS = /(curl|wget|gh\s+release\s+download)[^|]*osv-scanner/;
/**
 * Exit codes discarded by shell, in the spellings that all mean the same.
 *
 * NOT anchored to end-of-line, and that is the point: `gh attestation verify x
 * || true \` with the flags on continuation lines is a working defang whose
 * `|| true` sits in the middle of the line. An end-anchored version of this
 * survived exactly that mutation.
 */
const SWALLOWS = /\|\|\s*(true|:|exit\s+0)\b/;

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
    const lines = commands(actionStep().run);
    for (const l of lines) expect(l, 'a floating download').not.toContain('releases/latest');
    // Keyed on the ARTEFACT, not on `curl`: swapping in `wget` for the binary
    // left the provenance `curl` behind to satisfy a tool-shaped assertion
    // while the executable itself came down unpinned.
    const binary = lines.filter((l) => l.includes('osv-scanner_linux_amd64'));
    expect(binary, 'nothing in the action fetches the binary').toHaveLength(1);
    expect(binary[0]).toContain('releases/download/v${OSV_SCANNER_VERSION}');
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

describe('every job that touches osv-scanner', () => {
  // Through the stripping layer, like everything else here. Both of these two
  // helpers were written in the same change that added this comment, and both
  // first matched the RAW run text: a comment saying "this used to curl
  // osv-scanner_linux_amd64" then made a correct workflow look like an
  // unsanctioned installer. The failure the layer exists to prevent, in the
  // code documenting it. A control mutation that must stay green pins it.
  const touchesOsv = (s: Step): boolean =>
    commands(s.run).some((l) => INSTALLS.test(l) || /osv-scanner|osv-report-gate/.test(l)) || s.uses === ACTION_REF;

  const touching = () =>
    allJobs()
      .filter((j) => j.where !== SANCTIONED_INSTALLER)
      .filter((j) => j.steps.some(touchesOsv));

  it('leaves exactly one place that fetches the binary', () => {
    const fetchers = allJobs().filter((j) => j.steps.some((s) => commands(s.run).some((l) => INSTALLS.test(l))));
    expect(fetchers.map((j) => j.where)).toEqual([SANCTIONED_INSTALLER]);
  });

  it('is exactly the jobs that are supposed to have it', () => {
    // Anchored to NAMES, not to a filter over the same text the assertions
    // read. Measured on the real file: deleting the gate block from ci.yml's
    // required `test` job left ZERO occurrences of `osv-scanner` in that file,
    // so the file left the derived set and the remaining assertions passed on
    // the two survivors — 13/13 green with the gate gone. A guard that protects
    // the SHAPE of a gate but not its EXISTENCE is the more dangerous half
    // missing. (Deleting only the steps and keeping the prose does NOT
    // reproduce it; the comment is what keeps the file in a text-derived set.)
    expect(touching().map((j) => j.where).sort()).toEqual([...REQUIRED_GATE_JOBS].sort());
  });

  it('has no job that delegates the gate to a reusable workflow this cannot see', () => {
    for (const j of touching()) expect(j.usesWorkflow, `${j.where} is a workflow call`).toBe(false);
  });

  it('installs it only through the shared action', () => {
    for (const j of touching()) {
      for (const s of j.steps) {
        for (const line of commands(s.run)) {
          expect(line, `${j.where}: installs osv-scanner outside the shared action`).not.toMatch(INSTALLS);
        }
      }
      expect(j.steps.some((s) => s.uses === ACTION_REF), `${j.where}: never installs it`).toBe(true);
    }
  });

  it('classifies with the shared gate script and never with an inline severity rule', () => {
    for (const j of touching()) {
      const all = j.steps.flatMap((s) => commands(s.run));
      expect(all.some((l) => l.includes('scripts/osv-report-gate.mjs')), `${j.where}: no gate`).toBe(true);
      for (const line of all) {
        // `database_specific` alone, because `jq '.database_specific | .severity'`
        // is the same rule written to slip past a dotted-path match.
        expect(line, `${j.where}: an inline severity rule beside the shared one`).not.toContain('database_specific');
      }
    }
  });

  it('hands the captured exit code to the gate, from the file the scan wrote', () => {
    for (const j of touching()) {
      const lines = j.steps.flatMap((s) => commands(s.run));
      const scan = lines.find((l) => /osv-scanner scan source.*--output-file=/.test(l));
      expect(scan, `${j.where}: no scan writing a report`).toBeDefined();
      const out = /--output-file=(\S+)/.exec(scan as string)?.[1] as string;

      const capture = lines.findIndex((l) => /^OSV_RC=\$\?$/.test(l));
      expect(capture, `${j.where}: the exit code is never captured`).toBeGreaterThan(-1);
      expect(lines[capture - 1], `${j.where}: OSV_RC captures the wrong command`).toBe(scan);

      const gate = lines.find((l) => l.includes('scripts/osv-report-gate.mjs')) as string;
      // `--rc 0` would satisfy a bare `toContain('--rc')` while re-introducing
      // exactly the discarded-exit-code defect this replaced.
      expect(gate, `${j.where}: the gate is not given the captured code`).toMatch(/--rc\s+"\$\{OSV_RC\}"/);
      // Anchored: `--report /tmp/osv.json.stale` starts with `--report /tmp/osv.json`.
      expect(gate, `${j.where}: the gate reads a different file than the scan wrote`)
        .toMatch(new RegExp(`--report ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`));
    }
  });

  it('makes the watch that only READS the verdict refuse a verdict it cannot trust', () => {
    // dep-scan-daily reports instead of failing, so it reads counts rather than
    // the exit code — and a refusal has the same counts as a clean tree. Its
    // first version checked that the count keys were present, which they always
    // are, and would have closed its tracking issue with "no HIGH/CRITICAL"
    // after a scan that never completed.
    const watch = allJobs().find((j) => j.where === 'dep-scan-daily.yml:dep-scan');
    expect(watch, 'the watch job was renamed; this assertion is now blind').toBeDefined();
    const lines = (watch as Job).steps.flatMap((s) => commands(s.run));
    const consumesCounts = lines.some((l) => /jq .*\.blocking/.test(l));
    expect(consumesCounts, 'the watch no longer reads the verdict; re-aim this test').toBe(true);
    // Pinned to the COMPARISON, because `jq -e '.errors | length >= 0'` reads
    // the field and always succeeds. This is a source-shaped guard and cannot
    // be more than that from here; what proves the semantics is the gate-side
    // test that a refusal carries a non-empty `errors`.
    expect(
      lines.some((l) => /jq -e.*\.errors.*length\s*==\s*0/.test(l)),
      'the watch reads the counts but never requires the error list to be EMPTY',
    ).toBe(true);
    expect(
      lines.some((l) => /jq -e[^|]*has\("blocking"\)/.test(l)),
      'the watch no longer checks that the file is a verdict at all',
    ).toBe(true);
  });

  it('lets no osv step be defanged — by shell, by continue-on-error, or by a condition', () => {
    // Over allJobs(), NOT over touching(): touching() excludes the sanctioned
    // installer, and the one place that checksums and attests the binary was
    // therefore the one place allowed to write `sha256sum -c - || true`.
    for (const j of allJobs()) {
      const osvJob = j.where === SANCTIONED_INSTALLER || touching().some((x) => x.where === j.where);
      if (!osvJob) continue;
      // `continue-on-error: true` is GitHub's own spelling of `|| true`, an
      // `if:` that is never true is a third, and BOTH exist at job level as
      // well as step level — switching the whole job off there left every
      // step-level assertion green.
      expect(j.continueOnError, `${j.where}: continue-on-error on the JOB`).toBeUndefined();
      expect(j.if, `${j.where}: a condition on the JOB`).toBeUndefined();
      for (const s of j.steps) {
        const osv = s.uses === ACTION_REF || commands(s.run).some((l) => /osv-scanner|osv-report-gate|sha256sum|attestation/.test(l));
        if (!osv) continue;
        expect(s['continue-on-error'], `${j.where}: continue-on-error on an osv step`).toBeUndefined();
        expect(s.if, `${j.where}: a condition on an osv step`).toBeUndefined();
        for (const line of commands(s.run)) {
          if (!/osv-scanner|osv-report-gate|sha256sum|gh attestation/.test(line)) continue;
          expect(line, `${j.where}: a discarded exit code on ${line.slice(0, 40)}`).not.toMatch(SWALLOWS);
        }
      }
    }
  });
});
