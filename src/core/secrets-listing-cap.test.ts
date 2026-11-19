import { describe, it, expect } from 'vitest';
import { capSecretsListing, renderSecretsBriefing } from './engine-init.js';
import { redactWireUserMessage } from './wire-capture.js';

/**
 * A long `<secrets>` listing is cut to a bound. The wire capture blanks names and masks only inside
 * a whole `<secrets>…</secrets>` frame, so the cut has to keep the closer, and fall between entries.
 */
function storeOf(names: readonly string[]): { listAgentVisibleNames: () => string[]; getMasked: (n: string) => string } {
  return { listAgentVisibleNames: () => [...names], getMasked: () => '***wxyz' };
}

const NAMES = Array.from({ length: 400 }, (_, i) => `CUSTOMER_SERVICE_KEY_${String(i).padStart(4, '0')}`);
const FULL = renderSecretsBriefing(storeOf(NAMES), (n) => (n === NAMES[399] ? [{ id: 'p1', name: 'shop' }] : []))!;

describe('capSecretsListing', () => {
  it('a listing over the bound keeps its closing tag and stays within the bound', () => {
    expect(FULL.length).toBeGreaterThan(8000);
    const capped = capSecretsListing(FULL, 8000);
    expect(capped.length).toBeLessThanOrEqual(8000);
    expect(capped.startsWith('<secrets>')).toBe(true);
    expect(capped.endsWith('\n[...truncated]\n</secrets>')).toBe(true);
  });

  it('cuts between entries: every entry left is one of the listing, whole', () => {
    const capped = capSecretsListing(FULL, 8000);
    const inner = capped.slice('<secrets>\n'.length, capped.indexOf('\n[...truncated]'));
    const entries = inner.split(', ');
    expect(entries.length).toBeGreaterThan(100);
    const whole = new Set(NAMES.map(n => `secret:${n} (***wxyz)`));
    for (const e of entries) expect(whole.has(e)).toBe(true);
  });

  it('the capture redacts every name of the cut listing', () => {
    const redacted = redactWireUserMessage(`hello\n${capSecretsListing(FULL, 8000)}`);
    expect(redacted).not.toMatch(/CUSTOMER_SERVICE_KEY_/);
    expect(redacted).toMatch(/<secrets>\d+ secrets available \(names\+last4 redacted\)<\/secrets>/);
  });

  it('control: the plain slice it replaces leaves the names in the capture', () => {
    const sliced = FULL.slice(0, 8000) + '\n[...truncated]';
    expect(redactWireUserMessage(`hello\n${sliced}`)).toMatch(/CUSTOMER_SERVICE_KEY_/);
  });

  it('a listing within the bound is returned as it is', () => {
    const short = renderSecretsBriefing(storeOf(NAMES.slice(0, 3)))!;
    expect(capSecretsListing(short, 8000)).toBe(short);
    expect(capSecretsListing(FULL, FULL.length)).toBe(FULL);
  });

  it('one entry longer than the bound leaves the frame empty, never half a name', () => {
    const long = renderSecretsBriefing(storeOf([`K${'X'.repeat(300)}`]))!;
    expect(capSecretsListing(long, 100)).toBe('<secrets>\n[...truncated]\n</secrets>');
  });

  it('never cuts inside the line of connection tokens, whose profile names may hold ", "', () => {
    const holders = (n: string) => (n === 'T1' ? [{ id: 'p1', name: 'Acme, Inc' }] : n === 'T2' ? [{ id: 'p2', name: 'Zed, Ltd' }] : []);
    const listing = renderSecretsBriefing(storeOf(['A_KEY', 'B_KEY', 'T1', 'T2']), holders)!;
    const tokenLine = listing.split('\n').find(l => l.includes('Acme, Inc'))!;
    // A bound that ends just after "Acme," in the token line.
    const max = listing.indexOf('"Acme, Inc"') + '"Acme, '.length + '\n[...truncated]\n</secrets>'.length;
    const capped = capSecretsListing(listing, max);
    expect(capped).toBe(`<secrets>\nsecret:A_KEY (***wxyz), secret:B_KEY (***wxyz)\n[...truncated]\n</secrets>`);
    expect(capped).not.toContain(tokenLine.slice(0, 10));
    // control: with room for it, the token line stays whole
    expect(capSecretsListing(listing, listing.length)).toContain(tokenLine);
  });

  it('a frame on one line, with no break after the tag, is cut the same way', () => {
    const oneLine = `<secrets>secret:K${'X'.repeat(300)} (***wxyz)</secrets>`;
    expect(capSecretsListing(oneLine, 100)).toBe('<secrets>\n[...truncated]\n</secrets>');
  });
});
