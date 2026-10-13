import { describe, it, expect } from 'vitest';
import { mermaidConfig } from './mermaid-config.js';

describe('mermaidConfig', () => {
  // The SVG mermaid returns goes into the page through `{@html}`; `strict` keeps a diagram's
  // text from carrying HTML or a click handler into it, whatever a later version's default is.
  it.each(['light', 'dark'] as const)('renders %s diagrams at the strict security level', (theme) => {
    expect(mermaidConfig(theme, {}).securityLevel).toBe('strict');
    expect(mermaidConfig(theme, {}).startOnLoad).toBe(false);
  });
});
