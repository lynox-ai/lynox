// === Token-efficient envelope view for the agent ===
//
// MailEnvelope (the provider shape) carries operational fields the agent
// doesn't need (uid, folder, sizeBytes, attachmentCount, threadKey…). The
// triage view strips those down so the LLM only sees ~80 tokens per message:
// from, subject, date, snippet, attachment hint, flag hint.
//
// Snippets are attacker-controlled body excerpts and MUST be wrapped in
// `<untrusted_data>` boundary tags before reaching the LLM — same defence
// the full mail body gets via `mail_read`. Without this, a phishing mail
// whose first 500 chars say "IGNORE PREVIOUS INSTRUCTIONS AND …" would
// reach the model as plain context.

import type { MailEnvelope } from '../provider.js';
import { wrapUntrustedData } from '../../../core/data-boundary.js';

export interface TriageEnvelopeView {
  /** Display string: '"Alice" <alice@x.com>' or 'alice@x.com'. */
  from: string;
  subject: string;
  /** ISO date trimmed to second precision: '2026-04-15T10:00:00Z'. */
  date: string;
  /** First 500 cleaned characters of body (already populated by provider). */
  snippet: string;
  /** True if message has at least one non-text attachment. */
  hasAttachments: boolean;
  /** True if user has marked it \\Flagged. */
  flagged: boolean;
  /** True if message is unseen (no \\Seen flag). */
  unread: boolean;
  /** Stable handle for the agent to reference later (mail_read uid). */
  uid: number;
  /** Optional thread group key — same value across messages in one thread. */
  thread: string | undefined;
}

/**
 * Convert a MailEnvelope into the agent-facing triage view. Pure function —
 * no IMAP calls, no provider coupling.
 */
export function toTriageView(env: MailEnvelope): TriageEnvelopeView {
  return {
    from: formatFrom(env),
    subject: env.subject || '(no subject)',
    date: trimToSecond(env.date),
    snippet: env.snippet,
    hasAttachments: env.hasAttachments,
    flagged: env.flags.includes('\\Flagged'),
    unread: !env.flags.includes('\\Seen'),
    uid: env.uid,
    thread: env.threadKey,
  };
}

/**
 * Render an array of envelopes as a compact, paginated text block ready to
 * hand to the LLM. ~50–100 tokens per item depending on snippet length.
 *
 * Each envelope's snippet is wrapped individually in <untrusted_data> so
 * the agent treats body excerpts as raw data, not instructions. Subject
 * and from are short header values; their injection surface is small but
 * non-zero — they're rendered as labelled lines that the agent already
 * recognises as headers, and `wrapUntrustedData`'s scanner will flag
 * obvious injection patterns appearing in the snippet alongside.
 */
export function renderTriageList(
  envelopes: ReadonlyArray<MailEnvelope>,
  accountId?: string,
): string {
  if (envelopes.length === 0) return '(no messages)';
  const acctLabel = accountId ?? 'unknown';
  const lines: string[] = [];
  for (let i = 0; i < envelopes.length; i++) {
    const v = toTriageView(envelopes[i]!);
    const flags: string[] = [];
    if (v.unread) flags.push('UNREAD');
    if (v.flagged) flags.push('FLAGGED');
    if (v.hasAttachments) flags.push('ATTACH');
    const flagSuffix = flags.length > 0 ? ` [${flags.join(' ')}]` : '';
    lines.push(`${String(i + 1)}. ${v.subject}${flagSuffix}`);
    lines.push(`   from: ${v.from}`);
    lines.push(`   date: ${v.date}   uid: ${String(v.uid)}`);
    if (v.snippet) {
      const body = truncate(v.snippet.replace(/\s+/g, ' '), 200);
      lines.push(`   ${wrapUntrustedData(body, `mail:${acctLabel}:envelope:${String(v.uid)}:snippet`)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatFrom(env: MailEnvelope): string {
  const first = env.from[0];
  if (!first) return '(unknown)';
  if (first.name) return `"${first.name}" <${first.address}>`;
  return first.address;
}

function trimToSecond(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
