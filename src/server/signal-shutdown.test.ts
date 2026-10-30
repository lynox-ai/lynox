import { describe, it, expect, vi } from 'vitest';
import { LynoxHTTPApi } from './http-api.js';

/**
 * The signal handler asks the HTTP API for a bounded shutdown (`signal-shutdown.ts`); the API has
 * to hand that on to the engine, or the inbox classifies its whole backlog past the container's
 * kill. The handler and the engine are tested with a real signal in
 * `integrations/inbox/shutdown-sigterm.test.ts`; that test drives an engine directly.
 */
describe('LynoxHTTPApi.shutdown', () => {
  it('hands the inbox mode on to the engine', async () => {
    const api = new LynoxHTTPApi();
    const shutdown = vi.fn(async () => undefined);
    (api as unknown as { engine: unknown }).engine = { shutdown, getPromptStore: () => null };
    await api.shutdown({ inboxBacklog: 'bounded' });
    expect(shutdown).toHaveBeenCalledWith({ inboxBacklog: 'bounded' });
  });
});
