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

// Real-world shapes that mail clients produce in the wild — guards against
// regressions when email-reply-parser changes its quote/signature
// classification across major versions.
describe('cleanBody real-world shapes', () => {
  it('strips German Outlook "Am ... schrieb:" quote header', () => {
    const text = `Danke für die Info — passt so.

Am Donnerstag, 24. April 2026 um 09:12 schrieb Alice <alice@example.de>:
> Hallo Bob,
> Anbei die Zahlen für Q1.
> Liebe Grüße, Alice`;
    const out = cleanBody(text);
    expect(out.visible).toContain('Danke für die Info');
    expect(out.visible).not.toContain('Anbei die Zahlen');
    expect(out.quoted).toContain('Anbei die Zahlen');
  });

  it('strips iOS Mail "Sent from my iPhone" signature', () => {
    const text = `Klingt gut, machen wir so.

Sent from my iPhone`;
    const out = cleanBody(text);
    expect(out.visible).toContain('Klingt gut');
    expect(out.visible).not.toContain('Sent from my iPhone');
    expect(out.signature).toContain('Sent from my iPhone');
  });

  it('handles multi-level reply chain (reply to reply)', () => {
    const text = `Top-level reply.

On Fri, May 1, 2026 at 11:00 AM, Carol <carol@example.com> wrote:
> Middle reply.
>
> On Wed, Apr 30, 2026 at 09:00 AM, Bob <bob@example.com> wrote:
>> Original message.
>> Bob`;
    const out = cleanBody(text);
    expect(out.visible).toContain('Top-level reply');
    expect(out.visible).not.toContain('Middle reply');
    expect(out.visible).not.toContain('Original message');
    expect(out.quoted).toContain('Middle reply');
  });

  it('preserves both inline answers when the quote block trails', () => {
    const text = `Quick answers below.

Sounds fine to me — go ahead.

On Wed, Apr 30, 2026 at 14:00, Dave <dave@example.com> wrote:
> Should we ship Friday or Monday?
> Dave`;
    const out = cleanBody(text);
    expect(out.visible).toContain('Quick answers below');
    expect(out.visible).toContain('go ahead');
    expect(out.visible).not.toContain('Should we ship Friday');
  });
});
