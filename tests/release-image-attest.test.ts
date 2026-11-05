/**
 * The release image carries build provenance (`.github/workflows/release.yml`, job `docker-attest`).
 *
 * A tag alone does not say which workflow pushed an image: any workflow with `packages: write`
 * can push a tag of the form `X.Y.Z`. The attestation does: Sigstore signs it with the OIDC
 * identity of the workflow that ran, so a verifier can require `release.yml` at a release tag.
 * It names the manifest list's digest, which is what a host records when it pulls the tag, and
 * only after checking that the list holds exactly the manifests of the images this run built.
 *
 * The digest step's REAL `run:` block is run here, taken from the YAML by a parser, with `docker`
 * stubbed so this file controls what each tag and digest resolves to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Step = { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; permissions?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = workflow.jobs['docker-attest']!;
const steps = job.steps;
const attestAt = steps.findIndex((s) => s.uses?.startsWith('actions/attest@'));
const attest = steps[attestAt];
const indexAt = steps.findIndex((s) => s.id === 'index');
const index = steps[indexAt];

const D = (c: string): string => `sha256:${c.repeat(64)}`;
// What this run built: two per-arch indexes, each holding its image and buildx's attestation manifest.
const AMD = D('1');
const ARM = D('2');
const BUILT: Record<string, string[]> = { [AMD]: [D('3'), D('4')], [ARM]: [D('5'), D('6')] };
const OURS = [D('3'), D('4'), D('5'), D('6')];

let root: string;
let counter = 0;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'release-attest-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const list = (digest: string, children: readonly string[]): string =>
  JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', digest, size: 1, manifests: children.map((c) => ({ digest: c })) });

/**
 * Runs the digest step's real `run:` block the way GitHub does. `refs` maps a reference suffix
 * (`:tag` or `@sha256:…`) to what `docker buildx imagetools inspect <ref> --format '{{json .Manifest}}'`
 * prints for it; an unlisted reference fails like an unknown tag. `built` names the digest files
 * the build jobs left.
 */
function runIndex(refs: Record<string, string>, built: readonly string[] = [AMD, ARM]): { status: number | null; outputs: Record<string, string>; stdout: string } {
  const dir = join(root, `run-${counter++}`);
  const bin = join(dir, 'bin');
  const digests = join(dir, 'digests');
  mkdirSync(bin, { recursive: true });
  mkdirSync(digests);
  for (const d of built) writeFileSync(join(digests, d.slice('sha256:'.length)), '');
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(BUILT).map(([d, c]) => [`@${d}`, list(d, c)])),
    ...refs,
  };
  const cases = Object.entries(all).map(([ref, json]) => `    'ghcr.io/lynox-ai/lynox${ref}') echo '${json}' ;;`);
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    '[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 9',
    `[ "$5" = '--format' ] && [ "$6" = '{{json .Manifest}}' ] || exit 9`,
    'case "$4" in',
    ...cases,
    '    *) echo "ERROR: $4: not found" >&2; exit 1 ;;',
    'esac',
  ].join('\n'));
  chmodSync(join(bin, 'docker'), 0o755);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', index!.run!], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      HOME: process.env['HOME'] ?? '',
      RELEASE_TAG: 'v2.19.0',
      SHA: 'abc123',
      DIGESTS: digests,
      GITHUB_OUTPUT: out,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, outputs, stdout: r.stdout };
}

const healthy = (over: Record<string, string> = {}): Record<string, string> => ({
  ':2.19.0': list(D('a'), OURS),
  ':latest': list(D('a'), OURS),
  ':abc123': list(D('a'), OURS),
  ...over,
});

