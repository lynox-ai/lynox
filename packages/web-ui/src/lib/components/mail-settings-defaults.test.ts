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
  // The advice TEXTS are asserted by return value in api/mail-error-text.test.ts.
  // What is left here is the wiring that file cannot see: whether the component
  // hands the copy module the context it needs. An earlier version of this block
  // tried to assert the texts from here by slicing the source, and the slice ran
  // to end-of-file, so a checkbox label 500 lines below satisfied it — the advice
  // could be emptied out and the test stayed green.

  it('passes the stage through on both the test path and the save path', () => {
    // Without the stage, a blocked SMTP port renders as the IMAP advice
    // ("check that the IMAP port is open"), which sends the user the wrong way.
    expect(source).toMatch(/friendlyError\(\s*testResult\.code,\s*testResult\.error,\s*testResult\.stage\s*\)/);
    expect(source).toMatch(/friendlyError\(\s*err\.code,\s*err\.error,\s*err\.stage\s*\)/);
  });

  it('gives the copy module the port, so 465 advice can be withheld from 587 users', () => {
    expect(source).toMatch(/smtpPort:\s*formPreset === 'custom' \? customSmtpPort : undefined/);
  });

  it('distinguishes probed-and-passed from never-probed, in that order', () => {
    // ok:true with checked.smtp === false means receive-only, not "sending fine".
    // Asserting the strings alone let the CONDITION be negated silently, which
    // swaps the two messages and tells a send-capable account it was not tested.
    const okBranch = source.slice(source.indexOf('{#if testResult.ok}'), source.indexOf('{:else}', source.indexOf('{#if testResult.ok}')));
    expect(okBranch.length).toBeGreaterThan(0);
    const positive = okBranch.indexOf('{#if testResult.checked?.smtp}');
    const accepted = okBranch.indexOf('the SMTP server accepted the login');
    const notTested = okBranch.indexOf('the send path was not tested');
    expect(positive).toBeGreaterThanOrEqual(0);
    // The un-negated condition must guard the "it worked" message, and the
    // receive-only message must sit in the branch after it.
    expect(accepted).toBeGreaterThan(positive);
    expect(notTested).toBeGreaterThan(accepted);
    expect(okBranch).not.toMatch(/\{#if !testResult\.checked\?\.smtp\}/);
  });

  it('offers a way to save a mailbox whose send path could not be verified', () => {
    // Otherwise the new SMTP check takes the read half of the product away from
    // anyone whose SMTP cannot be verified — an alias with no send rights, a
    // smarthost wanting different credentials, a provider throttling AUTH.
    expect(source).toMatch(/canSaveWithoutSending/);
    expect(source).toMatch(/testResult\.stage === 'smtp'/);
  });

  it('cannot send skipTest on the strength of a checkbox that is no longer shown', () => {
    // The escape skips the WHOLE probe, the IMAP leg included. Its checkbox
    // unmounts whenever testResult is cleared, but the boolean behind it did
    // not reset — so ticking it, then correcting the password and saving,
    // stored credentials nothing had ever verified, under "Account saved".
    expect(source).toMatch(/skipTest:\s*skipConnectionTest && canSaveWithoutSending/);
    // And a fresh probe must invalidate the decision made about the old one.
    const testFn = source.slice(source.indexOf('async function testConnection()'), source.indexOf('async function saveAccount()'));
    expect(testFn.length).toBeGreaterThan(0);
    expect(testFn).toMatch(/skipConnectionTest = false/);
  });

  it('shows the refusal — and the escape — to someone who never pressed Test', () => {
    // friendlyError alone was not enough: the escape hung off testResult, which
    // only the test button ever set, so the one path that actually blocks had
    // no way past it.
    const saveFn = source.slice(source.indexOf('async function saveAccount()'));
    expect(saveFn).toMatch(/testResult = \{\s*ok: false/);
    expect(saveFn).toMatch(/stage: err\.stage/);
  });
});
