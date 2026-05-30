/**
 * Pure predicate for whether a provider tile in LLMSettings is non-interactive.
 *
 * Extracted from LLMSettings.svelte (2026-05-30) so the env-pin / lock matrix is
 * unit-testable. Surfaced by a staging-walk finding: on an env-pinned managed
 * tenant the curated tiles stayed clickable, the auto-save `PUT /api/config`
 * 403'd, and the UI optimistically marked the tile active with no error — the
 * user believed they had switched provider while the engine never changed.
 */
export interface TileLockInput {
	/**
	 * `config.env_overrides.provider` — `LYNOX_LLM_PROVIDER` pins the provider.
	 * ANY switch is rejected: the env wins on the next engine reload AND the
	 * backend 403s the save (`enforceManagedProviderConstraints`).
	 */
	providerEnvPinned: boolean;
	/** Operator hard-lock (`locks.provider`) — provider pinned in config.json. */
	providerLocked: boolean;
	/** Managed lock on free-text endpoints (`locks.custom_provider_endpoints`). */
	customEndpointsLocked: boolean;
	/** This tile is the currently-active selection. */
	isActive: boolean;
	/** This tile needs a user-supplied base URL (OpenAI-/Anthropic-compatible). */
	requiresBaseUrl: boolean;
}

export function isProviderTileLocked(i: TileLockInput): boolean {
	// Env-pinned: disable EVERY tile, not just the non-active ones. When
	// /api/config redacts `provider` on an env-pinned managed tenant the UI's
	// active-provider detection falls back to 'anthropic' (often wrong), so
	// "keep the active tile enabled" can't be trusted — and no switch can take
	// effect regardless. The env-override banner explains why.
	if (i.providerEnvPinned) return true;
	// Operator hard-lock: only the active tile stays selectable.
	if (i.providerLocked && !i.isActive) return true;
	// Managed: only free-text endpoint tiles are off-limits; curated tiles switch.
	if (i.customEndpointsLocked && i.requiresBaseUrl) return true;
	return false;
}
