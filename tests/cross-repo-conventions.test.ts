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
 * to come here, and the pin tells you a second repo is watching.
 *
 * THE TWIN: `packages/managed/src/cross-repo-conventions.test.ts` in the
 * control-plane repo pins the same values from the consuming side. Neither file
 * can verify the other, so an unnamed twin is the one that gets orphaned —
 * hence the path, spelled out.
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
import { randomBytes } from 'node:crypto';
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

/**
 * The canary channel publishes to the same image but its tags come from GitHub
 * expressions resolved at run time, so they cannot be expanded here. Only the
 * prefixes are pinned — and deliberately nothing more: no control-plane *code*
 * derives or matches a canary tag (they arrive as opaque operator-supplied
 * strings through the admin API), so a tighter pin would assert something no
 * code depends on.
 */
const CANARY_TAG_PREFIXES = ['branch-', 'sha-'] as const;

/** Workflows allowed to push a tagged image, and the channel each one is. */
const PUBLISHING_WORKFLOWS = ['release.yml', 'staging.yml', 'canary-build.yml'] as const;

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
const CONTAINER_PORT = 3000;
const CONTAINER_HOST = '127.0.0.1';
/** Container probes use the bare path; the control plane uses the `/api` one. */
const HEALTH_PATHS = ['/health', '/api/health'] as const;
const HEALTH_METHOD = 'GET';

/** Routes the control plane reaches with the instance admin bearer. */
const ADMIN_SCOPED_ROUTES = ['GET /api/export'] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
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
 * Suffix-anchored so a name ending in one token is not claimed by another it
 * merely contains.
 */
function stubEnvValue(name: string): string {
  if (/SHA$/.test(name)) return TAG_EXPANSION.SHA;
  if (/TAG$/.test(name)) return `v${TAG_EXPANSION.VERSION}`;
  if (/(TOKEN|SECRET|PASSWORD)$/.test(name)) return 'stub-credential';
  if (/VERSION$/.test(name)) return TAG_EXPANSION.VERSION;
  return 'stub';
}

interface DispatchCall {
  url: string;
  body: unknown;
}

/**
 * Run a step's shell with `curl` replaced by a stub that prints what it was
 * handed, and return every dispatch it made. This is the emitted payload
 * itself, not a reading of the source that produces it.
 *
 * The stub frames ONE record per invocation and the caller asserts there is
 * exactly one. Reading a URL and a body as two independent first-matches would
 * silently pair the URL of one call with the body of another — a preflight
 * request to the same host ahead of the real POST is enough to do it.
 *
 * Delimiters carry a per-run nonce because the payload is attacker-shaped in
 * the only sense that matters here: it is arbitrary repository text, and a
 * fixed delimiter appearing inside it would truncate the capture.
 */
