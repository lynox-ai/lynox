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
    expect(report.bucketMatchPct).toBeGreaterThanOrEqual(PASS_THRESHOLD_PCT);
    // PRD asymmetric criterion: a requires_user item silently bucketed
    // as auto_handled is a missed mail (unrepairable). The reverse —
    // auto_handled mail landing in requires_user — is one extra click.
    expect(report.missedRequiresUser).toBe(0);
  }, 15 * 60 * 1000);
});
