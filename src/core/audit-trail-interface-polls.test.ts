import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildTrail, INTERFACE_POLLS, INTERFACE_READS, type TrailRow, type TrailSources } from './audit-trail-view.js';

/**
 * Row 1034: `INTERFACE_POLLS` names the routes the web UI polls by itself. It is a list, so it
 * goes stale when a poller is added and nobody enters it. This test holds it against the web UI:
 * every file under `packages/web-ui/src` that starts a timer with `setInterval` is classified here,
 * by what it reads, and every route a poller reads is either in the list or excepted with a reason.
 * A new file with `setInterval` fails until someone decides.
 *
 * What it does not catch: a new read inside a poller file already listed here, and a loop built
 * from `setTimeout` (the one known, in chat.svelte.ts, is entered by hand). A read the list misses
 * is shown ungrouped, as before.
 */
const WEB_UI_SRC = join(__dirname, '..', '..', 'packages', 'web-ui', 'src');

/** `path`: the text after `${getApiBase()}` in the file; `action`: the row it leaves. */
type Read = { readonly path: string; readonly action: string };
type Excepted = Read & { readonly why: string };
type Poller =
  | { readonly reads: readonly Read[]; readonly excepted?: readonly Excepted[] }
  | { readonly readsNothing: string };

/** Keyed by path under `packages/web-ui/src`. `path` is the text after `${getApiBase()}` in the file. */
const POLLERS: Record<string, Poller> = {
  'lib/stores/threads.svelte.ts': { reads: [{ path: '/runs/active', action: 'GET /api/runs/active' }] },
  'lib/components/StatusBar.svelte': {
    reads: [
      { path: '/runs/active', action: 'GET /api/runs/active' },
      { path: '/tasks?status=in_progress', action: 'GET /api/tasks' },
      { path: '/history/cost/daily?days=1', action: 'GET /api/history/cost/daily' },
      { path: '/providers/status', action: 'GET /api/providers/status' },
    ],
    excepted: [{ path: '/health', action: 'GET /api/health', why: 'answered before the routes are dispatched, so it leaves no row' }],
  },
  'lib/stores/approvals.svelte.ts': {
    reads: [],
    excepted: [{ path: '/approvals/count', action: 'GET /api/approvals/count', why: 'polled for the owner only (`viewer !== \'owner\'` stops it); a helper reads it once per mount, with a few retries on failure' }],
  },
  'lib/stores/paused-plans.svelte.ts': {
    reads: [],
    excepted: [{ path: '/triggers/paused-count', action: 'GET /api/triggers/paused-count', why: 'polled for the owner only (`viewer !== \'owner\'` stops it); a helper reads it once per mount, with a few retries on failure' }],
  },
  'lib/components/TriggersView.svelte': {
    reads: [],
    excepted: [{ path: '/triggers', action: 'GET /api/triggers', why: 'polled every 15 s while the triggers view is open and visible; the person opened it, and it stays ungrouped (noise, nothing hidden)' }],
  },
  'lib/stores/integrations/google.svelte.ts': {
    reads: [],
    excepted: [{ path: '/google/status', action: 'GET /api/google/status', why: 'read only during a Google sign-in the person started' }],
  },
  'lib/components/ApiStoreView.svelte': { readsNothing: 'a clock for the "expires in" texts' },
  'lib/components/StoreAccessBanner.svelte': { readsNothing: 'a clock that turns a store\'s end into "ended" while the page is open' },
  'lib/components/ChatView.svelte': { readsNothing: 'clocks for the elapsed time and the voice recording' },
  'lib/components/MigrationWizard.svelte': { readsNothing: 'a clock that opens the retry once the target has released its session' },
  'lib/components/PromptAnchor.svelte': { readsNothing: 'a clock for the question\'s age' },
  'lib/components/StreamingActivityBar.svelte': { readsNothing: 'a clock for the running time' },
  'lib/server/auth.ts': { readsNothing: 'server-side cleanup of expired sessions, not a request' },
  'routes/login/+page.svelte': { readsNothing: 'the countdown of the one-time code' },
};

