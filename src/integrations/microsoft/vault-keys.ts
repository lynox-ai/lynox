/**
 * The vault slot names the Microsoft integration owns.
 *
 * ⚠ A LEAF module on purpose, like `google/vault-keys.ts`: no imports, so
 * anything that needs to NAME the slot (the connection row, the erasure) can do
 * so without loading the integration.
 *
 * The `MICROSOFT_OAUTH_` prefix is on `INFRA_SECRET_PATTERNS` (`secret-store.ts`),
 * which keeps the slot out of the agent's sight: the model never sees, names or
 * resolves it.
 */
export const MICROSOFT_OAUTH_TOKENS_KEY = 'MICROSOFT_OAUTH_TOKENS';
