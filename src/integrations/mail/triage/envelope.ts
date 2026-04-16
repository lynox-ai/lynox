// === Token-efficient envelope view for the agent ===
//
// MailEnvelope (the provider shape) carries operational fields the agent
// doesn't need (uid, folder, sizeBytes, attachmentCount, threadKey…). The
// triage view strips those down so the LLM only sees ~80 tokens per message:
// from, subject, date, snippet, attachment hint, flag hint.

import type { MailEnvelope } from '../provider.js';

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
 */
export function renderTriageList(envelopes: ReadonlyArray<MailEnvelope>): string {
  if (envelopes.length === 0) return '(no messages)';
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
    if (v.snippet) lines.push(`   ${truncate(v.snippet.replace(/\s+/g, ' '), 200)}`);
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
