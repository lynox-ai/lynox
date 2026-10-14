/**
 * The run's home: that it is WIRED (this worker's home and engine data dir are the run's own),
 * that the guard refuses every other shape, and that the redirect does what it says.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { RUN_MARKER_ENV, RUN_MARKER_FILE } from '../../scripts/test-run-tmpdir.js';
import {
  HOME_GUARD_RAN, RUN_HOME_DIR, redirectHomeForRun, runHomeViolation, type RunHomeFacts,
} from '../../scripts/test-run-home.js';

describe('the suite runs with its own home', () => {
  it('homedir() and the engine data dir are THIS run’s, proven by the run token', () => {
    const token = process.env[RUN_MARKER_ENV];
    expect(token).toBeTruthy();
    expect(readFileSync(join(tmpdir(), RUN_MARKER_FILE), 'utf8')).toBe(token);
    expect(homedir()).toBe(join(tmpdir(), RUN_HOME_DIR));
    expect(getLynoxDir()).toBe(join(tmpdir(), RUN_HOME_DIR, '.lynox'));
    expect(process.env.LYNOX_DATA_DIR).toBeUndefined();
    expect(process.env.LYNOX_DIR).toBeUndefined();
  });

  it('the guard ran in this worker, so the project still has it in its setupFiles', () => {
    expect((globalThis as Record<symbol, unknown>)[HOME_GUARD_RAN]).toBe(true);
  });
});

describe('runHomeViolation', () => {
  const root = '/r/lynox-test-run-abc';
  const good: RunHomeFacts = {
    home: `${root}/home`,
    lynoxDir: `${root}/home/.lynox`,
    tmp: root,
    token: 't-1',
    readMarker: () => 't-1\n',
  };

  it('lets the run’s own home through', () => {
    expect(runHomeViolation(good)).toBeNull();
  });

  it('refuses a worker that globalSetup never touched', () => {
    expect(runHomeViolation({ ...good, tmp: undefined })).toMatch(/no run root/);
    expect(runHomeViolation({ ...good, token: undefined })).toMatch(/no run root/);
  });

  it('refuses a root without the marker, or with another run’s', () => {
    expect(runHomeViolation({ ...good, readMarker: () => { throw new Error('ENOENT'); } })).toMatch(/carries no run marker/);
    expect(runHomeViolation({ ...good, readMarker: () => 't-2' })).toMatch(/belongs to another run/);
  });

  it('refuses the real home, and a home that only looks like the run’s', () => {
    expect(runHomeViolation({ ...good, home: '/home/someone' })).toMatch(/HOME is \/home\/someone/);
    expect(runHomeViolation({ ...good, home: `${root}/home2` })).toMatch(/not this run's home/);
  });

  it('refuses an engine data dir outside the root, as an inherited LYNOX_DATA_DIR gives', () => {
    expect(runHomeViolation({ ...good, lynoxDir: '/home/someone/.lynox' })).toMatch(/outside this run's root/);
    // The root itself is not inside it.
    expect(runHomeViolation({ ...good, lynoxDir: root })).toMatch(/outside this run's root/);
    expect(runHomeViolation({ ...good, lynoxDir: `${root}-other/.lynox` })).toMatch(/outside this run's root/);
  });
});

describe('redirectHomeForRun', () => {
  it('points HOME into the root and removes both data-dir variables', () => {
    const before = { home: process.env.HOME, data: process.env.LYNOX_DATA_DIR, legacy: process.env.LYNOX_DIR };
    const root = mkdtempSync(join(tmpdir(), 'home-redirect-'));
    try {
      process.env.LYNOX_DATA_DIR = '/elsewhere/data';
      process.env.LYNOX_DIR = '/elsewhere/legacy';
      const home = redirectHomeForRun(root);
      expect(home).toBe(join(root, RUN_HOME_DIR));
      expect(existsSync(home)).toBe(true);
      expect(process.env.HOME).toBe(home);
      expect(homedir()).toBe(home);
      expect(process.env.LYNOX_DATA_DIR).toBeUndefined();
      expect(process.env.LYNOX_DIR).toBeUndefined();
      expect(getLynoxDir()).toBe(join(home, '.lynox'));
    } finally {
      if (before.home === undefined) delete process.env.HOME; else process.env.HOME = before.home;
      if (before.data === undefined) delete process.env.LYNOX_DATA_DIR; else process.env.LYNOX_DATA_DIR = before.data;
      if (before.legacy === undefined) delete process.env.LYNOX_DIR; else process.env.LYNOX_DIR = before.legacy;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
