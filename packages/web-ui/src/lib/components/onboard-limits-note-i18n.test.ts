import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The onboarding note is a promise about mail: lynox shows the message, asks,
 * and sends after the answer — nothing wider. The two sentences are pinned
 * whole, the instrument `cap-note-i18n.test.ts` uses for short rarely-edited
 * copy, so a rewording is a reviewed edit of this file rather than a drift.
 *
 * Source-level, because the runes module cannot be imported here; the helper
 * matches the one LIVE line that opens with the key, so a commented-out or
 * duplicated key is a failure, not a pass.
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

const I18N = read('../i18n.svelte.ts');
const CHAT_VIEW = read('./ChatView.svelte');

function liveLine(source: string, key: string): string {
  const opener = new RegExp(`^['"]${key.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')}['"]\\s*:`);
  const hits = source.split('\n').filter((l) => opener.test(l.trim()));
  expect(hits.length, `expected exactly one live '${key}' line, found ${hits.length}`).toBe(1);
  return (hits[0] as string).trim();
}

describe('onboarding limits note', () => {
  it('read both files, not a prefix of either', () => {
    expect(I18N.length).toBeGreaterThan(100_000);
    expect(CHAT_VIEW).toContain("t('onboard.limits_note')");
  });

  it('says exactly what the mail tools do, in both languages', () => {
    expect(liveLine(I18N, 'onboard.limits_note')).toBe(
      "'onboard.limits_note': { de: 'Ich merke mir Geschäftskontext dauerhaft und schlage vor, bevor ich etwas Wichtiges tue. E-Mails aus deinem Postfach versende ich erst nach deiner Freigabe.', en: 'I keep your business context and propose before doing anything important. Email from your mailbox goes out only after you approve it.' },",
    );
  });
});
