/**
 * The path of the engine's route that starts an OAuth connect for a stored profile, after the API
 * base and before the profile's id. The engine's own constant is `OAUTH_CONNECT_PATH` in
 * `src/core/oauth-connect-path.ts` (with the `/api` base); a test there holds the two equal.
 */
export const OAUTH_CONNECT_SEGMENT = '/oauth/connect/';

/** The link that starts a new connect of profile `id`, under the API base `apiBase`. */
export function connectHref(apiBase: string, id: string): string {
	return `${apiBase}${OAUTH_CONNECT_SEGMENT}${encodeURIComponent(id)}`;
}
