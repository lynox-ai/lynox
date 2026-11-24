import { describe, it, expect } from 'vitest';
import { ENGINE_LESS_LASTS, ENGINE_LESS_TO_MODEL, EngineLessRefused, engineLessStoreText, type EngineLessStore } from './engine-less-refusal.js';
import { engineLessText } from './api-store.js';

// The HTTP error body is capped at 600 characters (`SSE_ERROR_MAX_CHARS` in the server); a longer
// sentence would reach a client cut off with "…".
const HTTP_CAP = 600;
const STORES: readonly EngineLessStore[] = ['memory', 'task'];

describe('the engine-less refusal of a memory or to-do change', () => {
  for (const store of STORES) {
    it(`${store}: the HTTP sentence fits the cap, ends with the restart and the log, and gives the model no advice`, () => {
      const client = engineLessStoreText(store, 'client');
      expect(client.length).toBeLessThanOrEqual(HTTP_CAP);
      expect(client.endsWith(` ${ENGINE_LESS_LASTS}`)).toBe(true);
      expect(client).not.toContain('Do not');
    });

    it(`${store}: the tool sentence is the HTTP sentence followed by the whole advice to the model`, () => {
      expect(engineLessStoreText(store, 'model')).toBe(`${engineLessStoreText(store, 'client')} ${ENGINE_LESS_TO_MODEL}`);
    });

    it(`${store}: the thrown refusal carries the model's sentence as its message and the client's apart`, () => {
      const err = new EngineLessRefused(store);
      expect(err.message).toBe(engineLessStoreText(store, 'model'));
      expect(err.client).toBe(engineLessStoreText(store, 'client'));
    });
  }

  it('the two stores say different things', () => {
    expect(engineLessStoreText('memory', 'client')).not.toBe(engineLessStoreText('task', 'client'));
  });

  it('an API refusal ends with the same two sentences', () => {
    expect(engineLessText('save', 'model').endsWith(` ${ENGINE_LESS_LASTS} ${ENGINE_LESS_TO_MODEL}`)).toBe(true);
  });
});
