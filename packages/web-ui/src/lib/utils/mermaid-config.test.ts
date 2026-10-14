import { describe, it, expect } from 'vitest';
import { mermaidConfig } from './mermaid-config.js';

describe('mermaidConfig', () => {
  // The SVG mermaid returns goes into the page through `{@html}`; `strict` keeps a diagram's
  // text from carrying HTML or a click handler into it, whatever a later version's default is.
  it.each(['light', 'dark'] as const)('renders %s diagrams at the strict security level', (theme) => {
    expect(mermaidConfig(theme, {}).securityLevel).toBe('strict');
    expect(mermaidConfig(theme, {}).startOnLoad).toBe(false);
  });

  // The rest moved here from MarkdownRenderer unchanged: the mermaid 11 layout and look, and the
  // theme that matches the page's.
  it.each([
    ['light', 'default'],
    ['dark', 'dark'],
  ] as const)('keeps the %s page on the %s mermaid theme, with the mermaid 11 layout and look', (theme, mermaidTheme) => {
    const vars = { primaryColor: 'x' };
    expect(mermaidConfig(theme, vars)).toEqual({
      startOnLoad: false,
      securityLevel: 'strict',
      layout: 'dagre',
      look: 'classic',
      theme: mermaidTheme,
      themeVariables: vars,
    });
  });
});
