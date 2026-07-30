/**
 * The canonical "did this turn / conversation see untrusted content?" predicate.
 *
 * This is the single source of truth for EVERY durable-write-trust and taint-propagation
 * decision (memory_store/update/promote, `remember`, memory_block_edit/retire, the turn-end
 * auto-extractor, and spawn's parent↔child taint). It used to be inlined — byte-identically —
 * across `memory.ts`, `knowledge.ts`, `agent.ts`, and `spawn.ts`, with nothing enforcing that the
 * copies agreed. On a security-critical predicate that drift is a latent fail-open hole, so the
 * predicate is centralised here.
 *
 * Why the union and not the bare marker: `sawUntrustedData` (the wrapped-content boundary marker)
 * is allowlist-by-omission — `web_research` / `mail_*` / `read_file` / `bash` return external,
 * attacker-controllable content WITHOUT setting it. Gating on the marker ALONE lets external-
 * derived content ride out as trusted. The union closes that with the H4 capability signal
 * ({@link UntrustedSignals.sawExternalContentTool}) and the F5 conversation-sticky signal
 * ({@link UntrustedSignals.conversationSawUntrusted}). It over-taints only in the SAFE direction
 * (routes to review / abstains from extraction); a clean business-conversation turn stays trusted.
 */

/** The three run/conversation-scoped untrusted signals an Agent exposes. */
export interface UntrustedSignals {
  /** Wave 1.2: this run saw wrapped untrusted content (the boundary marker). */
  readonly sawUntrustedData?: boolean | undefined;
  /** DK.1 H4: an EXTERNAL-content tool (bash/http/read_file/mail/…) ran this run. */
  readonly sawExternalContentTool?: boolean | undefined;
  /** DK.1 F5: this CONVERSATION has ingested untrusted content (sticky across turns). */
  readonly conversationSawUntrusted?: boolean | undefined;
}

/**
 * True when the wrap marker OR an external-content tool this turn OR a conversation-sticky
 * untrusted ingest is set. See the module doc for why this is the union and not the bare marker.
 */
export function deriveTurnUntrusted(signals: UntrustedSignals): boolean {
  return signals.sawUntrustedData === true
    || signals.sawExternalContentTool === true
    || signals.conversationSawUntrusted === true;
}

/** Which member(s) of the union fired. `none` ⇔ {@link deriveTurnUntrusted} is false. */
export type UntrustedCause = 'none' | 'marker' | 'external-tool' | 'conversation';

/**
 * WHICH signal(s) put this turn on the untrusted side of the union — the attribution
 * {@link deriveTurnUntrusted} deliberately collapses.
 *
 * The boolean is the right shape for the gate (any signal ⇒ route to review), but it makes
 * the union's COST unattributable: a review queue holds no record of whether an entry is
 * there because the turn itself read external content (H4) or because the conversation was
 * tainted several turns earlier and the taint is sticky (F5). Those have very different
 * answers — the first is inherent, the second is a policy choice — and until now the
 * question "should the sticky half be narrowed?" could only be argued, not measured.
 * (Asked 2026-07-28; a DK replay showed 12 of 20 queued writes on turns the corpus does not
 * mark as delivering external content, but one of them sat on turn 0, where stickiness is
 * impossible — so even the sign of the split was unknown.)
 *
 * Ordered by specificity, NOT by precedence in the gate: the gate ORs, so several may hold
 * at once. `marker` wins when set because it is the narrowest claim (this run handled
 * wrapped content); `external-tool` next (a tool ran that CAN return external content);
 * `conversation` last, since it is true for every later turn once anything tainted the
 * thread and would otherwise mask the more specific causes.
 */
export function describeTurnUntrusted(signals: UntrustedSignals): UntrustedCause {
  if (signals.sawUntrustedData === true) return 'marker';
  if (signals.sawExternalContentTool === true) return 'external-tool';
  if (signals.conversationSawUntrusted === true) return 'conversation';
  return 'none';
}
