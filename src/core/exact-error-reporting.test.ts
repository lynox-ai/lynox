/**
 * Error reporting stops once the instance holds an exact connection: against the REAL
 * @sentry/node SDK with a counting transport, so "nothing is sent" is counted at the wire,
 * not read off a flag. The control in each test is the same client sending before the refusal.
 */
import { it, expect, vi, beforeEach } from 'vitest';

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
  isErrorReportingEnabled, isErrorReportingRefused, _resetForTesting,
} = await import('./error-reporting.js');
const { refuseDebug } = await import('./exact-debug-refusal.js');

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