function materializeDispatches(step: WorkflowStep): DispatchCall[] {
  const nonce = randomBytes(8).toString('hex');
  const stubDir = mkdtempSync(join(tmpdir(), 'lynox-dispatch-pin-'));
  try {
    const stub = join(stubDir, 'curl');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'URL=""',
        'BODY=""',
        // `shift 2` on a flag that lands last would fail and leave the loop
        // spinning — and the orphaned shell survives the parent's SIGTERM, so
        // it burns a core until the runner is torn down. `|| shift` makes a
        // trailing flag terminate instead.
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        // Consumed before the URL case, so a header value that happens to start
        // with `https://` cannot shadow the real target.
        '    -H|--header|-X|--request|-o|--output) shift 2 2>/dev/null || shift ;;',
        '    -d|--data|--data-raw|--data-binary|--data-ascii) BODY="$2"; shift 2 2>/dev/null || shift ;;',
        '    http://*|https://*) URL="$1"; shift ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        `printf '<<<${nonce}\\n%s\\n---${nonce}\\n%s\\n>>>${nonce}\\n' "$URL" "$BODY"`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(stub, 0o755);

    // Deliberately minimal PATH: the stub, plus the system tools the emit sites
    // genuinely use (jq, coreutils). The sweep that selects steps is textual and
    // therefore over-broad by construction — it will eventually match a step
    // that is not an emitter, and that step must fail fast rather than run the
    // repository's own toolchain. Without this, a step mentioning the dispatch
    // API next to a build command would run the build. The timeout is the
    // backstop for anything that gets past the PATH.
    const env: Record<string, string> = { PATH: `${stubDir}:/usr/bin:/bin` };
    for (const name of Object.keys(step.env ?? {})) env[name] = stubEnvValue(name);

    const stdout = execFileSync('bash', ['-c', step.run ?? ''], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });

    const record = new RegExp(`<<<${nonce}\\n([\\s\\S]*?)\\n---${nonce}\\n([\\s\\S]*?)\\n>>>${nonce}`, 'g');
    const raw = [...stdout.matchAll(record)].map((m) => ({ url: m[1]!, body: m[2]! }));
    // Checked before parsing: a call that carried no body would otherwise
    // surface as a bare JSON SyntaxError with no mention of which step it came
    // from — the failure would be true but unactionable.
    if (raw.length === 0) {
      throw new Error(`step did not reach curl; stub saw:\n${stdout}`);
    }
    for (const { url, body } of raw) {
      if (body === '') throw new Error(`step called ${url || '<no url>'} with no request body`);
    }
    return raw.map(({ url, body }) => ({ url, body: JSON.parse(body) as unknown }));
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

/** The single dispatch a step makes — fails if it makes more than one. */
function materializeDispatch(step: WorkflowStep): DispatchCall {
  const calls = materializeDispatches(step);
  expect(calls.length, 'step made more than one request; only the first would be pinned').toBe(1);
  return calls[0]!;
}

/** Expand `${VAR}` forms with the pinned substitutions, via the shell itself. */
function expandTags(sourceForms: string[]): string[] {
  const script = sourceForms.map((t) => `printf '%s\\n' "${t}"`).join('\n');
  // Same minimal PATH as the dispatch harness. The tag forms come out of a
  // regex over the workflow, and `[^\s"]+` admits `$(…)` — so this expands
  // whatever the file says, and a form that is not a tag should die without a
  // toolchain to reach for rather than run against the full environment.
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', ...TAG_EXPANSION };
  const out = execFileSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 20_000 });
  // Strip only the final newline, never `.trim()`: a tag form referencing an
  // unset variable expands to the empty string, and trimming would drop that
  // entry entirely — so a fourth, unpinned tag reaching the registry would
  // leave the count matching and the comparison green.
  return out.replace(/\n$/, '').split('\n');
}

