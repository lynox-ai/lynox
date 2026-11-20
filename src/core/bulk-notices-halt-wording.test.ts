import { describe, it, expect } from 'vitest';
import { BULK_NOTICES } from './bulk-notices.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';

/**
 * Verbatim: the German push for a run halted on its stored access names the settings page by
 * its label, "API-Verbindungen". Written out here, so a change of wording fails until reviewed.
 */
describe('the German halt notice for a stored access', () => {
  it('names the page where the access is connected again', () => {
    expect(BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS.credential)).toBe('Massenlauf angehalten: lynox findet keinen gespeicherten Zugang zum Zielsystem. Verbinde ihn unter Einstellungen → API-Verbindungen neu oder bitte lynox im Chat darum.');
    expect(BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS.unauthorized)).toBe('Massenlauf angehalten: Das Zielsystem hat den gespeicherten Zugang abgelehnt. Ist er unter Einstellungen → API-Verbindungen neu verbunden, lässt sich der Lauf fortsetzen.');
  });
});
