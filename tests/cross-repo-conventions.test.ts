/**
 * Cross-repo convention pins — the seams that are NOT wire shapes.
 *
 * The wire contract (`src/contract/`) covers request/response bodies. It does
 * not cover the *conventions* the two sides agree on out-of-band: the image
 * tags this repo publishes, the `repository_dispatch` payload the control
 * plane listens for, the container port and health path a tenant is wired to,
 * and the admin scope on the GDPR export route. Those live here, deliberately
 * outside the contract module — vendoring a convention would couple the repos
 * exactly where they are meant to stay decoupled.
 *
 * WHAT THIS FILE DOES: it derives each value from the real artifact — the
 * workflow YAML is parsed and its dispatch step is *executed* against a stubbed
 * `curl`, the Dockerfile is parsed, the route table is the live one the request
 * dispatcher itself reads. It compares that against the pins below. An edit on
 * this side turns it red.
 *
 * WHAT IT CANNOT DO: it cannot see the other repo. Nothing here proves the
 * control plane agrees; this is a change-DETECTOR, not a cross-repo enforcer.
 * Its job is to make a one-sided edit impossible to make *silently* — you have
 * to come here, and the pin tells you a second repo is watching. The twin file
 * pins the same values from the consuming side.
 *
 * WHY EXECUTE THE DISPATCH STEP INSTEAD OF PATTERN-MATCHING IT: the two emit
 * sites build their payload in two different ways (a `jq` filter vs. an escaped
 * JSON string). Any regex that covers both would be a second implementation of
 * shell and jq semantics living in a test — and a regex that crops at the wrong
 * character yields a value that agrees with the assertion by construction. So
 * we run the real step and read what `curl` would actually have been handed.
 * This executes repository shell in-process; that is not a new capability, as
 * the whole point of a test runner is that it executes code from the tree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { LynoxHTTPApi } from '../src/server/http-api.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = resolve(repoRoot, '.github', 'workflows');

// ── The pins ────────────────────────────────────────────────────────────────
// Every value below is also pinned on the consuming side. Changing one here
// without changing it there re-opens the drift this file exists to close.

/** The one image the control plane pulls. */
const PUBLISHED_IMAGE = 'ghcr.io/lynox-ai/lynox';

/**
 * Tags published per channel, as they look *after* shell expansion — i.e. the
 * strings that actually land on the registry, not the `${VAR}` source forms.
 * The control plane validates every tag it is handed against its own charset
 * rule, so the shapes here are what its validator must keep accepting.
 */
