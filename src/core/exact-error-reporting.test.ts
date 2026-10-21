/**
 * Error reporting stops once the instance holds an exact connection: against the REAL
 * @sentry/node SDK with a counting transport, so "nothing is sent" is counted at the wire,
 * not read off a flag. The control in each test is the same client sending before the refusal.
 */
import { it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sent: string[] = [];
vi.mock('@sentry/node', async () => {
  const actual = await vi.importActual<typeof import('@sentry/node')>('@sentry/node');
  return {
    ...actual,
    init: (options: Record<string, unknown>) =>
      actual.init({
        ...options,
        transport: () => ({
          send: async (envelope: unknown) => {
            sent.push(JSON.stringify(envelope));
            return {};
          },
          flush: async () => true,
        }),
      }),
  };
});

const Sentry = await import('@sentry/node');
const {
  initErrorReporting, captureError, captureUserFeedback, refuseErrorReporting,
  isErrorReportingEnabled, isErrorReportingRefused, shutdownErrorReporting, _resetForTesting,
} = await import('./error-reporting.js');
const { refuseDebug, exactMarkerOnDisk } = await import('./exact-debug-refusal.js');
const { EngineDb } = await import('./engine-db.js');

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

const DSN = 'https://key@bugs.example.invalid/1';
const settle = async (): Promise<void> => { await Sentry.flush(2000); };

beforeEach(() => {
  _resetForTesting();
  sent.length = 0;
});

it('sends before the refusal and nothing after it', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  captureError(new Error('before'));
  await settle();
  expect(sent.some((e) => e.includes('before'))).toBe(true);

  sent.length = 0;
  refuseErrorReporting();
  captureError(new Error('after'));
  expect(await captureUserFeedback({ name: 'n', comments: 'after-feedback' })).toBeNull();
  await settle();
  expect(sent).toEqual([]);
  expect(isErrorReportingEnabled()).toBe(false);
});

it('drops what an SDK integration still hands the client, even if the close did not get through', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  const client = Sentry.getClient();
  expect(client).toBeDefined();
  // A close that fails: the client stays as it was.
  const close = vi.spyOn(client!, 'close').mockImplementation(() => Promise.reject(new Error('close failed')));
  refuseErrorReporting();
  expect(close).toHaveBeenCalled();
  // What the http or global-handler integration would do: capture straight on the client.
  client!.captureException(new Error('from-an-integration'));
  await settle();
  expect(sent).toEqual([]);
});

it('refuses any later init, whether from the env, a config DSN or the privacy toggle', async () => {
  refuseErrorReporting();
  expect(await initErrorReporting(DSN)).toBe(false);
  expect(isErrorReportingEnabled()).toBe(false);
  captureError(new Error('after-reinit'));
  await settle();
  expect(sent).toEqual([]);
});

it('refuseDebug stops error reporting and removes LYNOX_BUGSINK_DSN', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  const env: NodeJS.ProcessEnv = { LYNOX_BUGSINK_DSN: DSN };
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  refuseDebug(env);
  expect(env['LYNOX_BUGSINK_DSN']).toBeUndefined();
  expect(isErrorReportingRefused()).toBe(true);
  captureError(new Error('after-refuse-debug'));
  await settle();
  expect(sent).toEqual([]);
});

it('a refusal that lands before an init has finished leaves no client behind', async () => {
  const pending = initErrorReporting(DSN);
  refuseErrorReporting();
  expect(await pending).toBe(false);
  expect(isErrorReportingEnabled()).toBe(false);
  expect(await captureUserFeedback({ name: 'n', comments: 'race-feedback' })).toBeNull();
  captureError(new Error('race-error'));
  await settle();
  expect(sent).toEqual([]);
});

it('sends no session aggregate once refused, though an http request ran before', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end(); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (r) => { r.resume(); r.on('end', resolve); });
    rq.on('error', reject);
    rq.end();
  });
  refuseErrorReporting();
  await settle();
  await new Promise((r) => setTimeout(r, 50));
  expect(sent).toEqual([]);
});

it('exactMarkerOnDisk reads the marker before the engine opens engine.db, fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-marker-peek-'));
  try {
    const path = join(dir, 'engine.db');
    expect(exactMarkerOnDisk(path)).toBe(false);          // no file: a fresh instance
    const db = new EngineDb(path);
    expect(exactMarkerOnDisk(path)).toBe(false);          // migrated, marker not set
    db.setExactMarker();
    db.close();
    expect(exactMarkerOnDisk(path)).toBe(true);           // set
    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'not a database at all, but long enough to be read as one'.repeat(20));
    expect(exactMarkerOnDisk(garbage)).toBe(true);        // unreadable: held
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('disables a built client that Sentry.getClient() does not name', async () => {
  // Boot init at the root, then the privacy toggle off and on again from inside a request.
  expect(await initErrorReporting(DSN)).toBe(true);
  const rootClient = Sentry.getClient();
  await shutdownErrorReporting();
  let scoped: ReturnType<typeof Sentry.getClient>;
  await Sentry.withScope(async () => {
    expect(await initErrorReporting(DSN)).toBe(true);
    scoped = Sentry.getClient();
  });
  expect(scoped).toBeDefined();
  // The init binds its client outside the request too. The refusal must not depend on that, so
  // the current scope is pointed back at the old client: only the module's own list reaches it.
  Sentry.getCurrentScope().setClient(rootClient);
  expect(scoped).not.toBe(Sentry.getClient());
  sent.length = 0;
  refuseErrorReporting();
  scoped!.captureException(new Error('from-the-forked-scope'));
  await scoped!.flush(2000);
  expect(sent).toEqual([]);
});
