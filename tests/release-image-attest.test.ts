/**
 * The release image carries build provenance (`.github/workflows/release.yml`, job `docker-manifest`).
 *
 * A tag alone does not say which workflow pushed an image: any workflow with `packages: write`
 * can push a tag of the form `X.Y.Z`. The attestation does: Sigstore signs it with the OIDC
 * identity of the workflow that ran, so a verifier can require `release.yml` at a release tag.
 * It names the manifest list's digest, which is what a host records when it pulls the tag.
 *
 * The digest step's REAL `run:` block is run here, taken from the YAML by a parser, with `docker`
 * stubbed so this file controls what each tag points at.
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
type Job = { permissions?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const job = workflow.jobs['docker-manifest']!;
const steps = job.steps;
const attestAt = steps.findIndex((s) => s.uses?.startsWith('actions/attest@'));
const attest = steps[attestAt];
const indexAt = steps.findIndex((s) => s.id === 'index');
const index = steps[indexAt];
const createAt = steps.findIndex((s) => s.name === 'Create multi-arch manifest');

const D = (c: string): string => `sha256:${c.repeat(64)}`;

let root: string;
let counter = 0;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'release-attest-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/**
 * Runs the digest step's real `run:` block the way GitHub does. `digests` maps a tag to what
 * `docker buildx imagetools inspect <ref> --format '{{json .Manifest}}'` prints for it.
 */
function runIndex(digests: Record<string, string>): { status: number | null; outputs: Record<string, string>; stdout: string } {
  const dir = join(root, `run-${counter++}`);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const cases = Object.entries(digests).map(([tag, d]) => `    'ghcr.io/lynox-ai/lynox:${tag}') echo '${JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', digest: d, size: 1 })}' ;;`);
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    '[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 9',
    `[ "$5" = '--format' ] && [ "$6" = '{{json .Manifest}}' ] || exit 9`,
    'case "$4" in',
    ...cases,
    '    *) exit 7 ;;',
    'esac',
  ].join('\n'));
  chmodSync(join(bin, 'docker'), 0o755);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', index!.run!], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: process.env['HOME'] ?? '', VERSION: '2.19.0', SHA: 'abc123', GITHUB_OUTPUT: out },
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, outputs, stdout: r.stdout };
}

describe('release.yml — the release image is attested', () => {
  it('runs only for a published release, so the signing certificate names a release tag', () => {
    expect(Object.keys(workflow.on)).toEqual(['release']);
    expect(workflow.on['release']).toEqual({ types: ['published'] });
  });

  it('attests with actions/attest, pinned by commit, after the tags exist and the digest is read', () => {
    expect(attest?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(indexAt).toBeGreaterThan(createAt);
    expect(attestAt).toBeGreaterThan(indexAt);
  });

  it('names the image without a tag, the manifest list digest, and pushes the attestation to GHCR', () => {
    expect(attest?.with).toEqual({
      'subject-name': 'ghcr.io/lynox-ai/lynox',
      'subject-digest': '${{ steps.index.outputs.digest }}',
      'push-to-registry': true,
      'create-storage-record': false,
    });
  });

  it('only the attesting job may mint an OIDC token or write attestations', () => {
    expect(job.permissions).toEqual({ contents: 'read', 'packages': 'write', 'id-token': 'write', attestations: 'write' });
    for (const [name, other] of Object.entries(workflow.jobs)) {
      if (name === 'docker-manifest') continue;
      expect(other.permissions?.['id-token'], name).toBeUndefined();
      expect(other.permissions?.['attestations'], name).toBeUndefined();
    }
  });

  it('reads the digest of the version tag', () => {
    const r = runIndex({ '2.19.0': D('a'), latest: D('a'), abc123: D('a') });
    expect(r.status).toBe(0);
    expect(r.outputs['digest']).toBe(D('a'));
    expect(r.stdout).not.toContain('::warning::');
  });

  it('refuses a digest it cannot read, so nothing is attested under a wrong name', () => {
    for (const bad of ['', 'null', 'sha256:abc', `sha512:${'a'.repeat(64)}`, `${D('a')}x`, D('A')]) {
      const r = runIndex({ '2.19.0': bad, latest: D('a'), abc123: D('a') });
      expect(r.status, bad).toBe(1);
      expect(r.stdout, bad).toContain('::error::could not read the manifest list digest of 2.19.0');
      expect(r.outputs['digest'], bad).toBeUndefined();
    }
  });

  it('a failed inspect fails the step', () => {
    const r = runIndex({ latest: D('a'), abc123: D('a') });
    expect(r.status).not.toBe(0);
    expect(r.outputs['digest']).toBeUndefined();
  });

  it('warns when latest or the sha tag point elsewhere, and attests the version tag', () => {
    const r = runIndex({ '2.19.0': D('a'), latest: D('b'), abc123: D('c') });
    expect(r.status).toBe(0);
    expect(r.outputs['digest']).toBe(D('a'));
    expect(r.stdout).toContain(`::warning:::latest points at ${D('b')}`);
    expect(r.stdout).toContain(`::warning:::abc123 points at ${D('c')}`);
  });
});
