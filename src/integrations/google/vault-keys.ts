/**
 * The vault slot names the Google integration owns.
 *
 * ⚠ A LEAF module on purpose: no imports, so anything that needs to NAME the
 * slot can do so without pulling the integration in. `google-auth.ts` reaches
 * `node:http`, `node:crypto` and the egress guard at module scope, and every
 * Google import in `engine.ts` is a dynamic `await import(...)`. Importing the
 * constant from there to avoid a duplicated literal would have made the engine
 * load the whole integration at startup — trading a drift risk for a loading
 * change nobody asked for.
 */
export const GOOGLE_OAUTH_TOKENS_KEY = 'GOOGLE_OAUTH_TOKENS';
