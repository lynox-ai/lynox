/**
 * The run's temp root: that it is WIRED, that its cleanup works, and that the hook's teardown
 * really calls it.
 *
 * ⭐ Three of these exist because an adversarial round found them missing AFTER this file shipped,
 * and two were the same mistake in different clothes: a test whose reference its own subject could
 * supply, and a hook whose teardown no test ever called.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import setup from '../../scripts/vitest-global-setup.js';
import {
  RUN_ROOT_PREFIX, RUN_MARKER_FILE, RUN_MARKER_ENV, summariseRunRoot, redirectTmpdirForRun,
} from '../../scripts/test-run-tmpdir.js';

const restoreEnv = (tmp: string | undefined, token: string | undefined): void => {
  if (tmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmp;
  if (token === undefined) delete process.env[RUN_MARKER_ENV];
  else process.env[RUN_MARKER_ENV] = token;
  mkdirSync(tmpdir(), { recursive: true });
};

describe('the suite runs inside its own temp root', () => {
  it('tmpdir() is THIS run’s root — proven by a token, not by the name', () => {
    // ⛔ The prefix alone is NOT enough, measured: remove the redirect and run with `TMPDIR`
    // pointing at any directory whose name carries the prefix, and a prefix-only assertion passes
    // (six green, exit 0). The reference was something the subject could supply. The token cannot
    // be supplied by accident — random per run, and it has to match in two places at once.
    const token = process.env[RUN_MARKER_ENV];
    expect(token).toBeTruthy();
    expect(readFileSync(join(tmpdir(), RUN_MARKER_FILE), 'utf8')).toBe(token);
    // The name still matters for recognising an orphan later, so it is checked too — second, as a
    // consequence rather than as the proof.
    expect(basename(tmpdir()).startsWith(RUN_ROOT_PREFIX)).toBe(true);
  });

  it('a naive mkdtemp lands inside the root, which is the whole point', () => {
    const mine = mkdtempSync(join(tmpdir(), 'wiring-probe-'));
    expect(dirname(mine)).toBe(tmpdir());
    expect(mine.startsWith(tmpdir())).toBe(true);
    rmSync(mine, { recursive: true, force: true });
  });

  it('TMPDIR and tmpdir() agree, so a child process inherits the same root', () => {
    expect(process.env.TMPDIR).toBe(tmpdir());
  });
});

describe('summariseRunRoot distinguishes three outcomes', () => {
  it('removed: counts what the fixtures left, ignoring our own marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarise-'));
    writeFileSync(join(root, RUN_MARKER_FILE), 'token');
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'b.txt'), 'x');
    expect(readdirSync(root)).toHaveLength(3);
    // Two, not three: counting the marker would overstate every leak by exactly one.
    expect(summariseRunRoot(root)).toEqual({ state: 'removed', entries: 2 });
    expect(existsSync(root)).toBe(false);
  });

  it('absent: a root that is already gone is not a leak', () => {
    const root = join(tmpdir(), 'summarise-absent-does-not-exist');
    expect(existsSync(root)).toBe(false);
    expect(summariseRunRoot(root)).toEqual({ state: 'absent', entries: 0 });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'failed: a root that CANNOT be removed is reported as still there', () => {
    // ⛔ The outcome the three-way split exists for. The first version returned the same value here
    // as for `absent` — opposite facts: one leaks nothing, this one leaks everything under it.
    const root = mkdtempSync(join(tmpdir(), 'summarise-stuck-'));
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'held.txt'), 'x');
    chmodSync(locked, 0o500);
    try {
      const outcome = summariseRunRoot(root);
      expect(outcome.state).toBe('failed');
      expect(existsSync(root)).toBe(true);
      if (outcome.state === 'failed') expect(outcome.reason).toBeTruthy();
    } finally {
      chmodSync(locked, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the globalSetup hook', () => {
  it('returns a teardown that ACTUALLY removes the root', () => {
    // ⛔ The mutant this exists for: `return () => { console.error(…) }` without calling
    // `summariseRunRoot`. Every other test stays green, the root is never removed, and "zero growth
    // in /tmp" dies silently. No test could see it, because a teardown runs after the last test —
    // so this one calls the hook itself.
    const before = process.env.TMPDIR;
    const beforeToken = process.env[RUN_MARKER_ENV];
    try {
      const teardown = setup();
      const root = process.env.TMPDIR as string;
      expect(existsSync(root)).toBe(true);
      teardown();
      expect(existsSync(root)).toBe(false);
    } finally {
      restoreEnv(before, beforeToken);
    }
  }, 120_000);

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'THROWS when the root survives, because that is the leak this file exists to stop', () => {
    // ⛔ Make the `failed` branch not throw and every other test stays green: the one state in
    // which the redirect has NOT stopped the leak would be the one state nothing acts on.
    const before = process.env.TMPDIR;
    const beforeToken = process.env[RUN_MARKER_ENV];
    let locked = '';
    try {
      const teardown = setup();
      const root = process.env.TMPDIR as string;
      locked = join(root, 'locked');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'held.txt'), 'x');
      chmodSync(locked, 0o500);
      expect(() => { teardown(); }).toThrow(/survived/);
      // And it really is still there — the message is true, not just alarming.
      expect(existsSync(root)).toBe(true);
    } finally {
      if (locked) { chmodSync(locked, 0o700); rmSync(dirname(locked), { recursive: true, force: true }); }
      restoreEnv(before, beforeToken);
    }
  }, 120_000);
});

describe('redirectTmpdirForRun', () => {
  it('gives each call its OWN root, so two concurrent suites cannot delete each other', () => {
    const before = process.env.TMPDIR;
    const beforeToken = process.env[RUN_MARKER_ENV];
    try {
      // ⚠ Both calls must start from the SAME base: the first already redirects `TMPDIR`, so a
      // second nests under it and the paths differ even with a fixed name. A mutant replacing
      // `mkdtempSync` with a fixed name survived this exact test until the reset was added.
      const base = before ?? tmpdir();
      const a = redirectTmpdirForRun();
      process.env.TMPDIR = base;
      const b = redirectTmpdirForRun();
      expect(a).not.toBe(b);
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    } finally {
      restoreEnv(before, beforeToken);
    }
  });
});
