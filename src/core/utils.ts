import { createHash } from 'node:crypto';

/** SHA-256 hash truncated to 16 hex chars. */
export function sha256Short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A USD amount for a sentence, rounded to the cent: "$50" when it is whole dollars, else "$12.50". */
export function formatUsdAmount(usd: number): string {
  const cents = Math.round(usd * 100);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logErrorChain(context: string, err: unknown): void {
  if (!process.env['LYNOX_DEBUG']) return;
  const parts = [context];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(`  ${current.message}`);
    if (current.stack) parts.push(`  ${current.stack.split('\n').slice(1, 3).join('\n  ')}`);
    current = current.cause;
  }
  process.stderr.write(parts.join('\n') + '\n');
}