/** Loops built from `setTimeout`, entered by hand: a text scan cannot find them. All excepted. */
const TIMEOUT_LOOPS: Record<string, readonly Excepted[]> = {
  'lib/stores/chat.svelte.ts': [{
    path: '/sessions/${sessionId}/pending-prompt', action: 'GET /api/sessions/:id/pending-prompt',
    why: 'rechecks every 12 s while a stream runs, but the route takes a session id and answers an open question with its content: grouped, a read of another session would leave the owner\'s first sight',
  }],
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const read = (file: string): string => readFileSync(join(WEB_UI_SRC, file), 'utf-8');

describe('the list of routes the web UI polls by itself', () => {
  it('classifies every web UI file that starts a timer with setInterval', () => {
    const withTimer = sources(WEB_UI_SRC).filter((p) => readFileSync(p, 'utf-8').includes('setInterval(')).map((p) => relative(WEB_UI_SRC, p)).sort();
    // Not empty: the scan reads the tree it is meant to read.
    expect(withTimer).toContain('lib/components/StatusBar.svelte');
    expect(withTimer).toEqual(Object.keys(POLLERS).sort());
  });

  it('each classified read is there in its file', () => {
    const sites: Array<[string, Read]> = [
      ...Object.entries(POLLERS).flatMap(([file, p]) => 'reads' in p ? [...p.reads, ...(p.excepted ?? [])].map((r): [string, Read] => [file, r]) : []),
      ...Object.entries(TIMEOUT_LOOPS).flatMap(([file, reads]) => reads.map((r): [string, Read] => [file, r])),
    ];
    for (const [file, r] of sites) expect(read(file), `${file} reads ${r.path}`).toContain(`\${getApiBase()}${r.path}`);
  });

  it('each read\'s action is its own path\'s route', () => {
    const all = [
      ...Object.values(POLLERS).flatMap((p) => 'reads' in p ? [...p.reads, ...(p.excepted ?? [])] : []),
      ...Object.values(TIMEOUT_LOOPS).flat(),
    ];
    for (const r of all) expect(r.action, r.path).toBe(`GET /api${r.path.split('?')[0]!.replace(/\$\{[^}]+\}/g, ':id')}`);
  });

  it('every read a poller makes is in the list or excepted, and the list holds nothing else', () => {
    const polled = new Set(Object.values(POLLERS).flatMap((p) => 'reads' in p ? p.reads.map((r) => r.action) : []));
    const excepted = [
      ...Object.values(POLLERS).flatMap((p) => 'reads' in p ? (p.excepted ?? []).map((r) => r.action) : []),
      ...Object.values(TIMEOUT_LOOPS).flat().map((r) => r.action),
    ];
    expect([...polled].sort()).toEqual([...INTERFACE_POLLS].sort());
    for (const action of excepted) expect(INTERFACE_POLLS.has(action), action).toBe(false);
  });
});

describe('the reads the web UI makes by itself besides its polls (U-306 B1(b), C)', () => {
  const HTTP_API = readFileSync(join(__dirname, '..', 'server', 'http-api.ts'), 'utf-8');

  it('holds only GET routes without a path parameter, none of them a poll of the status bar or the nav', () => {
    expect(INTERFACE_READS.size).toBeGreaterThan(0);
    for (const action of INTERFACE_READS) {
      expect(action, action).toMatch(/^GET \/api\/[a-z/-]+$/);
      expect(INTERFACE_POLLS.has(action), action).toBe(false);
    }
  });

  it('names routes the engine serves, so a renamed route does not leave a dead entry', () => {
    for (const action of INTERFACE_READS) {
      // A static route (`addStatic(scope, 'GET /api/…'`), as all of them are today.
      expect(new RegExp(`addStatic\\('[a-z]+', '${action}'`).test(HTTP_API), action).toBe(true);
    }
  });

  it('leaves out the reads that name things or are a view the person opens', () => {
    // The chat list carries titles and summaries; the configuration, the plan list and Google's
    // status are also the first load of a view the person opens (decided 2026-11-28).
    for (const action of ['GET /api/threads', 'GET /api/config', 'GET /api/triggers', 'GET /api/google/status']) {
      expect(INTERFACE_READS.has(action), action).toBe(false);
      expect(INTERFACE_POLLS.has(action), action).toBe(false);
    }
  });

  it('marks each of them as read by the interface, and only in the read phase', () => {
    const quiet: TrailSources = {
      runStatus: () => undefined, questionOfRun: () => false, questionInSession: () => false,
      planRunRunning: () => false, bulkRunOpen: () => false, approvalOf: () => undefined, knowledgeStatus: () => undefined,
    };
    let n = 0;
    const rows: TrailRow[] = [...INTERFACE_READS].flatMap((action) => (['read', 'refused'] as const).map((phase) => {
      n++;
      return {
        id: n, ts: `2026-11-28T10:${String(n).padStart(2, '0')}:00.000Z`, actor_kind: 'mandate',
        actor_email: 'ida@example.invalid', actor_display: 'IDA', mandate_id: 'TEST-MANDATE-READS',
        action, target: action.slice(4), phase, correlation_id: `r-${String(n)}`, run_id: null, plan_run: null,
      };
    }));
    const marked = buildTrail(rows, quiet).map((e) => ['phase' in e ? e.phase : '', 'auto' in e ? e.auto === true : false]);
    expect(marked.filter(([p]) => p === 'read').every(([, a]) => a === true)).toBe(true);
    expect(marked.filter(([p]) => p === 'refused').some(([, a]) => a === true)).toBe(false);
    expect(marked).toHaveLength(INTERFACE_READS.size * 2);
  });
});

describe('the mark in the owner\'s view', () => {
  const quiet: TrailSources = {
    runStatus: () => undefined, questionOfRun: () => false, questionInSession: () => false,
    planRunRunning: () => false, bulkRunOpen: () => false, approvalOf: () => undefined, knowledgeStatus: () => undefined,
  };
  let id = 1;
  const row = (action: string, phase: string, target: string | null = action.slice(action.indexOf(' ') + 1)): TrailRow => ({
    id: id++, ts: `2026-10-28T10:${String(id).padStart(2, '0')}:00.000Z`, actor_kind: 'mandate',
    actor_email: 'ida@example.invalid', actor_display: 'IDA', mandate_id: 'TEST-MANDATE-MARK',
    action, target, phase, correlation_id: `c-${String(id)}`, run_id: null, plan_run: null,
  });

  it('marks a listed read, and neither another read nor a listed action in any other phase', () => {
    const entries = buildTrail([
      row('GET /api/runs/active', 'read'),
      row('GET /api/threads/:id', 'read', '/api/threads/t-1'),
      row('GET /api/tasks', 'denied'),
      // By route: the person opening the Tasks view or the history is grouped too. Their rows are
      // the poll's rows (`/api/tasks`, `/api/history/cost/daily`; the query is not recorded, D15).
      // Decided so (sec-infra 2026-10-28: „faltet auch das selbst geöffnete Fenster; aufklappbar
      // sichtbar; kein Session-Inhalt“).
      row('GET /api/tasks', 'read', '/api/tasks'),
      row('GET /api/history/cost/daily', 'read', '/api/history/cost/daily'),
      // Should a row ever carry the query, the mark still goes by route; this keeps the decision
      // visible against a return to matching the poll's exact query.
      row('GET /api/tasks', 'read', '/api/tasks?status=done'),
    ], quiet);
    expect(entries.map((e) => [e.kind, 'action' in e ? e.action : '', 'auto' in e ? e.auto : undefined])).toEqual([
      ['event', 'GET /api/tasks', true],
      ['event', 'GET /api/history/cost/daily', true],
      ['event', 'GET /api/tasks', true],
      ['event', 'GET /api/tasks', undefined],
      ['event', 'GET /api/threads/:id', undefined],
      ['event', 'GET /api/runs/active', true],
    ]);
  });
});
