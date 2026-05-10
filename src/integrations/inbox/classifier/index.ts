// === Inbox classifier — main entry ===
//
// Single-mail classification: build prompt, call Haiku, parse + validate,
// return a verdict. All policy (fail-closed, low-confidence routing,
// reason-length cap) lives in `schema.ts`; this file is the orchestrator.
//
// The LLM call itself is injected so tests can run without network and so
// the queue (next commit) can wrap it with a per-job AbortController +
// 30-second timeout per the PRD's Architecture section.

import { buildClassifierPrompt, type ClassifierPromptInput } from './prompt.js';
import { parseClassifierResponse, type ClassifierVerdict } from './schema.js';

/**
 * Identifier persisted in `inbox_items.classifier_version`. Bumping this
 * value enables selective re-classification when the prompt or model change.
 * Keep the format `<provider>-<model>-YYYY-MM` so the v7 column stays sortable.
 */
export const CLASSIFIER_VERSION = 'haiku-2026-05';

/**
 * Caller-provided LLM invoker. Returns the model's raw text reply.
 *
 * The default wiring (added in a follow-up commit) calls
 * `createLLMClient(...).messages.create({ model: getModelId('haiku'), ... })`.
 * Tests pass a stub.
 */
export type LLMCaller = (args: {
  system: string;
  user: string;
  signal?: AbortSignal | undefined;
}) => Promise<string>;

export interface ClassifyOptions {
  /** Abort signal — wired to the queue's per-job timeout in production. */
  signal?: AbortSignal | undefined;
  /** Override the default classifier version (mainly for tests). */
  classifierVersion?: string | undefined;
}

export interface ClassifyResult extends ClassifierVerdict {
  classifierVersion: string;
  /** True when the body was sliced for size — surfaced for telemetry. */
  bodyTruncated: boolean;
}

/**
 * Classify a single mail. Pure orchestration around prompt build →
 * LLM call → response parse. Never throws on classifier-side errors;
 * those return a fail-closed `requires_user` verdict. Network / SDK errors
 * propagate so the queue can decide between retry and dead-letter.
 */
export async function classifyMail(
  input: ClassifierPromptInput,
  llm: LLMCaller,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const built = buildClassifierPrompt(input);
  const raw = await llm({
    system: built.system,
    user: built.user,
    signal: opts.signal,
  });
  const verdict = parseClassifierResponse(raw);
  return {
    ...verdict,
    classifierVersion: opts.classifierVersion ?? CLASSIFIER_VERSION,
    bodyTruncated: built.sanitized.truncated,
  };
}

export type { ClassifierPromptInput } from './prompt.js';
export type { ClassifierVerdict, FailReason } from './schema.js';
export { REQUIRES_USER_THRESHOLD, MAX_REASON_LEN } from './schema.js';