const PUBLISHED_TAGS = {
  release: ['latest', '2.10.0', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4'],
  staging: ['staging', 'staging-e3b0c44298fc1c149afbf4c8996fb92427ae41e4'],
} as const;

/** Substitutions used to expand the source tag forms into the strings above. */
const TAG_EXPANSION = {
  VERSION: '2.10.0',
  SHA: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4',
} as const;

/**
 * `repository_dispatch` payloads this repo sends to the control plane.
 * The key set is the contract — a renamed key does not fail any workflow on
 * either side, it just silently stops being read.
 */
const DISPATCH_EMITS = {
  'engine-release-published': ['sha', 'tag', 'version'],
  'engine-image-updated': ['sha', 'tag'],
} as const;

/** Every dispatch goes to this repo and no other. */
const DISPATCH_TARGET = 'https://api.github.com/repos/lynox-ai/lynox-pro/dispatches';

/** Container wiring the control plane writes into every tenant's compose file. */
const CONTAINER_PORT = '3000';
const HEALTH_PATHS = ['/health', '/api/health'] as const;

/** Routes the control plane reaches with the instance admin bearer. */
const ADMIN_SCOPED_ROUTES = ['GET /api/export'] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface WorkflowDoc {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function workflowFiles(): string[] {
  return readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

/** Every step in a workflow, tagged with the file it came from. */
function stepsOf(file: string): Array<{ file: string; step: WorkflowStep }> {
  const doc = parseYaml(readFileSync(join(workflowDir, file), 'utf8')) as WorkflowDoc;
  const out: Array<{ file: string; step: WorkflowStep }> = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) out.push({ file, step });
  }
  return out;
}

function allSteps(): Array<{ file: string; step: WorkflowStep }> {
  return workflowFiles().flatMap(stepsOf);
}

/**
 * A plausible value for a workflow env var, derived from its name. Used to
 * expand the real step; only the two known events get their values asserted,
 * so an unrecognised name still materialises a payload whose *keys* are checked.
 */
function stubEnvValue(name: string): string {
  if (/SHA/.test(name)) return TAG_EXPANSION.SHA;
  if (/TAG/.test(name)) return `v${TAG_EXPANSION.VERSION}`;
  if (/TOKEN|SECRET|PASSWORD/.test(name)) return 'stub-credential';
  if (/VERSION/.test(name)) return TAG_EXPANSION.VERSION;
  return 'stub';
}

/**
 * Run a step's shell with `curl` replaced by a stub that prints what it was
 * handed, and return the parsed dispatch. This is the emitted payload itself,
 * not a reading of the source that produces it.
 */
function materializeDispatch(step: WorkflowStep): { url: string; body: unknown } {
  const stubDir = mkdtempSync(join(tmpdir(), 'lynox-dispatch-pin-'));
  try {
    const stub = join(stubDir, 'curl');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        '# Delimited, because one emit site hands curl pretty-printed JSON: a',
        '# line-oriented protocol here would truncate the body to its first line',
        '# and the parse would fail somewhere far from the cause.',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        "    -d) printf '<<<BODY\\n%s\\n>>>BODY\\n' \"$2\"; shift 2 ;;",
        "    https://*) printf '<<<URL\\n%s\\n>>>URL\\n' \"$1\"; shift ;;",
        '    *) shift ;;',
        '  esac',
        'done',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(stub, 0o755);

    const env: Record<string, string> = {
      PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
      HOME: process.env['HOME'] ?? '',
    };
    for (const name of Object.keys(step.env ?? {})) env[name] = stubEnvValue(name);

    const stdout = execFileSync('bash', ['-c', step.run ?? ''], { env, encoding: 'utf8' });

    const url = /<<<URL\n([\s\S]*?)\n>>>URL/.exec(stdout)?.[1];
    const body = /<<<BODY\n([\s\S]*?)\n>>>BODY/.exec(stdout)?.[1];
    if (url === undefined || body === undefined) {
      throw new Error(`step did not reach curl with a URL and a body; stub saw:\n${stdout}`);
    }
    return { url, body: JSON.parse(body) };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

/** Expand `${VAR}` forms with the pinned substitutions, via the shell itself. */
function expandTags(sourceForms: string[]): string[] {
  const script = sourceForms.map((t) => `printf '%s\\n' "${t}"`).join('\n');
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', ...TAG_EXPANSION };
  return execFileSync('bash', ['-c', script], { env, encoding: 'utf8' }).trim().split('\n');
}

// ── The instrument itself ───────────────────────────────────────────────────
// A sweep that silently finds nothing passes every assertion below it. These
// run first so a broken locator fails loudly instead of vacuously.

describe('pin instrument', () => {
  it('finds the workflow directory and a plausible number of workflows', () => {
    expect(workflowFiles().length).toBeGreaterThan(5);
  });

  it('parses every workflow into jobs with steps', () => {
    for (const file of workflowFiles()) {
      expect(stepsOf(file).length, `${file} yielded no steps`).toBeGreaterThan(0);
    }
  });

  it('resolves shell expansion through the real shell', () => {
    expect(expandTags(['a-${VERSION}', 'plain'])).toEqual([`a-${TAG_EXPANSION.VERSION}`, 'plain']);
  });
});

// ── Seam: repository_dispatch payload ───────────────────────────────────────

describe('dispatch seam', () => {
  /** Steps that POST to the dispatch API, found by sweep — not by name. */
  const emitters = allSteps().filter(({ step }) => /\/dispatches/.test(step.run ?? ''));

  it('sweep finds exactly the emitters the pins cover', () => {
    expect(emitters.length).toBe(Object.keys(DISPATCH_EMITS).length);
  });

  it('every emitted payload matches its pinned key set, and nothing else emits', () => {
    const seen = new Map<string, unknown>();
    for (const { file, step } of emitters) {
      const { url, body } = materializeDispatch(step);
      expect(url, `${file} dispatches somewhere unpinned`).toBe(DISPATCH_TARGET);

      const payload = body as { event_type?: string; client_payload?: Record<string, unknown> };
      const event = payload.event_type;
      expect(event, `${file} emitted no event_type`).toBeDefined();
      expect(Object.keys(DISPATCH_EMITS), `${file} emits unpinned event ${event}`).toContain(event);
      expect(seen.has(event!), `${event} emitted from two places`).toBe(false);
      seen.set(event!, payload.client_payload);

      const pinned = DISPATCH_EMITS[event as keyof typeof DISPATCH_EMITS];
      expect(Object.keys(payload.client_payload ?? {}).sort()).toEqual([...pinned].sort());
    }
    expect([...seen.keys()].sort()).toEqual(Object.keys(DISPATCH_EMITS).sort());
  });

  it('release payload carries the v-stripped version alongside the raw git tag', () => {
    const step = emitters.find(({ step }) => /engine-release-published/.test(step.run ?? ''))?.step;
    expect(step, 'no release emitter found').toBeDefined();
    const { body } = materializeDispatch(step!);
    // The control plane resolves the core ref from `sha`, falling back to
    // `v${version}`. Both spellings have to survive the trip: `tag` keeps the
    // leading `v`, `version` must not.
    expect(body).toEqual({
      event_type: 'engine-release-published',
      client_payload: {
        version: TAG_EXPANSION.VERSION,
        tag: `v${TAG_EXPANSION.VERSION}`,
        sha: TAG_EXPANSION.SHA,
      },
    });
  });

  it('staging payload names the floating tag it just moved', () => {
    const step = emitters.find(({ step }) => /engine-image-updated/.test(step.run ?? ''))?.step;
    expect(step, 'no staging emitter found').toBeDefined();
    const { body } = materializeDispatch(step!);
    expect(body).toEqual({
      event_type: 'engine-image-updated',
      client_payload: { sha: TAG_EXPANSION.SHA, tag: 'staging' },
    });
  });
});

// ── Seam: published image tags ──────────────────────────────────────────────

describe('image tag seam', () => {
  /** Tag source forms from the steps that actually create registry manifests. */
  function manifestTags(file: string): string[] {
    const steps = stepsOf(file).filter(({ step }) => /imagetools create/.test(step.run ?? ''));
    expect(steps.length, `${file} has no manifest-creating step`).toBe(1);
    const run = steps[0]!.step.run ?? '';
    const forms = [...run.matchAll(/ghcr\.io\/lynox-ai\/lynox:([^\s"]+)/g)].map((m) => m[1]!);
    expect(forms.length, `${file} manifest step lists no tags`).toBeGreaterThan(0);
    return [...new Set(forms)];
  }

  it('release publishes exactly the pinned tags', () => {
    expect(expandTags(manifestTags('release.yml')).sort()).toEqual([...PUBLISHED_TAGS.release].sort());
  });

  it('staging publishes exactly the pinned tags', () => {
    expect(expandTags(manifestTags('staging.yml')).sort()).toEqual([...PUBLISHED_TAGS.staging].sort());
  });

  it('every published tag names the one image the control plane pulls', () => {
    for (const file of ['release.yml', 'staging.yml']) {
      const steps = stepsOf(file).filter(({ step }) => /imagetools create/.test(step.run ?? ''));
      const run = steps[0]!.step.run ?? '';
      const images = [...run.matchAll(/(ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+)[:@]/g)].map((m) => m[1]!);
      expect(images.length, `${file} references no image`).toBeGreaterThan(0);
      expect([...new Set(images)]).toEqual([PUBLISHED_IMAGE]);
    }
  });
});

// ── Seam: container wiring ──────────────────────────────────────────────────

describe('container seam', () => {
  const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');

  it('serves on the port the tenant compose file routes to', () => {
    // The code default is a different port; the container listens on this one
    // only because the image sets the env var. That makes the Dockerfile — not
    // the source default — the value the control plane is coupled to.
    expect(dockerfile).toMatch(new RegExp(`^ENV LYNOX_HTTP_PORT=${CONTAINER_PORT}$`, 'm'));
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE ${CONTAINER_PORT}$`, 'm'));
  });

  it('answers on both health spellings', () => {
    // Container probes use the bare path, the control plane uses the /api one.
    // They are one handler; dropping either alternative breaks a different half
    // of the fleet, and neither half is exercised by the other's tests.
    const api = readFileSync(resolve(repoRoot, 'src', 'server', 'http-api.ts'), 'utf8');
    const guard = /pathname === '\/health' \|\| pathname === '\/api\/health'/.exec(api);
    expect(guard, 'health guard not found in http-api.ts').not.toBeNull();
    for (const path of HEALTH_PATHS) {
      expect(guard![0]).toContain(`'${path}'`);
    }
  });

  it('probes the health path it serves', () => {
    const healthcheck = /^HEALTHCHECK[\s\S]*?\n(?!\s)/m.exec(dockerfile)?.[0] ?? '';
    expect(healthcheck, 'no HEALTHCHECK in Dockerfile').not.toBe('');
    expect(healthcheck).toContain(HEALTH_PATHS[0]);
  });
});

// ── Seam: admin-scoped routes the control plane calls ───────────────────────

describe('export route seam', () => {
  /** The live route table, read the way the request dispatcher reads it. */
  function lookupScope(method: string, pathname: string): string | null {
    const api = new LynoxHTTPApi();
    const priv = api as unknown as {
      engine: unknown;
      _registerRoutes: () => void;
      _lookupRouteScope: (m: string, p: string) => string | null;
    };
    priv.engine = {};
    priv._registerRoutes();
    return priv._lookupRouteScope(method, pathname);
  }

  it('the routes the control plane proxies are admin-scoped', () => {
    for (const route of ADMIN_SCOPED_ROUTES) {
      const [method, path] = route.split(' ') as [string, string];
      expect(lookupScope(method, path), `${route} is not admin-scoped`).toBe('admin');
    }
  });

  it('admin is not simply what every route gets', () => {
    // Without this, the assertion above would survive a change that made the
    // whole surface admin-scoped — which would lock every tenant out of their
    // own instance while this test stayed green.
    expect(lookupScope('GET', '/api/threads')).toBe('user');
  });

  it('an unrouted path resolves to no scope', () => {
    expect(lookupScope('GET', '/api/definitely-not-a-route')).toBeNull();
  });
});
