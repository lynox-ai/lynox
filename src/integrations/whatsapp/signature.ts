// === Meta webhook signature verification (X-Hub-Signature-256) ===

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's webhook HMAC. Meta signs the RAW request body with the
 * app-secret; the header is `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Returns true when the signature is valid. Uses constant-time compare.
 */
export function verifySignature(rawBody: string | Buffer, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const expectedHex = signatureHeader.slice(prefix.length).trim();
  if (expectedHex.length === 0) return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const computed = createHmac('sha256', appSecret).update(body).digest('hex');

  if (computed.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}
