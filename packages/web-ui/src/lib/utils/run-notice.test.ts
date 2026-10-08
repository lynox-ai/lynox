import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { composeRunNotice, type RunNoticeInput } from './run-notice.js';
import { fillTemplate } from '../i18n-fill.js';

/**
 * Every shape the run notice can take, with the REAL German and English strings.
 *
 * ⚠ This file exists because the composition was wrong twice, and both times the defect
 * was only visible once rendered: a marker ending in a colon followed by the wrong
 * amount, and a marker promising "the cost below" in the branch that prints no cost. A
 * source-level check of the view could not see either — the strings live in another file
 * and the concatenation only misleads when read.
 *
 * So the assertions are about the SENTENCE: what it claims about money, and whether it
 * claims anything it does not then print.
 */
describe('the run notice, rendered', () => {
  /**
   * The REAL strings, read out of `i18n.svelte.ts` the way its sibling tests read it — the
   * table is not exported and the module is a Svelte rune file, so text is the instrument
   * here. The fill is the real `fillTemplate`, not a re-implementation: a control built
   * from a copy of the subject proves nothing about the subject.
   */
  const I18N = readFileSync(`${fileURLToPath(new URL('.', import.meta.url))}../i18n.svelte.ts`, 'utf8');

  function translator(lang: 'de' | 'en'): (key: string, vars?: Record<string, string>) => string {
    return (key: string, vars?: Record<string, string>) => {
      // One line per key in that file: `'key': { de: '…', en: '…' },`
      const line = I18N.split('\n').find(l => l.includes(`'${key}'`));
      if (line === undefined) throw new Error(`missing i18n key: ${key}`);
      const m = new RegExp(`${lang}: '((?:[^'\\\\]|\\\\.)*)'`).exec(line);
      if (m === null) throw new Error(`no ${lang} string for ${key}: ${line}`);
      const text = m[1]!.replace(/\\'/g, "'");
      return vars === undefined ? text : fillTemplate(text, vars);
    };
  }

  const LANGS = ['de', 'en'] as const;
  const render = (data: RunNoticeInput, lang: 'de' | 'en'): { kind: string; text: string } =>
    composeRunNotice(data, translator(lang));

  it('the fixture really reads the shipped strings', () => {
    // A positive control on the INSTRUMENT: if the parse silently failed, every assertion
    // below would be about a key name rather than a sentence, and most of them would still
    // pass. Both languages, and a key with a slot.
    const de = translator('de');
    const en = translator('en');
    expect(de('workflow_library.run_done')).toBe('Workflow abgeschlossen.');
    expect(en('workflow_library.run_done')).toBe('Workflow completed.');
    expect(de('workflow_library.run_restarted_cost', { cost: '$1.0000' })).toContain('$1.0000');
    expect(() => de('workflow_library.not_a_real_key')).toThrow(/missing i18n key/);
  });

  it('a first run shows its own cost and claims nothing about an earlier attempt', () => {
    for (const lang of LANGS) {
      const { kind, text } = render({ status: 'completed', costUsd: 0.12 }, lang);
      expect(kind).toBe('notice');
      expect(text).toContain('$0.1200');
      expect(text.toLowerCase()).not.toMatch(/earlier|früher|neu gestartet|restarted/);
    }
  });

  it('a RESTART whose earlier attempt cost nothing does not announce a charge', () => {
    // The defect this kills: the earlier version omitted the amount in exactly this case
    // and ended its sentence in a colon, so this run's cost was read as the earlier one's.
    for (const lang of LANGS) {
      const { text } = render(
        { status: 'completed', costUsd: 0.12, restartedFrom: 'run-a', previousCostUsd: 0 }, lang,
      );
      // It says there was an earlier attempt…
      expect(text.toLowerCase()).toMatch(/früher|earlier/);
      // …and it must NOT present 0.1200 as that attempt's cost. The amount appears once,
      // in the position every other notice uses for the current run's spend.
      expect(text.match(/\$0\.1200/g) ?? []).toHaveLength(1);
      expect(text, 'no label may be left pointing at the next thing in the string')
        .not.toMatch(/[:：]\s*\(/);
      expect(text).not.toMatch(/:\s*$/);
    }
  });

  it('a RESTART with a real earlier cost names BOTH amounts and keeps them apart', () => {
    for (const lang of LANGS) {
      const { text } = render(
        { status: 'completed', costUsd: 0.12, restartedFrom: 'run-a', previousCostUsd: 0.3 }, lang,
      );
      expect(text).toContain('$0.3000');
      expect(text).toContain('$0.1200');
      // The earlier amount sits INSIDE the sentence that explains it, before this run's.
      expect(text.indexOf('$0.3000')).toBeLessThan(text.indexOf('$0.1200'));
    }
  });

  it('a restarted run that FAILS still discloses the earlier spend', () => {
    // The branch that prints no cost of its own — and the one the first version forgot.
    for (const lang of LANGS) {
      const { kind, text } = render(
        { status: 'failed', error: 'step 1 blew up', restartedFrom: 'run-a', previousCostUsd: 0.3 }, lang,
      );
      expect(kind).toBe('error');
      expect(text).toContain('$0.3000');
      expect(text).toContain('step 1 blew up');
    }
  });

  it('no marker promises an amount in a branch that prints none', () => {
    // The second defect: "the cost below is that run's" in a failed notice, where there is
    // no cost below. Asserted as a property of every failing shape rather than of one.
    for (const lang of LANGS) {
      for (const data of [
        { status: 'failed', error: 'x', idempotent: true },
        { status: 'failed', error: 'x', restartedFrom: 'run-a', previousCostUsd: 0 },
        { status: 'rejected', error: 'x', idempotent: true },
      ] satisfies RunNoticeInput[]) {
        const { text } = render(data, lang);
        expect(text, `"${text}" names a cost it does not show`).not.toMatch(/\$\d/);
        expect(text.toLowerCase()).not.toMatch(/unten|below/);
      }
    }
  });

  it('a REPLAY that SHOWS a cost says the cost is the earlier run\'s', () => {
    // The caveat is what keeps a replayed amount from reading as a fresh charge, and it
    // belongs only where an amount is printed. This file has seen both failures: the
    // promise in a branch with no number, and the promise removed from the branch that
    // has one.
    for (const lang of LANGS) {
      const { kind, text } = render({ status: 'completed', costUsd: 0.25, idempotent: true }, lang);
      expect(kind).toBe('notice');
      expect(text.toLowerCase()).toMatch(/früher|earlier/);
      expect(text).toContain('$0.2500');
      expect(text.toLowerCase(), 'the amount has to be named as the earlier run\'s')
        .toMatch(/kosten|cost/);
    }
  });

  it('a FAILED replay uses the plain wording, not the one that names a cost', () => {
    // ⚠ The failed branch passes `printsCost: false`, and flipping that literal to `true`
    // left this whole file green — so the branch the commit said it was repairing had no
    // witness at all. The no-number case was covered only inside the COMPLETED branch, at
    // `costUsd: 0`, which is a different line of code.
    for (const lang of LANGS) {
      const { kind, text } = render({ status: 'failed', error: 'boom', idempotent: true }, lang);
      expect(kind).toBe('error');
      expect(text.toLowerCase()).toMatch(/früher|earlier/);
      expect(text, 'a branch that prints no amount may not mention one').not.toMatch(/\$\d/);
      expect(text.toLowerCase(), 'and must not name a cost at all')
        .not.toMatch(/die kosten sind|the cost is/);
    }
  });

  it('a REPLAY with NO cost to show promises nothing about one', () => {
    // A completed replay whose run cost zero prints no amount, so it must use the plain
    // wording — the conditional is the point, not the wording.
    for (const lang of LANGS) {
      const { text } = render({ status: 'completed', costUsd: 0, idempotent: true }, lang);
      expect(text.toLowerCase()).toMatch(/früher|earlier/);
      expect(text, 'nothing may be said about a cost that is not shown').not.toMatch(/\$\d/);
      expect(text.toLowerCase()).not.toMatch(/kosten sind|cost is/);
    }
  });

  it('replay wins over restart when the server sends both', () => {
    // `idempotent` means no run happened now; `restartedFrom` would claim one did. They
    // cannot both be true, and if a future route sends both, the notice must not say the
    // run was restarted when nothing ran.
    for (const lang of LANGS) {
      const { text } = render(
        { status: 'completed', costUsd: 0.25, idempotent: true, restartedFrom: 'run-a', previousCostUsd: 0.3 }, lang,
      );
      expect(text).not.toContain('$0.3000');
    }
  });

  it('non-fatal step errors stay in the GREEN banner of a completed run', () => {
    for (const lang of LANGS) {
      const { kind, text } = render(
        { status: 'completed', costUsd: 0.1, stepErrors: [{ stepId: 's2', error: 'soft fail', costUsd: 0 }] }, lang,
      );
      expect(kind).toBe('notice');
      expect(text).toContain('s2: soft fail');
    }
  });

  it('a step error with no message is not rendered as an empty detail', () => {
    for (const lang of LANGS) {
      const { text } = render(
        { status: 'completed', costUsd: 0.1, stepErrors: [{ stepId: 's2', error: '', costUsd: 0 }] }, lang,
      );
      expect(text).not.toContain('s2');
      expect(text).not.toMatch(/—\s*$/);
    }
  });
});
