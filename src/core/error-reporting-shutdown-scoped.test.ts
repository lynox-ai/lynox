/**
 * Turning error reporting off closes every client this module built, not only the one the current
 * scope names: against the REAL @sentry/node SDK with a counting transport, so "nothing is sent"
 * is counted at the wire. A client built inside a request (the privacy toggle) is bound to that
 * request's forked scope, and `Sentry.getClient()` outside it does not see it.
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
const { initErrorReporting, captureError, shutdownErrorReporting, _resetForTesting } = await import('./error-reporting.js');

const DSN = 'https://key@bugs.example.invalid/1';

beforeEach(() => {
  _resetForTesting();
  sent.length = 0;
});

it('closes a client turned on inside a request when reporting is turned off outside it', async () => {
  // Boot with reporting on, the toggle off, then on again from inside a request. The boot's init
  // installs the SDK's async scope handling, so the request's scope is forked from here on.
  expect(await initErrorReporting(DSN)).toBe(true);
  const rootClient = Sentry.getClient();
  await shutdownErrorReporting();
  let scoped: ReturnType<typeof Sentry.getClient>;
  await Sentry.withScope(async () => {
    expect(await initErrorReporting(DSN)).toBe(true);
    scoped = Sentry.getClient();
  });
  expect(scoped).toBeDefined();
  expect(scoped).not.toBe(rootClient);
  expect(Sentry.getClient()).toBe(rootClient);  // outside the request the scope names the boot's client

  // Control: the client sends while it is on.
  scoped!.captureException(new Error('while-on'));
  await scoped!.flush(2000);
  expect(sent.some((e) => e.includes('while-on'))).toBe(true);

  // The toggle off, from outside that request.
  sent.length = 0;
  await shutdownErrorReporting();
  scoped!.captureException(new Error('after-off'));
  await scoped!.flush(2000);
  expect(sent).toEqual([]);
});

it('sends what was captured before turning off, and nothing captured after the call', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  captureError(new Error('before-off'));
  const off = shutdownErrorReporting();
  captureError(new Error('during-off'));
  await off;
  // Matched as the exception's value: the SDK attaches the test's own source lines as context, so
  // the bare text of the second message rides along in the first event.
  expect(sent.some((e) => e.includes('"value":"before-off"'))).toBe(true);
  expect(sent.some((e) => e.includes('"value":"during-off"'))).toBe(false);
});
