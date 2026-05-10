// === Inbox classifier — response schema + parser ===
//
// Strict JSON validation of the classifier's reply. Any deviation from the
// schema or any policy violation (out-of-range confidence, over-length
// reason, `noise` bucket leaking through) returns a fail-closed result that
// routes the mail to "Needs You" — the asymmetric-risk default from the PRD.

import { z } from 'zod';
import type { InboxBucket } from '../../../types/index.js';

/** Hard cap on `one_line_why_de` length — over-cap fails closed. */
export const MAX_REASON_LEN = 200;

/** Confidence below this threshold routes to `requires_user` per PRD §Classification. */
export const REQUIRES_USER_THRESHOLD = 0.7;

/**
 * Why a classification result was forced to `requires_user`. `null` when the
 * model's verdict survived intact.
 */
export type FailReason =
  | 'json_parse_error'
  | 'schema_violation'
  | 'noise_bucket_returned'
  | 'reason_over_length'
  | 'low_confidence'
  /** Daily classifier budget (InboxCostBudget) was exhausted — no LLM call. */
  | 'budget_exceeded';

export interface ClassifierVerdict {
  bucket: InboxBucket;
  confidence: number;
  reasonDe: string;
  /** Set when the model output was rejected and we fell back to requires_user. */
  failReason: FailReason | null;
}

const RawSchema = z.object({
  bucket: z.enum(['requires_user', 'draft_ready', 'auto_handled', 'noise']),
  confidence: z.number().min(0).max(1),
  one_line_why_de: z.string().min(1),
});

/** Sentinel reason used whenever the model's text cannot be trusted. */
const FAIL_CLOSED_REASON = 'Klassifizierer-Antwort ungültig — manuell prüfen.';

function failClosed(reason: FailReason, fallback?: string): ClassifierVerdict {
  return {
    bucket: 'requires_user',
    // Express the lack of confidence honestly — UI can surface this on a chip.
    confidence: 0,
    reasonDe: fallback ?? FAIL_CLOSED_REASON,
    failReason: reason,
  };
}

/**
 * Parse and validate a raw model response. Always returns a verdict — the
 * fail-closed branch routes anything suspicious to `requires_user`.
 *
 * The model is instructed to emit bare JSON, but Haiku occasionally wraps it
 * in ```json fences. We strip a single leading/trailing fence as a courtesy
 * before parsing — anything more elaborate fails closed.
 */
export function parseClassifierResponse(raw: string): ClassifierVerdict {
  const trimmed = stripJsonFence(raw.trim());
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return failClosed('json_parse_error');
  }

  const parsed = RawSchema.safeParse(json);
  if (!parsed.success) {
    return failClosed('schema_violation');
  }

  const { bucket, confidence, one_line_why_de } = parsed.data;
  const reason = one_line_why_de.trim();

  if (reason.length > MAX_REASON_LEN) {
    return failClosed('reason_over_length');
  }
  if (bucket === 'noise') {
    // PRD: noise must be dropped at the prefilter; if the model insists, we
    // route to requires_user rather than silently swallow the mail.
    return failClosed('noise_bucket_returned', reason);
  }
  if (confidence < REQUIRES_USER_THRESHOLD && bucket !== 'requires_user') {
    return {
      bucket: 'requires_user',
      confidence,
      reasonDe: reason,
      failReason: 'low_confidence',
    };
  }

  return {
    bucket,
    confidence,
    reasonDe: reason,
    failReason: null,
  };
}

function stripJsonFence(input: string): string {
  if (!input.startsWith('```')) return input;
  // Drop opening fence (```json or ```)
  const afterOpen = input.replace(/^```(?:json)?\s*\n?/i, '');
  // Drop closing fence
  return afterOpen.replace(/\n?```\s*$/i, '');
}
