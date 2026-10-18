import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The release image scan can see the OS packages it is meant to judge.
 *
 * trivy reads the installed OS packages from the dpkg status. A hardening step that
 * deletes /var/lib/dpkg leaves those packages on disk and makes them invisible: the
 * scan then reports zero OS findings, which reads exactly like a clean image. Two
 * layers hold against that:
 *   - the release workflow MEASURES it: a step lists what trivy saw and fails on zero
 *     OS packages. That catches every way of hiding them, including ones no text
 *     check knows;
 *   - this file reads the text, so the mistake fails in a pull request, before a
 *     release. The text check is a proxy and knows only the forms in `deletesDpkgStatus`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');

type Step = { name?: string; uses?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown; with?: Record<string, unknown> };
type Job = { if?: unknown; 'continue-on-error'?: unknown; strategy?: { matrix?: { include?: { platform?: string }[] } }; steps?: Step[] };
const release = parseYaml(readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8')) as { jobs: Record<string, Job> };

/** The Dockerfile's shell text: comments dropped, continuations joined. */
function shellText(text: string): string {
  return text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').replace(/\\\n/g, ' ');
}

/** `a{b,c}d` → [abd, acd], one level deep (what a Dockerfile writer reaches for). */
function expandBraces(token: string): string[] {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(token);
  return m ? m[2]!.split(',').flatMap((alt) => expandBraces(`${m[1]}${alt}${m[3]}`)) : [token];
}

function globMatches(glob: string, path: string): boolean {
  const re = glob.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}/?$`).test(path);
}

/**
 * Whether a shell command segment deletes or empties the dpkg status. Forms known: `rm`
 * (also as `/bin/rm`, behind `then`/`do`, inside `sh -c "…"`, after `RUN --mount=…`),
 * `find … -delete` (or `-exec rm`), `mv`, `truncate`, `shred`, `unlink`, a redirect onto it;
 * a path given literally, quoted, as a glob or with braces; a recursive delete of a parent
 * (`/var/lib`, `/var/*`). Not known: a relative path after `cd`, a path built from a
 * variable — the workflow step is what catches those.
 */
function deletesDpkgStatus(segment: string): boolean {
  const text = segment.replace(/["']/g, '');
  const words = text.trim().split(/\s+/);
  const commands = words.map((w) => w.replace(/^.*\//, ''));
  const rm = commands.includes('rm');
  const recursive = (rm && words.some((w) => /^-[a-zA-Z]*[rR]/.test(w)))
    || (commands.includes('find') && /\s-delete\b/.test(text));
  const removes = rm || recursive || ['mv', 'truncate', 'shred', 'unlink'].some((c) => commands.includes(c));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const isTarget = (p: string) => ['/var/lib/dpkg', '/var/lib/dpkg/status'].some((t) => globMatches(bare(p), t));
  // A recursive delete of a parent takes the status with it; any other form acts on its own path.
  const isParent = (p: string) => ['/', '/var', '/var/lib'].some((a) => globMatches(bare(p), a));
  // Any redirect onto the status empties it, whichever stream (`>`, `>>`, `2>`).
  const redirected = [...text.matchAll(/>{1,2}\s*(\/\S+)/g)].flatMap((m) => expandBraces(m[1]!));
  if (redirected.some(isTarget)) return true;
  if (!removes) return false;
  const paths = words.filter((w) => w.startsWith('/')).flatMap(expandBraces);
  return paths.some((p) => isTarget(p) || (recursive && isParent(p)));
}

const AMD64_ONLY = "matrix.platform == 'linux/amd64'";
const GATE_WITH = { 'image-ref': 'ghcr.io/lynox-ai/lynox:scan', format: 'table', 'exit-code': '1', severity: 'CRITICAL', 'ignore-unfixed': true };
const isTrivy = (s: Step) => (s.uses ?? '').startsWith('aquasecurity/trivy-action@');

describe('the image Dockerfile', () => {
  const segments = shellText(dockerfile).split(/&&|\|\||;|\n/);

  it('never deletes the dpkg status a scanner reads the OS packages from', () => {
    expect(segments.filter(deletesDpkgStatus)).toEqual([]);
  });

  it('recognises the deletions it claims to (rm, braces, globs, find, mv, redirect)', () => {
    for (const s of ['rm -rf /var/lib/dpkg', 'rm -rf /var/lib/dpkg/', 'rm -rf /var/lib/{apt,dpkg}', 'rm -rf /var/lib/*', 'rm -rf /var/lib/dpk?',
      'find /var/lib/dpkg -delete', 'mv /var/lib/dpkg /tmp/x', ': > /var/lib/dpkg/status', 'rm /var/lib/dpkg/status', 'rm -rf /var/lib',
      'RUN --mount=type=cache,target=/var/cache/apt rm -rf /var/lib/dpkg', 'rm -rf "/var/lib/dpkg"', '/bin/rm -rf /var/lib/dpkg',
      ' then rm -rf /var/lib/dpkg', 'sh -c "rm -rf /var/lib/dpkg"', 'rm -rf /var/*', 'find /var/lib -exec rm -rf {} +', 'echo x 2>/var/lib/dpkg/status']) {
      expect({ s, caught: deletesDpkgStatus(s) }).toEqual({ s, caught: true });
    }
    for (const s of ['rm -rf /var/lib/apt', 'rm -rf /usr/bin/dpkg /usr/bin/dpkg-*', 'ls /var/lib/dpkg', 'find / -perm -4000 -type f -exec chmod u-s {} + 2>/dev/null', 'rm -f /var/lib',
      'ls /var/lib/dpkg > /tmp/list', 'cp -r /var/lib/dpkg /tmp/x', 'RUN --mount=type=cache,target=/var/lib/apt apt-get update']) {
      expect({ s, caught: deletesDpkgStatus(s) }).toEqual({ s, caught: false });
    }
  });

  it('removes perl through dpkg, so the database stops listing it', () => {
    expect(segments.some((r) => /^\s*RUN dpkg --purge\b.*\bperl-base\b/.test(r))).toBe(true);
  });

  it('removes the package managers bundled with the base image (npm, corepack, yarn)', () => {
    const removed = segments.filter((r) => /\brm\b/.test(r)).join(' ').split(/\s+/);
    for (const p of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack', '/usr/local/bin/npm', '/usr/local/bin/npx',
      '/usr/local/bin/corepack', '/opt/yarn-v*', '/usr/local/bin/yarn', '/usr/local/bin/yarnpkg']) {
      expect({ p, removed: removed.includes(p) }).toEqual({ p, removed: true });
    }
  });

  it('pins every base image by digest', () => {
    const froms = shellText(dockerfile).split('\n').filter((l) => l.startsWith('FROM '));
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f).toMatch(/@sha256:[0-9a-f]{64}\b/);
  });
});

describe('the release scan', () => {
  const entry = Object.entries(release.jobs).find(([, j]) => (j.steps ?? []).some(isTrivy));
  const job = entry?.[1];
  const steps = job?.steps ?? [];

  it('runs in a job that cannot be skipped or let through, on an amd64 leg', () => {
    expect(job).toBeDefined();
    expect(job!.if).toBeUndefined();
    expect(job!['continue-on-error']).toBeUndefined();
    expect((job!.strategy?.matrix?.include ?? []).map((i) => i.platform)).toContain('linux/amd64');
  });

  it('builds the image and scans exactly it, at the release threshold, with nothing switched off', () => {
    const build = steps.find((s) => s.with?.load === true && s.with?.tags === 'ghcr.io/lynox-ai/lynox:scan');
    const gates = steps.filter((s) => isTrivy(s) && s.with?.format === 'table');
    expect(build).toBeDefined();
    expect(gates).toHaveLength(1);
    expect(gates[0]!.with).toEqual(GATE_WITH);
    for (const s of [build!, gates[0]!]) {
      expect(s.if).toBe(AMD64_ONLY);
      expect(s['continue-on-error']).toBeUndefined();
    }
  });

  it('fails when the scan saw no OS packages', () => {
    const list = steps.find((s) => isTrivy(s) && s.with?.['list-all-pkgs'] === true);
    expect(list?.with).toMatchObject({ 'image-ref': 'ghcr.io/lynox-ai/lynox:scan', format: 'json', output: 'trivy-packages.json' });
    const check = steps.find((s) => (s.run ?? '').includes('trivy-packages.json'));
    expect(check?.run).toMatch(/select\(\.Class == "os-pkgs"\)/);
    expect(check?.run).toMatch(/if \[ "\$n" -eq 0 \]; then[\s\S]*exit 1/);
    for (const s of [list!, check!]) {
      expect(s.if).toBe(AMD64_ONLY);
      expect(s['continue-on-error']).toBeUndefined();
    }
  });
});
