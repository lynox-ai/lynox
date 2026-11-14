import { describe, it, expect } from 'vitest';
import { engineLessText, type EngineLessKind } from './api-store.js';

// The HTTP error body is capped at 600 characters (`SSE_ERROR_MAX_CHARS` in the server); a longer
// sentence would reach a client cut off with "…".
const HTTP_CAP = 600;
const LASTS = 'This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not.';
const TO_MODEL = 'Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.';
const KINDS: readonly EngineLessKind[] = ['save', 'remove', 'connect', 'renew'];

describe('an engine-less refusal, told to the model and to an HTTP client', () => {
  for (const kind of KINDS) {
    it(`${kind}: the HTTP sentence fits the cap, ends with the restart and the log, and gives the model no advice`, () => {
      const client = engineLessText(kind, 'client');
      expect(client.length).toBeLessThanOrEqual(HTTP_CAP);
      expect(client.endsWith(` ${LASTS}`)).toBe(true);
      expect(client).not.toContain('Do not');
    });

    it(`${kind}: the tool sentence is the HTTP sentence followed by the whole advice to the model`, () => {
      expect(engineLessText(kind, 'model')).toBe(`${engineLessText(kind, 'client')} ${TO_MODEL}`);
    });
  }
});
