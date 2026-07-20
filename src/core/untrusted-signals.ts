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
