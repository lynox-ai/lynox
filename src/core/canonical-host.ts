/**
 * A host as the engine keys it: lower case, no trailing dot, and nothing but a host
 * name — no user info, port, path, or IP literal. `null` when `raw` is anything else.
 */
export function canonicalHost(raw: string): string | null {
  const lower = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(lower)) return null;
  if (/^[0-9.]+$/.test(lower)) return null;
  try {
    return new URL(`https://${lower}/`).hostname === lower ? lower : null;
  } catch {
    return null;
  }
}
