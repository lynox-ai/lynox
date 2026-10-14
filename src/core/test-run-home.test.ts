/**
 * The run's home: that it is WIRED (this worker's home and engine data dir are the run's own),
 * that the guard refuses every other shape, and that the redirect does what it says.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { RUN_MARKER_ENV, RUN_MARKER_FILE } from '../../scripts/test-run-tmpdir.js';
import {
  HOME_GUARD_RAN, REAL_HOME_ENV, RUN_HOME_DIR, evalOperatorConfig, evalResultsDir, operatorHome, readOperatorConfig,
  redirectHomeForRun, runHomeViolation, type RunHomeFacts,
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

describe('the opt-in harnesses reach the developer’s own home, and only they', () => {
  it('evalResultsDir refuses without LYNOX_EVAL=1, so the normal suite cannot write into a real ~/.lynox', () => {
    expect(() => evalResultsDir({})).toThrow(/LYNOX_EVAL=1/);
    expect(() => evalResultsDir({ LYNOX_EVAL: '0' })).toThrow(/LYNOX_EVAL=1/);
  });

  it('with LYNOX_EVAL=1 it is the results folder under the home the run started with', () => {
    vi.stubEnv(REAL_HOME_ENV, '/operator/home');
    try {
      expect(evalResultsDir({ LYNOX_EVAL: '1' })).toBe('/operator/home/.lynox/knowledge-gold/results');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the run kept the home it started with, and it is not the run’s', () => {
    expect(process.env[REAL_HOME_ENV]).toBeTruthy();
    expect(operatorHome()).toBe(process.env[REAL_HOME_ENV]);
    expect(operatorHome()).not.toBe(homedir());
  });

  it('evalOperatorConfig reads nothing without LYNOX_EVAL=1, though the eval file loads in every run', () => {
    const home = mkdtempSync(join(tmpdir(), 'operator-home-eval-'));
    vi.stubEnv(REAL_HOME_ENV, home);
    try {
      mkdirSync(join(home, '.lynox'));
      writeFileSync(join(home, '.lynox', 'config.json'), '{"anthropic_api_key":"k"}');
      expect(evalOperatorConfig({})).toEqual({});
      expect(evalOperatorConfig({ LYNOX_EVAL: '0' })).toEqual({});
      // Control: the same config IS read when the eval was asked for.
      expect(evalOperatorConfig({ LYNOX_EVAL: '1' })).toEqual({ anthropic_api_key: 'k' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('readOperatorConfig says why there is no config, by path', () => {
    const home = mkdtempSync(join(tmpdir(), 'operator-home-'));
    vi.stubEnv(REAL_HOME_ENV, home);
    try {
      const path = join(home, '.lynox', 'config.json');
      expect(readOperatorConfig()).toEqual({ path, config: null, problem: 'no such file' });
      mkdirSync(join(home, '.lynox'));
      writeFileSync(path, '{ nope');
      expect(readOperatorConfig().problem).toBe('not valid JSON');
      writeFileSync(path, '[1]');
      expect(readOperatorConfig().problem).toBe('not a JSON object');
      writeFileSync(path, '{"api_key":"k"}');
      expect(readOperatorConfig()).toEqual({ path, config: { api_key: 'k' }, problem: null });
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('redirectHomeForRun', () => {
  it('keeps the FIRST home it saw: a second call does not record the run’s home as the real one', () => {
    const before = { home: process.env.HOME, real: process.env[REAL_HOME_ENV] };
    const root = mkdtempSync(join(tmpdir(), 'home-redirect-twice-'));
    try {
      process.env[REAL_HOME_ENV] = '/the/real/home';
      process.env.HOME = '/the/run/home';
      redirectHomeForRun(root);
      expect(process.env[REAL_HOME_ENV]).toBe('/the/real/home');
      delete process.env[REAL_HOME_ENV];
      process.env.HOME = '/first/home';
      const root2 = join(root, 'second');
      mkdirSync(root2);
      redirectHomeForRun(root2);
      expect(process.env[REAL_HOME_ENV]).toBe('/first/home');
    } finally {
      if (before.home === undefined) delete process.env.HOME; else process.env.HOME = before.home;
      if (before.real === undefined) delete process.env[REAL_HOME_ENV]; else process.env[REAL_HOME_ENV] = before.real;
      rmSync(root, { recursive: true, force: true });
    }
  });

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
