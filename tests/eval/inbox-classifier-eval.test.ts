// === Inbox classifier — gated LLM eval ===
//
// Hits the real Mistral EU caller (PRD §"EU-residency pin"). SKIPPED in
// every default `vitest run` — opt in with:
//
//   LYNOX_EVAL=1 MISTRAL_API_KEY=... npx vitest run tests/eval/inbox-classifier.eval.ts
//
// PRD pass criterion: bucketMatchPct >= 0.80. The seed fixture file is
// hand-crafted; expand to ≥100 via scripts/inbox-eval-gen.ts before
// trusting the percentage as a regression gate.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMistralEuLLMCaller } from '../../src/integrations/inbox/classifier/llm-mistral.js';
import {
  formatReport,
  PASS_THRESHOLD_PCT,
  runInboxEval,
  type InboxEvalCorpus,
} from './inbox-classifier-runner.js';

const enabled = process.env['LYNOX_EVAL'] === '1';
const apiKey = process.env['MISTRAL_API_KEY'];
if (enabled && !apiKey) {
  // eslint-disable-next-line no-console
  console.warn('LYNOX_EVAL=1 set but MISTRAL_API_KEY missing — inbox-classifier eval skipped');
}

const describeOrSkip = enabled && apiKey ? describe : describe.skip;

/**
 * The `draft_ready` fixtures this provider files as `auto_handled`, as last measured: ONE run of
 * `mistral-small-2603` on 2026-10-17, prompt and runner at core `fab06f98` (505 fixtures). One
 * run is a current state, not a variance bound; how much this set moves between runs is not
 * measured. Pinned as a SET, not as a count: a run where one of these heals and another
 * `draft_ready` mail is lost keeps the count and changes the set, and that must fail. A run that
 * heals one fails too; then this list shrinks, deliberately, in the same change.
 */
const KNOWN_DRAFT_READY_AUTO_HANDLED: ReadonlyArray<string> = [
  'colleague-question-en-266',
  'colleague-question-en-275',
  'info-share-en-390',
  'info-share-de-399',
  'info-share-de-407',
  'info-share-de-411',
  'info-share-de-415',
  'out-of-office-de-504',
];

describeOrSkip('inbox-classifier eval (Mistral EU)', () => {
  it('meets the PRD pass criterion against the committed corpus', async () => {
    const raw = readFileSync(
      join(__dirname, 'inbox-classifier-fixtures.json'),
      'utf8',
    );
    const corpus = JSON.parse(raw) as InboxEvalCorpus;
    const llm = createMistralEuLLMCaller({ apiKey: apiKey! });
    const report = await runInboxEval(corpus, llm, {
      provider: 'mistral',
      onProgress: (i, n) => {
        if (i % 10 === 0 || i === n) {
          process.stdout.write(`  [eval] ${i}/${n}\n`);
        }
      },
    });
    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(report) + '\n');
    // The lost mails first, so a run that loses one names it whatever else fails.
    expect(report.missedRequiresUserIds).toEqual([]);
    expect(report.bucketMatchPct).toBeGreaterThanOrEqual(PASS_THRESHOLD_PCT);
    // PRD asymmetric criterion: a requires_user item silently bucketed
    // as auto_handled is a missed mail (unrepairable). The reverse —
    // auto_handled mail landing in requires_user — is one extra click.
    expect(report.missedRequiresUser).toBe(0);
    // Compared as sorted sets: the report lists corpus order, the pin is grouped by family.
    expect([...report.draftReadyAutoHandledIds].sort()).toEqual([...KNOWN_DRAFT_READY_AUTO_HANDLED].sort());
  }, 15 * 60 * 1000);
});
