import type { ResolvedTheme } from '../stores/theme.svelte.js';

/**
 * The options `mermaid.initialize` gets. `securityLevel: 'strict'` is mermaid's default today and
 * is set anyway: the diagram's SVG goes into the page through `{@html}`, and `strict` is what
 * keeps a diagram's text from carrying HTML or a click handler into it. A version that changed
 * the default would otherwise change that without a line here changing.
 */
export function mermaidConfig(theme: ResolvedTheme, themeVariables: Record<string, string>) {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // mermaid 12 changed the default layout and look, which re-lays out and
    // recolours existing diagrams. Pinned to the mermaid 11 defaults so a
    // version bump does not also change how diagrams look; moving to the new
    // look is a separate, deliberate change.
    layout: 'dagre',
    look: 'classic',
    theme: theme === 'light' ? 'default' : 'dark',
    themeVariables,
  } as const;
}
