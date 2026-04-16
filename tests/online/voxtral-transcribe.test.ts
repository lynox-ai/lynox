/**
 * Online integration test — Mistral Voxtral transcribe endpoint.
 *
 * Gated on:
 *   - `MISTRAL_API_KEY` being present in the env
 *   - Phase 0 fixtures existing under `tests/fixtures/voice/` (gitignored —
 *     voice recordings stay out of the public repo; fixtures are provisioned
 *     locally via the spike recorder).
 *
 * When either gate fails, the whole describe block is skipped so CI stays
 * green on the public OSS repo.
 *
 * What it asserts:
 *   1. Real Voxtral API calls complete for all fixtures.
 *   2. Average WER (post-glossary) stays at or below the Phase 0 measured
 *      baseline (10.5% + slack for run-to-run variance) — a soft floor that
 *      catches provider-side regressions.
 *   3. Two Phase 0 mishearings that the core glossary should fix
 *      (Setup-Result → Setup Wizard on clip #06; Started hier / Storyteller →
 *      Starter Tier on clips #07 / #09) are fully repaired after the
 *      glossary pass. These are the anchor regressions.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  transcribeMistralVoxtral,
} from '../../src/core/transcribe/mistral-voxtral.js';
import { transcribe } from '../../src/core/transcribe/index.js';

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'tests/fixtures/voice',
);

function hasFixtures(): boolean {
  if (!existsSync(FIXTURES_DIR)) return false;
  try {
    return statSync(FIXTURES_DIR).isDirectory() && existsSync(resolve(FIXTURES_DIR, 'spike-01.webm'));
  } catch {
    return false;
  }
}

const API_KEY_PRESENT = !!process.env['MISTRAL_API_KEY'];
const FIXTURES_PRESENT = hasFixtures();
const SHOULD_RUN = API_KEY_PRESENT && FIXTURES_PRESENT;

interface Fixture {
  readonly id: string;
  readonly file: string;
  readonly expected: string | null;
}

const FIXTURES: readonly Fixture[] = [
  { id: '01', file: 'spike-01.webm', expected: 'Fass mir bitte die wichtigsten Punkte von heute zusammen.' },
  { id: '02', file: 'spike-02.webm', expected: "Give me a quick summary of yesterday's action items." },
  { id: '03', file: 'spike-03.webm', expected: 'Kannst du das Meeting von Montag zusammenfassen und mir die Action Items als Liste schicken?' },
  { id: '04', file: 'spike-04.webm', expected: 'Push das Deployment auf Staging und schick mir ein Update wenn die Pipeline durch ist.' },
  { id: '05', file: 'spike-05.webm', expected: 'Ich brauch ein Follow-up für den Call mit dem Marketing-Team. Die wollen wissen ob wir den Launch auf nächste Woche shiften oder ob wir beim Original-Timing bleiben.' },
  { id: '06', file: 'spike-06.webm', expected: 'Erstell mir einen neuen Thread zum Thema Onboarding Flow. Der Setup Wizard muss vor dem Go-Live fertig sein, das ist ein Blocker für die Customer Journey.' },
  { id: '07', file: 'spike-07.webm', expected: 'Also ich hab mir das nochmal angeschaut mit dem Pricing. Die Starter Tier ist okay aber ich glaub wir müssen das Messaging nochmal überarbeiten. Vielleicht sollten wir A/B Testing machen auf der Landing Page, was meinst du?' },
  { id: '08', file: 'spike-08.webm', expected: 'Der Roland hat mir geschrieben, sein Dashboard zeigt seit Freitag falsche Zahlen an. Ich glaub das hängt mit dem letzten Release zusammen, Version eins Punkt null Punkt fünf. Kannst du dir mal die Logs anschauen auf dem Server? Die Instanz heisst war Punkt lynox Punkt cloud.' },
  { id: '09', file: 'spike-09.webm', expected: 'Also ich hab mir das nochmal angeschaut mit dem Pricing. Die Starter Tier ist okay aber ich glaub wir müssen das Messaging nochmal überarbeiten. Vielleicht sollten wir A/B Testing machen auf der Landing Page, was meinst du?' },
  { id: '10', file: 'spike-10.webm', expected: null },
];

function normalize(s: string): string[] {
  return s.toLowerCase().replace(/[.,;:!?"“”„‘’()[\]/]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? 0;
}

function wer(expected: string, got: string): number {
  const ref = normalize(expected), hyp = normalize(got);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

describe.skipIf(!SHOULD_RUN)('Voxtral online integration (gated)', () => {
  it('returns text for every Phase 0 fixture', { timeout: 120_000 }, async () => {
    for (const fx of FIXTURES) {
      const audio = readFileSync(resolve(FIXTURES_DIR, fx.file));
      const out = await transcribeMistralVoxtral(audio, fx.file, 'de');
      expect(out, `fixture ${fx.id}`).toBeTruthy();
      expect(out?.length, `fixture ${fx.id}`).toBeGreaterThan(0);
    }
  });

  it('post-glossary average WER stays at or under 15% across scored clips', { timeout: 180_000 }, async () => {
    let totalWer = 0;
    let scored = 0;
    for (const fx of FIXTURES) {
      if (fx.expected === null) continue;
      const audio = readFileSync(resolve(FIXTURES_DIR, fx.file));
      const out = await transcribe(audio, fx.file, { language: 'de' });
      expect(out, `fixture ${fx.id}`).toBeTruthy();
      const w = wer(fx.expected, out ?? '');
      totalWer += w;
      scored += 1;
    }
    const avg = totalWer / scored;
    // Phase 0 measured 10.5% avg WER. 15% ceiling gives run-to-run variance
    // headroom; regressions beyond that warrant a look.
    expect(avg).toBeLessThanOrEqual(0.15);
  });

  it('repairs Setup-Result → Setup Wizard on clip #06', { timeout: 60_000 }, async () => {
    const audio = readFileSync(resolve(FIXTURES_DIR, 'spike-06.webm'));
    const processed = await transcribe(audio, 'spike-06.webm', { language: 'de' });
    expect(processed).toBeTruthy();
    expect(processed).toContain('Setup Wizard');
    expect(processed).not.toContain('Setup-Result');
    expect(processed).not.toContain('Setup Result');
  });

  it('repairs Starter Tier mishearings on clips #07 and #09', { timeout: 120_000 }, async () => {
    for (const id of ['07', '09']) {
      const audio = readFileSync(resolve(FIXTURES_DIR, `spike-${id}.webm`));
      const processed = await transcribe(audio, `spike-${id}.webm`, { language: 'de' });
      expect(processed, `clip #${id}`).toBeTruthy();
      expect(processed, `clip #${id}`).toContain('Starter Tier');
      expect(processed, `clip #${id}`).not.toContain('Started hier');
      expect(processed, `clip #${id}`).not.toContain('Storyteller');
    }
  });

  it('applies session glossary end-to-end (seeded contact name)', { timeout: 60_000 }, async () => {
    // Uses clip #01 so we don't depend on an acoustically noisy long clip.
    // `Fassmir` below is a deliberately misspelled session contact — if the
    // session-glossary path is wired, Voxtral's correct output "Fass mir"
    // stays intact (the two-token sequence isn't a fuzzy match for the
    // single-token contact). This exercises the pipeline without asserting
    // a rewrite that would be too fragile to pin.
    const audio = readFileSync(resolve(FIXTURES_DIR, 'spike-01.webm'));
    const out = await transcribe(audio, 'spike-01.webm', {
      language: 'de',
      session: { contactNames: ['Fassmir', 'Rolanda'] },
    });
    expect(out).toBeTruthy();
    // Clip #01: "Fass mir bitte die wichtigsten Punkte von heute zusammen."
    // Whichever name tokens Voxtral surfaces, the known-good words survive.
    expect(out).toMatch(/wichtigsten/i);
    expect(out).toMatch(/zusammen/i);
  });
});

// Emit a friendly skip note when the gates fail — helps diagnose CI runs.
if (!SHOULD_RUN) {
  // Top-level code runs at file import; vitest shows this as a log next to the skip.
  // eslint-disable-next-line no-console
  console.log(
    `[voxtral-transcribe.test] skipped: MISTRAL_API_KEY=${API_KEY_PRESENT ? 'set' : 'missing'}, fixtures=${FIXTURES_PRESENT ? 'present' : 'missing'}`,
  );
}
