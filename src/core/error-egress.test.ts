/**
 * What an error may say once it leaves the engine (`error-egress.ts`), unit by unit, and one
 * keyless sink outside the run path (the TTS request log) through its real code.
 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  errorText, errorTextReduced, isErrorTextReducedForProcess, processErrorText, providerStatus,
  reduceErrorTextForProcess, reducedErrorText, _resetErrorEgress,
} from './error-egress.js';
import { speakMistralVoxtral } from './speak/mistral-voxtral-tts.js';
import type { Containment } from './containment.js';
import { refuseDebug } from './exact-debug-refusal.js';

const BODY = 'PROVIDER-BODY-7f3a: order of Jane Roe';

beforeEach(() => { _resetErrorEgress(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); _resetErrorEgress(); });

it('reduces an error to its class and the HTTP status, from the SDK field or the adapter prefix', () => {
  expect(reducedErrorText(Object.assign(new Error(BODY), { status: 429 }))).toBe('Error (HTTP 429)');
  expect(reducedErrorText(new Error(`OpenAI-compatible API error 503: ${BODY}`))).toBe('Error (HTTP 503)');
  class RateLimitError extends Error { override name = 'RateLimitError'; }
  expect(reducedErrorText(new RateLimitError(BODY))).toBe('RateLimitError');
  // A name is the error's own text too: one that is not an identifier reads `Error`.
  const named = new Error(BODY);
  named.name = `Bad ${BODY}`;
  expect(reducedErrorText(named)).toBe('Error');
  named.name = 'A'.repeat(41);
  expect(reducedErrorText(named)).toBe('Error');
  expect(reducedErrorText(BODY)).toBe('string');
  expect(providerStatus(new Error(BODY))).toBeNull();
});

it('errorText passes the full text when not reduced, the class and status when reduced', () => {
  const err = Object.assign(new Error(BODY), { status: 400 });
  expect(errorText(err, false)).toBe(BODY);
  expect(errorText(BODY, false)).toBe(BODY);
  expect(errorText(err, true)).toBe('Error (HTTP 400)');
});

it('processErrorText follows the exact marker; asked for the stack, it gives it only when not held', () => {
  const err = Object.assign(new Error(BODY), { status: 400 });
  expect(processErrorText(err)).toBe(BODY);
  expect(processErrorText(err, true)).toBe(err.stack);
  reduceErrorTextForProcess();
  expect(processErrorText(err)).toBe('Error (HTTP 400)');
  // No frames: a message line shaped like a frame cannot be told from one V8 wrote.
  const framed = new Error(`x\n    at Jane Roe (order.ts:1:1)`);
  expect(processErrorText(framed, true)).toBe('Error');
  expect(processErrorText(err, true)).toBe('Error (HTTP 400)');
});

it('an error whose name, status or message getter throws reads Error, and the getter\'s text stays out', () => {
  const thrower = (): never => { throw new Error(BODY); };
  for (const prop of ['name', 'status', 'message'] as const) {
    const err = new Error('plain');
    Object.defineProperty(err, prop, { get: thrower });
    expect(reducedErrorText(err), prop).toBe('Error');
  }
});

it('refuseDebug switches every keyless sink to the reduced text', () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const err = Object.assign(new Error(BODY), { status: 400 });
  expect(processErrorText(err)).toBe(BODY);          // control: before the marker
  refuseDebug({});
  expect(isErrorTextReducedForProcess()).toBe(true);
  expect(processErrorText(err)).toBe('Error (HTTP 400)');
});

it('a container key goes to the store; without a key or a store the process state decides', () => {
  const isContained = vi.fn((key: { threadId?: string; bulkRunId?: string }) => key.threadId === 'held-thread');
  const store = { isContained } as unknown as Containment;
  expect(errorTextReduced(store, { threadId: 'held-thread' })).toBe(true);
  expect(errorTextReduced(store, { threadId: 'other' })).toBe(false);
  expect(errorTextReduced(store, { bulkRunId: 'run-1' })).toBe(false);
  expect(isContained).toHaveBeenCalledWith({ bulkRunId: 'run-1' });

  expect(errorTextReduced(store, {})).toBe(false);
  expect(errorTextReduced(null, { threadId: 'held-thread' })).toBe(false);
  reduceErrorTextForProcess();
  expect(isErrorTextReducedForProcess()).toBe(true);
  expect(errorTextReduced(store, {})).toBe(true);
  expect(errorTextReduced(undefined, { threadId: 'held-thread' })).toBe(true);
  // A key still asks the store: an uncontained thread on a held instance keeps its text.
  expect(errorTextReduced(store, { threadId: 'other' })).toBe(false);
});

it('the TTS request log leaves the provider body out once the instance holds an exact connection', async () => {
  vi.stubEnv('MISTRAL_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`{"detail":[{"input":"${BODY}"}]}`, { status: 422, statusText: 'Unprocessable Entity' })));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const written = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');

  expect(await speakMistralVoxtral('hello')).toBeNull();
  expect(written()).toContain(BODY);          // control: the same path writes the body today

  stderr.mockClear();
  reduceErrorTextForProcess();
  expect(await speakMistralVoxtral('hello')).toBeNull();
  expect(written()).toContain('[voxtral-tts] 422 Unprocessable Entity');
  expect(written()).not.toContain(BODY);
});
