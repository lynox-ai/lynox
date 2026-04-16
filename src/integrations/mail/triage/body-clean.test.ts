import { describe, expect, it } from 'vitest';
import { cleanBody, visibleBody } from './body-clean.js';

describe('cleanBody', () => {
  it('returns empty fields for empty input', () => {
    const out = cleanBody('');
    expect(out.visible).toBe('');
    expect(out.quoted).toBe('');
    expect(out.signature).toBe('');
  });

  it('passes through plain text with no quotes or signature', () => {
    const text = 'Hi Bob,\n\nJust checking in. How are you?';
    const out = cleanBody(text);
    expect(out.visible).toContain('Just checking in');
    expect(out.quoted).toBe('');
  });

  it('strips a quoted reply chain', () => {
    const text = `Thanks for the update!

On Wed, Apr 15, 2026 at 10:00 AM, Alice <alice@example.com> wrote:
> Hi Bob,
> Here is the original message.
> Cheers, Alice`;
    const out = cleanBody(text);
    expect(out.visible).toContain('Thanks for the update');
    expect(out.visible).not.toContain('Here is the original message');
    expect(out.quoted).toContain('Here is the original message');
  });

  it('extracts a trailing signature', () => {
    const text = `Sounds good, let's do it.

--
Bob Smith
CEO, Acme Corp
+1 555 1234`;
    const out = cleanBody(text);
    expect(out.visible).toContain("let's do it");
    expect(out.visible).not.toContain('Bob Smith');
    expect(out.signature).toContain('Bob Smith');
  });

  it('normalizes CRLF line endings before parsing', () => {
    const text = 'Hi.\r\n\r\nOn Wed, Alice wrote:\r\n> previous';
    const out = cleanBody(text);
    expect(out.visible).toContain('Hi.');
    expect(out.quoted).toContain('previous');
  });

  it('collapses runs of more than two blank lines', () => {
    const text = 'Line one.\n\n\n\n\nLine two.';
    const out = cleanBody(text);
    expect(out.visible).toBe('Line one.\n\nLine two.');
  });
});

describe('visibleBody', () => {
  it('is a thin wrapper that returns just the visible field', () => {
    const text = `Visible.\n\nOn Wed, Alice wrote:\n> quoted`;
    expect(visibleBody(text)).toBe(cleanBody(text).visible);
  });
});
