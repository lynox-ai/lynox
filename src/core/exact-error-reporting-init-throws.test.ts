/**
 * `Sentry.init` binds its client to the current scope before it sets up the integrations, and
 * can throw after that. The module then never learns the client, but the client is live and its
 * integrations send on their own. The refusal must still reach it.
 */
import { it, expect, vi } from 'vitest';

const sent: string[] = [];
vi.mock('@sentry/node', async () => {
  const actual = await vi.importActual<typeof import('@sentry/node')>('@sentry/node');
  return {
    ...actual,
    init: (options: Record<string, unknown>) => {
      actual.init({
        ...options,
        transport: () => ({
          send: async (envelope: unknown) => { sent.push(JSON.stringify(envelope)); return {}; },
          flush: async () => true,
        }),
      });
      throw new Error('integration setup failed after the client was bound');
    },
  };
});

const Sentry = await import('@sentry/node');
const { initErrorReporting, refuseErrorReporting, _resetForTesting } = await import('./error-reporting.js');

it('disables a client that Sentry.init bound before it threw', async () => {
  _resetForTesting();
  expect(await initErrorReporting('https://key@bugs.example.invalid/1')).toBe(false);
  const client = Sentry.getClient();
  expect(client).toBeDefined();
  // Control: the orphaned client is live.
  client!.captureException(new Error('before'));
  await client!.flush(2000);
  expect(sent.some((e) => e.includes('before'))).toBe(true);

  sent.length = 0;
  refuseErrorReporting();
  client!.captureException(new Error('after'));
  await client!.flush(2000);
  expect(sent).toEqual([]);
});
