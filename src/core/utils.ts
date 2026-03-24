import { createHash } from 'node:crypto';

/** SHA-256 hash truncated to 16 hex chars. */
export function sha256Short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getErrorMessageWithCause(err: unknown): string {
  const msg = getErrorMessage(err);
  if (err instanceof Error && err.cause instanceof Error) {
    return `${msg} (caused by: ${err.cause.message})`;
  }
  return msg;
}

export function logErrorChain(context: string, err: unknown): void {
  if (!process.env['NODYN_DEBUG']) return;
  const parts = [context];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(`  ${current.message}`);
    if (current.stack) parts.push(`  ${current.stack.split('\n').slice(1, 3).join('\n  ')}`);
    current = current.cause;
  }
  process.stderr.write(parts.join('\n') + '\n');
}
