/**
 * Session glossary builder.
 *
 * Assembles the user-specific vocabulary the transcriber should bias toward:
 * CRM contact names, registered API/tool names, recent thread titles, KG
 * entity labels, custom workflow names. Feeds `applySessionGlossary()`.
 *
 * Two entry points:
 *   - `buildSessionGlossary(sources)` — pure function (tested with plain stubs).
 *   - `SessionGlossaryCache` — per-thread TTL cache + diagnostics-channel
 *     invalidation for live usage.
 *
 * Order matters for the apply step: terms earlier in the list win ties. Default
 * priority: contact names > API/tool names > workflow names > thread titles >
 * KG entity labels. Rationale: named entities the user actively types about
 * (contacts, tools) are the most likely intended targets for a misheard word.
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel';

/** Raw term sources for a session. All fields optional; undefined = not available. */
export interface SessionSources {
  readonly contactNames?: readonly string[] | undefined;
  readonly apiProfileNames?: readonly string[] | undefined;
  readonly workflowNames?: readonly string[] | undefined;
  readonly threadTitles?: readonly string[] | undefined;
  readonly kgEntityLabels?: readonly string[] | undefined;
}

export interface BuildGlossaryOptions {
  /** Minimum token length to include a term (avoids single-letter noise). Default 3. */
  readonly minLength?: number;
  /** Max total terms to emit (cap memory + apply cost). Default 200. */
  readonly maxTerms?: number;
  /** Per-source cap before merging. Default 80 contacts, 50 tools, 50 threads, 200 KG entities. */
  readonly perSourceCap?: {
    readonly contacts?: number;
    readonly apis?: number;
    readonly workflows?: number;
    readonly threads?: number;
    readonly kg?: number;
  };
}

/**
 * Build the ordered session glossary. Pure — same inputs always produce the
 * same output. Multi-word names are split into their parts so the fuzzy apply
 * step can rewrite individual tokens (e.g. "Roland Müller" contributes both
 * "Roland" and "Müller").
 */
export function buildSessionGlossary(
  sources: SessionSources,
  opts: BuildGlossaryOptions = {},
): string[] {
  const minLen = opts.minLength ?? 3;
  const maxTotal = opts.maxTerms ?? 200;
  const caps = {
    contacts: opts.perSourceCap?.contacts ?? 80,
    apis: opts.perSourceCap?.apis ?? 50,
    workflows: opts.perSourceCap?.workflows ?? 50,
    threads: opts.perSourceCap?.threads ?? 50,
    kg: opts.perSourceCap?.kg ?? 200,
  };

  const seen = new Set<string>(); // dedupe key (lowercased)
  const out: string[] = [];

  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length < minLen) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  const expand = (raw: string, push: (s: string) => void): void => {
    push(raw);
    // Also expose individual word tokens from multi-word names so fuzzy match
    // can rewrite one token at a time. Strips punctuation like "," or "-".
    const parts = raw.split(/[\s\-_,./]+/).filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) push(p);
    }
  };

  const take = (list: readonly string[] | undefined, cap: number): string[] => {
    if (!list) return [];
    return list.slice(0, cap);
  };

  for (const name of take(sources.contactNames, caps.contacts)) expand(name, push);
  for (const name of take(sources.apiProfileNames, caps.apis)) expand(name, push);
  for (const name of take(sources.workflowNames, caps.workflows)) expand(name, push);
  for (const title of take(sources.threadTitles, caps.threads)) expand(title, push);
  for (const label of take(sources.kgEntityLabels, caps.kg)) expand(label, push);

  return out.slice(0, maxTotal);
}

// ── TTL cache with diagnostics-channel invalidation ────────────────────────

/**
 * Per-thread TTL cache over `buildSessionGlossary` + a hook into the in-process
 * diagnostics channels so mutations in CRM / KG / DataStore invalidate it.
 *
 * Whole-cache wipe on mutation: a diagnostics event doesn't carry a thread ID,
 * and pinpoint invalidation would need store-level plumbing we don't want to
 * introduce for this PR. TTL stays short (60s) so the blast radius is small:
 * worst case one missed rewrite in the 60 seconds after a contact is added.
 */
export class SessionGlossaryCache {
  private readonly entries = new Map<string, { terms: string[]; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly subscribers: Array<{ channel: string; fn: (msg: unknown) => void }> = [];

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  get(key: string, compute: () => string[]): string[] {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.terms;
    const terms = compute();
    this.entries.set(key, { terms, expiresAt: now + this.ttlMs });
    return terms;
  }

  /** Clear everything, or a single key. */
  invalidate(key?: string): void {
    if (key) this.entries.delete(key);
    else this.entries.clear();
  }

  /** How many entries currently cached (for tests). */
  get size(): number { return this.entries.size; }

  /**
   * Subscribe to the diagnostics channels whose events imply the session
   * glossary may be stale. Returns a teardown function.
   *
   * Channels:
   *   - `lynox:datastore:insert` — fires on DataStore writes, including CRM
   *     contacts, API Store entries, and workflow configs.
   *   - `lynox:knowledge:entity` — fires on KG entity upserts.
   */
  attachInvalidators(): () => void {
    const channels = ['lynox:datastore:insert', 'lynox:knowledge:entity'];
    for (const ch of channels) {
      const fn = (): void => this.invalidate();
      subscribe(ch, fn);
      this.subscribers.push({ channel: ch, fn });
    }
    return () => this.detachInvalidators();
  }

  detachInvalidators(): void {
    for (const { channel, fn } of this.subscribers) {
      try { unsubscribe(channel, fn); } catch { /* ok */ }
    }
    this.subscribers.length = 0;
  }
}