describe('release.yml — the release image is attested', () => {
  it('runs only for a published release, so the signing certificate names a release tag', () => {
    expect(Object.keys(workflow.on)).toEqual(['release']);
    expect(workflow.on['release']).toEqual({ types: ['published'] });
  });

  it('attests in a job of its own, after the tags exist, with actions/attest pinned by commit', () => {
    expect(job.needs).toBe('docker-manifest');
    expect(attest?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
    expect(indexAt).toBeGreaterThanOrEqual(0);
    expect(attestAt).toBeGreaterThan(indexAt);
  });

  it('runs no repository code where the OIDC token is in reach', () => {
    for (const s of steps) {
      expect(s.uses === undefined || /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/.test(s.uses), s.uses).toBe(true);
    }
    expect(steps.map((s) => s.uses?.split('@')[0] ?? 'run')).toEqual([
      'actions/download-artifact', 'docker/login-action', 'run', 'actions/attest',
    ]);
  });

  it('names the image without a tag, the manifest list digest, and pushes the attestation to GHCR', () => {
    expect(attest?.with).toEqual({
      'subject-name': 'ghcr.io/lynox-ai/lynox',
      'subject-digest': '${{ steps.index.outputs.digest }}',
      'push-to-registry': true,
      'create-storage-record': false,
    });
  });

  it('only the attesting job may mint an OIDC token or write attestations, and no workflow-wide grant does', () => {
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write', attestations: 'write' });
    expect(workflow.permissions?.['id-token']).toBeUndefined();
    expect(workflow.permissions?.['attestations']).toBeUndefined();
    for (const [name, other] of Object.entries(workflow.jobs)) {
      if (name === 'docker-attest') continue;
      expect(other.permissions?.['id-token'], name).toBeUndefined();
      expect(other.permissions?.['attestations'], name).toBeUndefined();
    }
  });

  it('attests the digest of the version tag when it holds the images this run built', () => {
    const r = runIndex(healthy());
    expect(r.status).toBe(0);
    expect(r.outputs['digest']).toBe(D('a'));
    expect(r.stdout).not.toContain('::warning::');
  });

  it('accepts the list in any order of its manifests, as the registry returns it', () => {
    // The real 2.17.1 list is not in digest order; the build files come back sorted by name.
    for (const children of [[D('5'), D('6'), D('3'), D('4')], [D('5'), D('3'), D('6'), D('4')], [D('6'), D('5'), D('4'), D('3')]]) {
      const r = runIndex(healthy({ ':2.19.0': list(D('a'), children) }));
      expect(r.status, children.join()).toBe(0);
      expect(r.outputs['digest'], children.join()).toBe(D('a'));
    }
  });

  it('a build digest that is a single image counts as itself', () => {
    const r = runIndex(healthy({
      [`@${AMD}`]: JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: AMD, size: 1 }),
      ':2.19.0': list(D('a'), [AMD, D('5'), D('6')]),
    }));
    expect(r.status).toBe(0);
    expect(r.outputs['digest']).toBe(D('a'));
  });

  it('refuses a version tag moved to a single image, though the image is one this run built', () => {
    const r = runIndex(healthy({ ':2.19.0': JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: D('3'), size: 1 }) }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::2.19.0 does not point at the images this run built');
    expect(r.outputs['digest']).toBeUndefined();
  });

  it('refuses a version tag that points at other images, so a moved tag is not attested', () => {
    for (const children of [[D('3'), D('4'), D('5'), D('7')], [D('3'), D('4')], [...OURS, D('7')], []]) {
      const r = runIndex(healthy({ ':2.19.0': list(D('a'), children) }));
      expect(r.status, children.join()).toBe(1);
      expect(r.stdout).toContain('::error::2.19.0 does not point at the images this run built');
      expect(r.outputs['digest']).toBeUndefined();
    }
  });

  it('refuses when a built image cannot be read, or when not exactly two were built', () => {
    // The first or the last of the two: a failure in the loop's last pipeline fails the
    // assignment, one in an earlier pipeline leaves its children out of the expected set.
    // Either of the two, and also when the version tag holds just the other image's manifests,
    // so that what could be read matches what is listed.
    for (const [d, rest] of [[AMD, [D('5'), D('6')]], [ARM, [D('3'), D('4')]]] as const) {
      for (const tag of [OURS, rest]) {
        const unreadable = runIndex(healthy({ [`@${d}`]: 'not json', ':2.19.0': list(D('a'), tag) }));
        expect(unreadable.status, `${d} ${tag.join()}`).not.toBe(0);
        expect(unreadable.outputs['digest'], d).toBeUndefined();
      }
    }
    // Built images that list nothing, and a version tag on an empty list: equal, and still refused.
    const empty = runIndex(healthy({ [`@${AMD}`]: list(AMD, []), [`@${ARM}`]: list(ARM, []), ':2.19.0': list(D('a'), []) }));
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain('::error::2.19.0 does not point at the images this run built');
    expect(empty.outputs['digest']).toBeUndefined();
    for (const built of [[AMD], [AMD, ARM, D('9')], []]) {
      const r = runIndex(healthy(), built);
      expect(r.status, built.join()).toBe(1);
      expect(r.stdout).toContain('::error::expected the 2 digests this run built');
      expect(r.outputs['digest']).toBeUndefined();
    }
  });

  it('refuses a digest it cannot read, so nothing is attested under a wrong name', () => {
    for (const bad of ['', 'null', 'sha256:abc', `sha512:${'a'.repeat(64)}`, `${D('a')}x`, D('A')]) {
      const r = runIndex(healthy({ ':2.19.0': list(bad, OURS) }));
      expect(r.status, bad).toBe(1);
      expect(r.stdout, bad).toContain('::error::could not read the manifest list digest of 2.19.0');
      expect(r.outputs['digest'], bad).toBeUndefined();
    }
  });

  it('a failed inspect of the version tag fails the step', () => {
    const all = healthy();
    delete all[':2.19.0'];
    const r = runIndex(all);
    expect(r.status).not.toBe(0);
    expect(r.outputs['digest']).toBeUndefined();
  });

  it('warns, and still attests, when latest or the sha tag point elsewhere or cannot be read', () => {
    const all = healthy({ ':latest': list(D('b'), OURS) });
    delete all[':abc123'];
    const r = runIndex(all);
    expect(r.status).toBe(0);
    expect(r.outputs['digest']).toBe(D('a'));
    expect(r.stdout).toContain(`::warning::tag latest points at ${D('b')}, not at the attested ${D('a')} of 2.19.0`);
    expect(r.stdout).toContain(`::warning::tag abc123 points at unreadable`);
  });
});