/** Every `<registry>/<owner>/<name>:<tag>` reference in a chunk of text. */
function imageRefs(text: string): Array<{ image: string; tag: string }> {
  // The registry host is matched generically, not anchored on the expected one:
  // a pattern that can only match `ghcr.io` can never report a second registry.
  // The optional port matters for the same reason — `reg:5000/o/n:t` is a
  // legal reference, and missing it would mean missing exactly the kind of
  // registry someone would add without thinking of this file.
  const pattern = /([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[\w.-]+\/[\w.-]+):([^\s"']+)/g;
  return [...text.matchAll(pattern)].map((m) => ({ image: m[1]!, tag: m[2]! }));
}

/** Steps that push a tagged image, by either mechanism the repo uses. */
function imagePushSteps(): Array<{ file: string; step: WorkflowStep; tagForms: string[] }> {
  const out: Array<{ file: string; step: WorkflowStep; tagForms: string[] }> = [];
  for (const { file, step } of allSteps()) {
    // (a) a manifest stitched by hand in shell
    if (/imagetools create/.test(step.run ?? '')) {
      out.push({ file, step, tagForms: imageRefs(step.run ?? '').map((r) => `${r.image}:${r.tag}`) });
      continue;
    }
    // (b) build-push-action — the canary channel. Invisible to the shell sweep
    // above, which is exactly how a publishing channel goes unpinned: the
    // dispatch seam guards this same blind spot, so the image seam has to too.
    if (/docker\/build-push-action/.test(step.uses ?? '')) {
      const push = step.with?.['push'];
      // Anything that is not an explicit false counts as publishing. Testing
      // for `=== true` would be fail-OPEN: YAML admits `push: 'true'`, and a
      // `${{ … }}` expression is a string either way, so a new channel written
      // in either form would publish while this sweep reported nothing.
      // Absent means the action's own default, which is not to push.
      if (push === undefined || push === false || push === 'false') continue;
      if (typeof push === 'string' && push.includes('${{')) {
        throw new Error(
          `${file}: \`push\` is a workflow expression (${push}) — this pin cannot decide ` +
            'statically whether the step publishes, and guessing "no" would hide a channel',
        );
      }
      const tags = String(step.with?.['tags'] ?? '');
      out.push({ file, step, tagForms: imageRefs(tags).map((r) => `${r.image}:${r.tag}`) });
    }
  }
  return out;
}

// ── The instrument itself ───────────────────────────────────────────────────
// A sweep that silently finds nothing passes every assertion below it. These
// run first so a broken locator fails loudly instead of vacuously.

describe('pin instrument', () => {
  it('finds the workflow directory and a plausible number of workflows', () => {
    expect(workflowFiles().length).toBeGreaterThan(5);
  });

  it('parses every workflow into jobs with steps', () => {
    // Per file, not summed across the directory: a directory-wide total stays
    // comfortably above any threshold while one file silently parses to zero,
    // and that file's seams would then be unpinned with everything green.
    // Reusable-workflow jobs (`jobs.x.uses:`) legitimately have no steps, so
    // a file consisting only of those is skipped rather than failed.
    for (const file of workflowFiles()) {
      const doc = parseYaml(readFileSync(join(workflowDir, file), 'utf8')) as {
        jobs?: Record<string, { steps?: unknown[]; uses?: string }>;
      };
      const jobs = Object.values(doc.jobs ?? {});
      expect(jobs.length, `${file} declares no jobs`).toBeGreaterThan(0);
      if (jobs.every((j) => j.uses !== undefined)) continue;
      expect(stepsOf(file).length, `${file} yielded no steps`).toBeGreaterThan(0);
    }
  });

  it('resolves shell expansion through the real shell', () => {
    expect(expandTags(['a-${VERSION}', 'plain'])).toEqual([`a-${TAG_EXPANSION.VERSION}`, 'plain']);
  });

  it('surfaces an expansion that resolves to nothing', () => {
    // The instrument's own sharpest failure mode: an unset variable expands to
    // the empty string, and a trimming reader would drop it silently.
    expect(expandTags(['${UNSET_ON_PURPOSE}', 'x'])).toEqual(['', 'x']);
  });

  it('reads image references without anchoring on the expected registry', () => {
    expect(imageRefs('docker.io/other/thing:1.0 and ghcr.io/lynox-ai/lynox:latest')).toEqual([
      { image: 'docker.io/other/thing', tag: '1.0' },
      { image: 'ghcr.io/lynox-ai/lynox', tag: 'latest' },
    ]);
  });
});

// ── Seam: repository_dispatch payload ───────────────────────────────────────

describe('dispatch seam', () => {
  /** Steps that POST to the dispatch API, found by sweep — not by name. */
  const emitters = allSteps().filter(({ step }) => /\/dispatches/.test(step.run ?? ''));

  it('sweep finds exactly the emitters the pins cover', () => {
    expect(emitters.length).toBe(Object.keys(DISPATCH_EMITS).length);
  });

  it('no emitter uses a form this pin cannot read', () => {
    // The sweep above reads shell. Two other forms would emit a dispatch that
    // is counted by neither the sweep nor the pins, leaving every assertion
    // here green: a dedicated action declaring its payload in `with:`, and
    // `actions/github-script` calling the REST client — which this repo already
    // uses a few steps below the emitter, for deployments.
    const hidden = allSteps().filter(
      ({ step }) =>
        /repository-dispatch/.test(step.uses ?? '') ||
        (/github-script/.test(step.uses ?? '') &&
          /createDispatchEvent|\/dispatches/.test(String(step.with?.['script'] ?? ''))),
    );
    expect(hidden.map(({ file }) => file)).toEqual([]);
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
  /** Tag source forms from the steps that actually publish, for one workflow. */
  function publishedForms(file: string): string[] {
    const steps = imagePushSteps().filter((s) => s.file === file);
    expect(steps.length, `${file} publishes no image`).toBeGreaterThan(0);
    const forms = steps.flatMap((s) => s.tagForms);
    expect(forms.length, `${file} publishes without naming a tag`).toBeGreaterThan(0);
    return [...new Set(forms)];
  }

  function tagsOnly(file: string): string[] {
    return expandTags(publishedForms(file)).map((ref) => ref.slice(ref.lastIndexOf(':') + 1));
  }

  it('only the pinned workflows publish a tagged image', () => {
    // A new publishing channel is a new tag vocabulary the control plane has
    // never seen. It has to arrive here before it arrives on the registry.
    expect([...new Set(imagePushSteps().map((s) => s.file))].sort()).toEqual(
      [...PUBLISHING_WORKFLOWS].sort(),
    );
  });

  it('release publishes exactly the pinned tags', () => {
    expect(tagsOnly('release.yml').sort()).toEqual([...PUBLISHED_TAGS.release].sort());
  });

  it('staging publishes exactly the pinned tags', () => {
    expect(tagsOnly('staging.yml').sort()).toEqual([...PUBLISHED_TAGS.staging].sort());
  });

  it('canary builds the pinned tag prefixes', () => {
    // Canary's tags reach the push step through `steps.meta.outputs.*`, which
    // only resolves at run time — so what is checkable here is the shell that
    // *builds* them, not the tags that land. Named accordingly: this does not
    // prove the built value is what gets published, only that the vocabulary
    // the operator surface uses is still the one produced.
    const meta = stepsOf('canary-build.yml')
      .map(({ step }) => step.run ?? '')
      .join('\n');
    const built = [...meta.matchAll(/[A-Z_]+_TAG="([a-z]+-)\$\{?[A-Z_]/g)].map((m) => m[1]!);
    expect([...new Set(built)].sort()).toEqual([...CANARY_TAG_PREFIXES].sort());
  });

  it('every publishing channel names the one image the control plane pulls', () => {
    const images = imagePushSteps().flatMap((s) =>
      s.tagForms.map((f) => f.slice(0, f.lastIndexOf(':'))),
    );
    expect(images.length, 'no image references found across publishing steps').toBeGreaterThan(0);
    expect([...new Set(images)]).toEqual([PUBLISHED_IMAGE]);
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

  it('answers on both health spellings, for the method the probes use', () => {
    // Built FROM the pins rather than matched against a hand-written pattern:
    // a regex containing both paths would be satisfied by its own literal, so
    // the loop could never fail. The method belongs in the pin too — flipping
    // it to POST breaks the container probe and the control-plane poll alike,
    // and a path-only pin would not notice.
    const api = readFileSync(resolve(repoRoot, 'src', 'server', 'http-api.ts'), 'utf8');
    const clause = `method === '${HEALTH_METHOD}' && (${HEALTH_PATHS.map(
      (p) => `pathname === '${p}'`,
    ).join(' || ')})`;
    expect(api).toContain(clause);
  });

  it('probes the health path it serves, on the loopback interface', () => {
    const healthcheck = /^HEALTHCHECK[\s\S]*?\n(?!\s)/m.exec(dockerfile)?.[0] ?? '';
    expect(healthcheck, 'no HEALTHCHECK in Dockerfile').not.toBe('');
    const raw = /https?:\/\/\S+/.exec(healthcheck)?.[0];
    expect(raw, 'HEALTHCHECK probes no http URL').toBeDefined();
    // Parsed, not substring-matched: the probe URL carries a `${VAR:-default}`
    // so it has to go through the shell first, and comparing the resolved
    // pathname is what makes `/healthz` a failure — `toContain('/health')`
    // cannot fail on a path that merely starts with it.
    const url = new URL(execFileSync('bash', ['-c', `printf '%s' "${raw!}"`], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 20_000,
    }));
    expect(url.hostname).toBe(CONTAINER_HOST);
    expect(url.port).toBe(String(CONTAINER_PORT));
    expect(url.pathname).toBe(HEALTH_PATHS[0]);
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

  it('the scope is keyed on the method, not the path alone', () => {
    expect(lookupScope('POST', '/api/export')).toBeNull();
  });

  it('the trailing-slash variant keeps the admin scope', () => {
    // The dispatcher's own router 404s this today, but the lookup answers it
    // deliberately: if a future normalisation routes it to the same handler,
    // the admin gate has to already be there.
    expect(lookupScope('GET', '/api/export/')).toBe('admin');
  });

  it('an unrouted path resolves to no scope', () => {
    expect(lookupScope('GET', '/api/definitely-not-a-route')).toBeNull();
  });
});
