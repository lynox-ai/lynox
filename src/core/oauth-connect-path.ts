/**
 * The path of the route that starts an OAuth connect for a stored profile, before its id. The
 * engine registers the route under it, `api_setup` builds the link it hands out from it, and the
 * web UI's "Reconnect" button points at it (`packages/web-ui/src/lib/oauth-connect-path.ts`, which
 * a test holds equal to this one).
 */
export const OAUTH_CONNECT_PATH = '/api/oauth/connect/';
