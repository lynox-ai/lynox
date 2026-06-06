import { describe, it, expect } from 'vitest';
import { injectPrintScaffold } from './artifact-print.js';

describe('injectPrintScaffold', () => {
  it('injects the @page style before </head> and the print script before </body> for a full document', () => {
    const out = injectPrintScaffold('<html><head><title>X</title></head><body><p>Hi</p></body></html>');
    expect(out).toContain('@page{margin:1.5cm}</head>'.replace('</head>', '')); // style present
    expect(out.indexOf('@page')).toBeLessThan(out.indexOf('</head>'));
    expect(out.indexOf('window.print()')).toBeLessThan(out.indexOf('</body>'));
    // Original content preserved.
    expect(out).toContain('<p>Hi</p>');
    expect(out).toContain('<title>X</title>');
  });

  it('auto-prints and closes after printing', () => {
    const out = injectPrintScaffold('<html><head></head><body></body></html>');
    expect(out).toContain('window.print()');
    expect(out).toContain('afterprint');
    expect(out).toContain('window.close()');
  });

  it('prepends/appends scaffold for a bare fragment with no head/body', () => {
    const out = injectPrintScaffold('<p>just a fragment</p>');
    expect(out.startsWith('<style>')).toBe(true);
    expect(out).toContain('<p>just a fragment</p>');
    expect(out.trimEnd().endsWith('</scr' + 'ipt>')).toBe(true);
  });

  it('does not double-inject when only one of head/body exists', () => {
    const out = injectPrintScaffold('<body><p>x</p></body>');
    // style prepended (no </head>), script before </body>.
    expect(out.startsWith('<style>')).toBe(true);
    expect((out.match(/window\.print\(\)/g) ?? []).length).toBe(1);
  });
});
