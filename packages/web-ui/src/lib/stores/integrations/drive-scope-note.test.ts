import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Drive remedy is a CARD string, not a tool string, and it branches on the
 * broker mode. Both halves matter and neither is obvious from reading one side:
 *
 *  - a tool string is read by the MODEL; the person who could widen the grant
 *    never sees it, so the remedy belongs on the card;
 *  - a brokered connection renders no control that widens a grant, so telling
 *    it to "switch to Full" points at something that is not there. The wrong
 *    half of this was in the PRD until 2026-09-01: it branched on
 *    `client_source`, which is `null` in broker mode.
 */
describe('the Drive remedy is on the card and branches on the mode', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../../components/GoogleSettings.svelte', import.meta.url)), 'utf8');
  const tool = readFileSync(
    fileURLToPath(new URL('../../../../../../src/integrations/google/google-drive.ts', import.meta.url)), 'utf8');
  const i18n = readFileSync(
    fileURLToPath(new URL('../../i18n.svelte.ts', import.meta.url)), 'utf8');

  it('the files really were read', () => {
    // Positive control: without it a path typo turns every assertion below into
    // a statement about an empty string.
    expect(card.length).toBeGreaterThan(3000);
    expect(tool.length).toBeGreaterThan(3000);
    expect(i18n.length).toBeGreaterThan(10_000);
  });

  it('the card carries the remedy and the tool does not', () => {
    expect(card).toContain('drive_app_files_only_broker');
    expect(card).toContain('drive_app_files_only_byo');
    // The tool says WHAT it searched; it must not tell the model how to get
    // more, because the model cannot act on that and the user never reads it.
    expect(tool).toContain('only files lynox created');
    expect(tool).not.toContain('Advanced');
    expect(tool).not.toContain('Full access');
  });

  it('branches on the broker mode, not on `client_source`', () => {
    // `client_source` is `null` in broker mode, so a branch on it would give
    // every brokered tenant the BYO remedy — the exact error the PRD carried.
    const branch = /isBroker\s*\?\s*t\('integrations\.drive_app_files_only_broker'\)/;
    expect(branch.test(card)).toBe(true);
    expect(card).not.toMatch(/client_source[^)]*drive_app_files_only/);
  });

  it('both remedies exist in both languages and say different things', () => {
    for (const key of ['drive_app_files_only_broker', 'drive_app_files_only_byo']) {
      const line = i18n.split('\n').find(l => l.includes(key));
      expect(line, `${key} must be defined`).toBeDefined();
      expect(line).toContain('de:');
      expect(line).toContain('en:');
    }
    const broker = i18n.split('\n').find(l => l.includes('drive_app_files_only_broker'))!;
    const byo = i18n.split('\n').find(l => l.includes('drive_app_files_only_byo'))!;
    // A brokered tenant must NOT be sent to a toggle its card does not render.
    expect(broker).toContain('Advanced');
    expect(byo).not.toContain('Advanced');
  });
});
