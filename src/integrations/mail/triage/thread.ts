// === Thread grouping ===
//
// Groups MailEnvelopes into thread buckets using a union-find over
// Message-ID and In-Reply-To headers. Phase 0 only uses In-Reply-To (which
// IMAP ENVELOPE returns for free); the full References chain is a Phase 1
// upgrade if we need deeper grouping accuracy.
//
// The result is a list of MailThread objects, each containing the envelopes
// sorted oldest-first plus a stable `key` (the root message id, or the
// earliest envelope's uid as a fallback).

import type { MailEnvelope } from '../provider.js';

export interface MailThread {
  /** Stable id — root message-id when known, otherwise 'uid:<n>'. */
  key: string;
  envelopes: ReadonlyArray<MailEnvelope>;
  /** First (oldest) envelope in the thread. */
  first: MailEnvelope;
  /** Most recent envelope in the thread. */
  last: MailEnvelope;
  /** True if any envelope in the thread is unseen. */
  hasUnread: boolean;
}

/**
 * Group envelopes into threads. Pure function — does not mutate input.
 *
 * Two envelopes belong to the same thread if either:
 *  - one's `inReplyTo` equals the other's `messageId`, or
 *  - they share a `threadKey` (e.g. Gmail X-GM-THRID exposed by imapflow).
 */
export function groupByThread(envelopes: ReadonlyArray<MailEnvelope>): ReadonlyArray<MailThread> {
  if (envelopes.length === 0) return [];

  // Union-Find over envelope indices
  const parent = new Array<number>(envelopes.length);
  for (let i = 0; i < envelopes.length; i++) parent[i] = i;

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression
    let cursor = i;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Index by messageId for O(1) parent lookup
  const byMessageId = new Map<string, number>();
  // Index by threadKey for explicit X-GM-THRID joins
  const byThreadKey = new Map<string, number>();

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.messageId) byMessageId.set(env.messageId, i);
  }

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;

    // Link via In-Reply-To (immediate parent)
    if (env.inReplyTo) {
      const parentIdx = byMessageId.get(env.inReplyTo);
      if (parentIdx !== undefined) union(i, parentIdx);
    }

    // Link via shared threadKey (when provider supplied a server-side hint)
    if (env.threadKey && env.threadKey !== env.messageId) {
      const seen = byThreadKey.get(env.threadKey);
      if (seen !== undefined) {
        union(i, seen);
      } else {
        byThreadKey.set(env.threadKey, i);
      }
    }
  }

  // Bucket envelopes by their union-find root
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < envelopes.length; i++) {
    const root = find(i);
    let bucket = buckets.get(root);
    if (!bucket) {
      bucket = [];
      buckets.set(root, bucket);
    }
    bucket.push(i);
  }

  const threads: MailThread[] = [];
  for (const indices of buckets.values()) {
    indices.sort((a, b) => envelopes[a]!.date.getTime() - envelopes[b]!.date.getTime());
    const sorted = indices.map(i => envelopes[i]!);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    threads.push({
      key: first.messageId ?? `uid:${String(first.uid)}`,
      envelopes: sorted,
      first,
      last,
      hasUnread: sorted.some(e => !e.flags.includes('\\Seen')),
    });
  }

  // Most-recently-active threads first
  threads.sort((a, b) => b.last.date.getTime() - a.last.date.getTime());
  return threads;
}
