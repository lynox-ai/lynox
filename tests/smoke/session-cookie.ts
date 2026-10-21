import { createHmac, randomBytes } from 'node:crypto';

/**
 * A `lynox_session` value for the instance owner, signed with the instance's
 * LYNOX_HTTP_SECRET, in the structure the engine mints: nonce, owner principal,
 * timestamp, HMAC over the three. No verifier reads the nonce or its length.
 *
 * A hosted engine requires the owner principal in the session cookie and
 * refuses the older `ts.hmac` form with 401, whatever the secret, so a smoke
 * against a hosted engine must send this one. A self-hosted engine accepts
 * both, so the local smoke stack takes it too.
 */
export function mintOwnerSessionCookie(secret: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const owner = Buffer.from(JSON.stringify({ v: 1, kind: 'owner' })).toString('base64url');
  const payload = `${nonce}.${owner}.${ts}`;
  const key = createHmac('sha256', 'lynox-session').update(secret).digest();
  return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
}
