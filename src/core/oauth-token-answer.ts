/**
 * Reading a token endpoint's answer without carrying its text into an error.
 *
 * A token endpoint's answer holds credentials on success and may echo them on
 * failure. Its errors reach the model through the tools that call
 * `getAccessToken()`, and the agent masks only values it already stores, so a
 * fresh token or a piece of one would stay in clear. Two forms carried text:
 * the raw failure body in the message, and V8's `SyntaxError` for a malformed
 * success, which quotes the characters around the fault.
 */

/** ` (<code>)` when the failure body names a plain OAuth error code; otherwise empty. Never the body. */
export function tokenErrorCode(body: string): string {
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? ` (${code})` : '';
  } catch {
    return '';
  }
}

/** The parsed answer; a malformed one is named under `what`, never quoted. */
export async function tokenAnswer(response: { json(): Promise<unknown> }, what: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${what}: the answer is not valid JSON`);
    throw err;
  }
}
