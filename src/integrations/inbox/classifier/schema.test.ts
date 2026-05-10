import { describe, expect, it } from 'vitest';
import {
  MAX_REASON_LEN,
  parseClassifierResponse,
  REQUIRES_USER_THRESHOLD,
} from './schema.js';

describe('parseClassifierResponse — happy path', () => {
  it('accepts a well-formed high-confidence verdict', () => {
    const out = parseClassifierResponse(
      JSON.stringify({
        bucket: 'auto_handled',
        confidence: 0.95,
        one_line_why_de: 'Stripe-Receipt — Standard-Auto-Archive',
      }),
    );
    expect(out.bucket).toBe('auto_handled');
    expect(out.confidence).toBe(0.95);
    expect(out.reasonDe).toBe('Stripe-Receipt — Standard-Auto-Archive');
    expect(out.failReason).toBeNull();
  });

  it('strips a single ```json fence around the body', () => {
    const out = parseClassifierResponse(
      '```json\n{"bucket":"draft_ready","confidence":0.8,"one_line_why_de":"Kunde fragt zurück"}\n```',
    );
    expect(out.bucket).toBe('draft_ready');
    expect(out.failReason).toBeNull();
  });
});

describe('parseClassifierResponse — fail-closed routing', () => {
  it('routes invalid JSON to requires_user with json_parse_error', () => {
    const out = parseClassifierResponse('not valid json at all');
    expect(out.bucket).toBe('requires_user');
    expect(out.confidence).toBe(0);
    expect(out.failReason).toBe('json_parse_error');
  });

  it('routes schema mismatch to requires_user with schema_violation', () => {
    const out = parseClassifierResponse(JSON.stringify({ bucket: 'sponsored' }));
    expect(out.bucket).toBe('requires_user');
    expect(out.failReason).toBe('schema_violation');
  });

  it('routes confidence > 1 to requires_user (out of range)', () => {
    const out = parseClassifierResponse(
      JSON.stringify({ bucket: 'auto_handled', confidence: 1.5, one_line_why_de: 'x' }),
    );
    expect(out.failReason).toBe('schema_violation');
  });

  it('routes over-length reason to requires_user', () => {
    const out = parseClassifierResponse(
      JSON.stringify({
        bucket: 'auto_handled',
        confidence: 0.9,
        one_line_why_de: 'a'.repeat(MAX_REASON_LEN + 1),
      }),
    );
    expect(out.bucket).toBe('requires_user');
    expect(out.failReason).toBe('reason_over_length');
  });

  it('rejects a `noise` bucket leak — preserves the model reason for audit', () => {
    const out = parseClassifierResponse(
      JSON.stringify({ bucket: 'noise', confidence: 0.9, one_line_why_de: 'Werbe-Mail' }),
    );
    expect(out.bucket).toBe('requires_user');
    expect(out.failReason).toBe('noise_bucket_returned');
    expect(out.reasonDe).toBe('Werbe-Mail');
  });
});

describe('parseClassifierResponse — confidence routing', () => {
  it(`coerces auto_handled below ${String(REQUIRES_USER_THRESHOLD)} into requires_user`, () => {
    const out = parseClassifierResponse(
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.5, one_line_why_de: 'unsicher' }),
    );
    expect(out.bucket).toBe('requires_user');
    expect(out.confidence).toBe(0.5);
    expect(out.reasonDe).toBe('unsicher');
    expect(out.failReason).toBe('low_confidence');
  });

  it(`coerces draft_ready below ${String(REQUIRES_USER_THRESHOLD)} into requires_user`, () => {
    const out = parseClassifierResponse(
      JSON.stringify({ bucket: 'draft_ready', confidence: 0.69, one_line_why_de: 'unsicher' }),
    );
    expect(out.bucket).toBe('requires_user');
    expect(out.failReason).toBe('low_confidence');
  });

  it(`leaves requires_user verdicts at low confidence untouched`, () => {
    const out = parseClassifierResponse(
      JSON.stringify({ bucket: 'requires_user', confidence: 0.3, one_line_why_de: 'eilig' }),
    );
    expect(out.bucket).toBe('requires_user');
    expect(out.confidence).toBe(0.3);
    // Already in the correct bucket — no fail-routing happened.
    expect(out.failReason).toBeNull();
  });

  it(`accepts auto_handled exactly at the threshold`, () => {
    const out = parseClassifierResponse(
      JSON.stringify({ bucket: 'auto_handled', confidence: REQUIRES_USER_THRESHOLD, one_line_why_de: 'k' }),
    );
    expect(out.bucket).toBe('auto_handled');
    expect(out.failReason).toBeNull();
  });
});
