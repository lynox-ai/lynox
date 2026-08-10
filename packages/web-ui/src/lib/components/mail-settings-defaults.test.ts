import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The mail form's custom-server defaults, asserted against the component
// source. There is no DOM environment in this suite, so this reads the file
// rather than rendering — which is enough for the defect it guards: the SMTP
// suggestion was 465, a port a hosted instance cannot reach outbound, while
// every named preset had been on 587 for months.
//
// The form initialises these values in TWO places — the `$state` declarations
// and resetForm() — and the bug class is fixing one and not the other. So the
// assertions collect EVERY assignment and require them to agree, instead of
// checking that the right string appears somewhere.

const source = readFileSync(fileURLToPath(new URL('./MailSettings.svelte', import.meta.url)), 'utf8');

/** Every value assigned to `name`, whether via `$state(x)` or a plain `= x`. */
function assignedValues(name: string): string[] {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:\\$state\\(\\s*([^)]*?)\\s*\\)|([^;\\n]+))`, 'g');
  return [...source.matchAll(re)]
    .map(m => (m[1] ?? m[2] ?? '').trim())
    .filter(v => v.length > 0);
}

describe('MailSettings custom-server defaults', () => {
  it('finds the assignments it is asserting about', () => {
    // Without this, a rename turns every assertion below into a vacuous pass.
    expect(assignedValues('customSmtpPort').length).toBeGreaterThanOrEqual(2);
    expect(assignedValues('customSmtpSecure').length).toBeGreaterThanOrEqual(2);
    expect(assignedValues('customImapPort').length).toBeGreaterThanOrEqual(2);
  });

  it('suggests submission on 587 everywhere the form is initialised', () => {
    // Assignments driven by autodiscover (`= data.smtp.port`) are excluded —
    // those carry the provider's answer, not our default.
    const literals = assignedValues('customSmtpPort').filter(v => /^\d+$/.test(v));
    expect(literals.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(literals)]).toEqual(['587']);
  });

  it('leaves implicit TLS off by default, matching port 587', () => {
    const literals = assignedValues('customSmtpSecure').filter(v => v === 'true' || v === 'false');
    expect(literals.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(literals)]).toEqual(['false']);
  });

  it('keeps IMAP on implicit TLS 993 — the preference is per protocol', () => {
    const ports = assignedValues('customImapPort').filter(v => /^\d+$/.test(v));
    const secures = assignedValues('customImapSecure').filter(v => v === 'true' || v === 'false');
    expect([...new Set(ports)]).toEqual(['993']);
    expect([...new Set(secures)]).toEqual(['true']);
  });

  it('still lets the user choose implicit TLS — the default is not a ban', () => {
    // Both fields stay bound to editable inputs; nothing disables or clamps them.
    expect(source).toMatch(/bind:value=\{customSmtpPort\}/);
    expect(source).toMatch(/bind:checked=\{customSmtpSecure\}/);
  });
});

describe('MailSettings surfaces which leg of the connection failed', () => {
  it('passes the stage through to the error text', () => {
    // Without the stage, a blocked SMTP port renders as the IMAP advice
    // ("check that the IMAP port is open"), which sends the user the wrong way.
    expect(source).toMatch(/friendlyError\(\s*testResult\.code,\s*testResult\.error,\s*testResult\.stage\s*\)/);
    expect(source).toMatch(/friendlyError\(\s*data\.code,\s*data\.error,\s*data\.stage\s*\)/);
  });

  it('names the blocked port in the SMTP advice', () => {
    const smtpBranch = source.slice(source.indexOf("if (stage === 'smtp')"));
    expect(smtpBranch).toContain('587');
    expect(smtpBranch).toContain('465');
  });

  it('does not claim the send path works when it was never probed', () => {
    // ok:true with checked.smtp === false means receive-only, not "sending fine".
    expect(source).toContain('the send path was not tested');
  });
});
