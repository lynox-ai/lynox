import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * A script that writes and then calls `process.exit()` loses what it wrote past the first 64 KiB
 * when stdout or stderr is a pipe: writes to a pipe are asynchronous, and `exit()` does not wait
 * for them. `process.exitCode = main()` lets them drain. This file keeps the two entry-point shapes
 * that end a run that way out of the repo's scripts, and runs the entry points that used them
 * through a pipe.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROCESS_TEST_TIMEOUT_MS = 30_000;

/** `process.exit(main(…))`, `process.exit(await main(…))` or the same with `run`. */
const EXIT_AFTER_MAIN = /process\.exit\(\s*(?:await\s+)?(?:main|run)\s*\(/;
/** `main().then((code) => process.exit(code))` or `.then(process.exit)`: the same cut, one tick later. */
const EXIT_IN_THEN = /\.then\(\s*(?:\(?\s*\w+\s*\)?\s*=>\s*process\.exit\(|process\.exit\s*\))/;

function scriptFiles(): string[] {
  const roots = [join(REPO, 'scripts'), ...readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'scripts'))];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(mjs|cjs|js|ts|sh)$/.test(entry.name)) out.push(path);
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  return out;
}

describe('entry points that exit before their output drains', () => {
  it('the patterns find the shapes they are for (positive control)', () => {
    for (const planted of ['  process.exit(main());', 'process.exit(main(process.argv.slice(2)));', 'process.exit( await main(argv) );', 'process.exit(run());']) {
      expect(EXIT_AFTER_MAIN.test(planted), planted).toBe(true);
    }
    for (const fine of ['process.exitCode = main();', 'process.exit(2);', 'const code = mainline(); process.exit(code);', 'process.exit(runner)']) {
      expect(EXIT_AFTER_MAIN.test(fine), fine).toBe(false);
    }
    for (const planted of ['main().then((code) => process.exit(code));', 'run().then(c => process.exit(c))', 'main().then(process.exit);']) {
      expect(EXIT_IN_THEN.test(planted), planted).toBe(true);
    }
    for (const fine of ["main().then((code) => process.stdout.write('', () => process.exit(code)));", 'main().then((code) => { process.exitCode = code; });']) {
      expect(EXIT_IN_THEN.test(fine), fine).toBe(false);
    }
  });

  it('no script under scripts/ or packages/*/scripts/ uses either shape', () => {
    const files = scriptFiles().map((f) => relative(REPO, f));
    // The walk must reach the scripts, or an empty list would pass this check.
    expect(files).toContain('scripts/osv-report-gate.mjs');
    expect(files).toContain('scripts/corpus-structure-guard.mjs');
    const hits = files.filter((f) => {
      const text = readFileSync(join(REPO, f), 'utf8');
      return EXIT_AFTER_MAIN.test(text) || EXIT_IN_THEN.test(text);
    });
    expect(hits).toEqual([]);
  });
});

describe('an entry point read through a pipe arrives whole past 64 KiB', () => {
  const PAD = 300_000;
  let dir: string;
  let pad: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'exit-pipe-'));
    // Loaded before the script: it writes more than one pipe buffer to both streams, so whatever
    // the script then writes, its exit decides whether the reader gets all of it.
    pad = join(dir, 'pad.mjs');
    writeFileSync(pad, `process.stdout.write('x'.repeat(${PAD}) + '\\n');\nprocess.stderr.write('y'.repeat(${PAD}) + '\\n');\n`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  // Each run ends through the script's own refusal (its exit code), and what the script itself
  // wrote, on the stream named, arrives after the padding: both streams past one pipe buffer, whole.
  it.each([
    ['scripts/osv-report-gate.mjs', ['--report', '/nonexistent/osv.json', '--rc', '0'], 1, 'stderr'],
    ['scripts/run-group-starter-guard.mjs', [], 2, 'stderr'],
    ['scripts/added-lines-guard.mjs', [], 2, 'stderr'],
    ['scripts/corpus-structure-guard.mjs', [], 2, 'stderr'],
  ] as const)('%s', (script, args, code, own) => {
    const res = spawnSync(process.execPath, ['--import', pathToFileURL(pad).href, join(REPO, script), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(res.error).toBeUndefined();
    expect(res.status, 'the script ended through its own return').toBe(code);
    expect(res.stdout.length, 'stdout cut at the pipe buffer').toBeGreaterThan(PAD);
    expect(res.stderr.length, 'stderr cut at the pipe buffer').toBeGreaterThan(PAD);
    // The padding is PAD characters and a newline; the script's own words come after it.
    expect(res[own].length, `the script's own ${own} after the padding`).toBeGreaterThan(PAD + 1);
  }, PROCESS_TEST_TIMEOUT_MS);
});
