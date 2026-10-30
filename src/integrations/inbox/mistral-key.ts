// === Inbox classifier — which Mistral key, and who pays ===

interface SecretReader {
  resolve(name: string): string | null;
}

export interface InboxMistralKey {
  key: string | undefined;
  /** True when the key is the pool's (the CP's `MISTRAL_API_KEY` on a pool tier): only then is
   *  the classifier's spend debited to the instance's balance. */
  poolPays: boolean;
}

/**
 * The key the EU classifier calls Mistral with.
 * - Not a pool tier: as before, the vault's `LYNOX_INBOX_MISTRAL_API_KEY`, then its
 *   `MISTRAL_API_KEY`, then the same two from the environment. The user pays; nothing is debited.
 * - A pool tier: `LYNOX_INBOX_MISTRAL_API_KEY` (vault, then environment) is a key the user set for
 *   the inbox on purpose, so it is used and the user pays. Otherwise only the environment's
 *   `MISTRAL_API_KEY`, which the control plane supplies, and the pool pays. A vault
 *   `MISTRAL_API_KEY` there is the user's own and is never used in the pool's place.
 */
export function resolveInboxMistralKey(
  store: SecretReader | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
  pool: boolean,
): InboxMistralKey {
  if (!pool) {
    const key = store?.resolve('LYNOX_INBOX_MISTRAL_API_KEY') ?? store?.resolve('MISTRAL_API_KEY')
      ?? env['LYNOX_INBOX_MISTRAL_API_KEY'] ?? env['MISTRAL_API_KEY'];
    return { key: key || undefined, poolPays: false };
  }
  const own = store?.resolve('LYNOX_INBOX_MISTRAL_API_KEY') ?? env['LYNOX_INBOX_MISTRAL_API_KEY'];
  if (own) return { key: own, poolPays: false };
  const key = env['MISTRAL_API_KEY'];
  return { key: key || undefined, poolPays: !!key };
}
