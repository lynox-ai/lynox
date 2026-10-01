// === D12: giving up a tenant's own Google client for the managed one ===
//
// Pure and rune-free so it can be unit-tested. The store owns the state; this
// owns the ORDER and the checks, which is what the decision rests on.
//
// The safety argument is not "we ask first". It is that the pair is deleted
// before anything replaces it, on a path whose success nobody can predict —
// the broker consent can fail while the app is unverified. So: the confirm
// names both costs, nothing is revoked at Google (the grant is the user's and
// revoking is irreversible), and every DELETE is checked.

export type SwitchOutcome =
  /** Local grant dropped and the client pair is gone. Safe to start the broker consent. */
  | { ok: true }
  /** Nothing was destroyed. The connection is exactly as it was. */
  | { ok: false; stage: 'disconnect' }
  /**
   * The local grant IS already gone and the pair is not. The user must
   * re-authenticate with their own client — telling them "nothing changed"
   * here would be false, which is why the stage travels with the failure.
   */
  | { ok: false; stage: 'pair' };

export type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;

/**
 * Delete the stored client pair, checking BOTH deletions.
 *
 * `fetch` rejects only on a network error, so a `Promise.all` with no `res.ok`
 * check reports success when one DELETE answers 500 and the other 200 —
 * leaving a half-deleted pair behind and telling the user it is gone.
 */
export async function deleteClientPair(fetchFn: FetchLike, apiBase: string): Promise<boolean> {
	const [id, secret] = await Promise.all([
		fetchFn(`${apiBase}/secrets/GOOGLE_CLIENT_ID`, { method: 'DELETE' }),
		fetchFn(`${apiBase}/secrets/GOOGLE_CLIENT_SECRET`, { method: 'DELETE' }),
	]);
	return id.ok && secret.ok;
}

/**
 * The destructive half of the switch-back. Must not be reachable without the
 * confirm the card renders.
 *
 * Order: the local grant first (it is worthless once the pair it was minted
 * under is gone), then the pair. The reverse order would leave a live token
 * signed by a client the tenant can no longer prove it owns.
 */
export async function performSwitchToManaged(
	fetchFn: FetchLike,
	apiBase: string,
): Promise<SwitchOutcome> {
	const dropped = await fetchFn(`${apiBase}/google/disconnect`, { method: 'POST' });
	if (!dropped.ok) return { ok: false, stage: 'disconnect' };

	if (!(await deleteClientPair(fetchFn, apiBase))) return { ok: false, stage: 'pair' };

	await fetchFn(`${apiBase}/google/reload`, { method: 'POST' });
	return { ok: true };
}
