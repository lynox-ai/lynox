import type { ToolContext } from './tool-context.js';
import { duckDuckGoPolicyRefusal } from '../integrations/search/search-provider.js';

/**
 * Which web-search suffix a session's prompt gets:
 * - `policy-blocks-search`: the fallback is registered but this instance's network settings refuse
 *   it for every search, so no search goes out; the way out is the network settings, not SearXNG.
 * - `fallback-searxng-refused`: the boot refused the SearXNG URL by an egress rule and the fallback
 *   searches; `rule` is the boot's code (`policy-https`, `policy-allowlist`, `policy-deny`, `policy`).
 * - `fallback`: the fallback searches, no SearXNG refused by policy.
 * - `none`: no `web_research` at all.
 * - null: SearXNG is used; no suffix.
 * The fallback is judged against the context as it is when the session builds its prompt, so a
 * policy changed at runtime is followed; the SearXNG decision is the boot's.
 */
export type WebSearchPromptCase =
  | { kind: 'policy-blocks-search' }
  | { kind: 'fallback-searxng-refused'; rule: string }
  | { kind: 'fallback' }
  | { kind: 'none' };

export function webSearchPromptCase(
  status: 'configured' | 'fallback' | 'none',
  bootRefusal: { readonly code: string } | null,
  ctx: ToolContext | undefined,
): WebSearchPromptCase | null {
  if (status === 'configured') return null;
  if (status === 'none') return { kind: 'none' };
  if (duckDuckGoPolicyRefusal(ctx) !== undefined) return { kind: 'policy-blocks-search' };
  if (bootRefusal !== null && bootRefusal.code.startsWith('policy')) return { kind: 'fallback-searxng-refused', rule: bootRefusal.code };
  return { kind: 'fallback' };
}
