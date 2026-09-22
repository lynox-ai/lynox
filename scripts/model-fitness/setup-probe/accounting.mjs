/**
 * Cost of a run from the engine's own token counts. `tokensIn` INCLUDES cached input
 * (the `done` usage in session.ts), so cached reads/writes are carved out of it before
 * the input price is applied. Without cache prices every input token is billed at the
 * input price. Prices are per million tokens, in whatever currency the caller names.
 */
export function cost(u, p) {
  const cr = p.cacheRead ?? p.in;
  const cw = p.cacheWrite ?? p.in;
  const plainIn = Math.max(0, u.tokensIn - u.cacheRead - u.cacheWrite);
  return (plainIn * p.in + u.cacheRead * cr + u.cacheWrite * cw + u.tokensOut * p.out) / 1e6;
}
