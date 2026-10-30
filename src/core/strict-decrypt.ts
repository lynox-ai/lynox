/**
 * Decrypting a stored text so that the caller always knows whether it got the plaintext.
 *
 * The stores keep text either in plain or as `enc:` + base64(iv | tag | ciphertext) under an
 * AES-256-GCM key derived from the vault key (`EngineDb`, `RunHistory`). Their lenient readers
 * hand the stored value back when it cannot be decrypted (no key, wrong key, corrupted), so a
 * failed decrypt and a plaintext look the same to the caller. A reader that passes text on, such as
 * an export, must not rely on them: it uses {@link strictDecrypt} and handles the failure.
 */
import { createDecipheriv } from 'node:crypto';
import { CRYPTO_ALGORITHM, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';

/** The prefix that marks an encrypted stored text. */
export const ENCRYPTED_PREFIX = 'enc:';

/**
 * - `plain`: the stored value carries no prefix; `text` is the value itself.
 * - `decrypted`: it carried the prefix and decrypted; `text` is the plaintext.
 * - `no_key`: it carries the prefix and no key is set.
 * - `failed`: it carries the prefix and does not decrypt under the key: a wrong key, a corrupted
 *   value, or a plaintext that happens to start with `enc:` (written while no key was set). The
 *   three cannot be told apart from the value.
 */
export type StrictDecryptResult =
  | { readonly ok: true; readonly kind: 'plain' | 'decrypted'; readonly text: string }
  | { readonly ok: false; readonly kind: 'no_key' | 'failed' };

export function strictDecrypt(stored: string, key: Buffer | null): StrictDecryptResult {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return { ok: true, kind: 'plain', text: stored };
  if (key === null) return { ok: false, kind: 'no_key' };
  try {
    const buf = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
    const iv = buf.subarray(0, CRYPTO_IV_LENGTH);
    const tag = buf.subarray(CRYPTO_IV_LENGTH, CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH);
    const data = buf.subarray(CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH);
    const decipher = createDecipheriv(CRYPTO_ALGORITHM, key, iv, { authTagLength: CRYPTO_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return { ok: true, kind: 'decrypted', text: Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8') };
  } catch {
    return { ok: false, kind: 'failed' };
  }
}
