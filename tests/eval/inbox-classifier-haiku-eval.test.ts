// === Inbox classifier — gated Anthropic Haiku eval (US-default model) ===
//
// Companion to inbox-classifier-eval.test.ts. Same runner, same corpus —
// different LLM. Run with:
//
//   LYNOX_EVAL=1 ANTHROPIC_API_KEY=... npx vitest run \
//     tests/eval/inbox-classifier-haiku-eval.test.ts
//
// Asserts the same PRD pass criterion (bucket match >= 0.80,
// missed_requires_user === 0) and prints the same confusion matrix.
// Lets the operator compare quality between the EU (Mistral) and US
// (Haiku) classifier defaults on identical ground truth.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHaikuLLMCaller } from '../../src/integrations/inbox/classifier/llm.js';
import {
  formatReport,
  PASS_THRESHOLD_PCT,
  runInboxEval,
  type InboxEvalCorpus,
} from './inbox-classifier-runner.js';

const enabled = process.env['LYNOX_EVAL'] === '1';
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (enabled && !apiKey) {
  // eslint-disable-next-line no-console
  console.warn('LYNOX_EVAL=1 set but ANTHROPIC_API_KEY missing — Haiku eval skipped');
}

const describeOrSkip = enabled && apiKey ? describe : describe.skip;

describeOrSkip('inbox-classifier eval (Anthropic Haiku)', () => {
  it('meets the PRD pass criterion against the committed corpus', async () => {
    const raw = readFileSync(
      join(__dirname, 'inbox-classifier-fixtures.json'),
      'utf8',
    );
    const corpus = JSON.parse(raw) as InboxEvalCorpus;
    const llm = createHaikuLLMCaller({ apiKey: apiKey! });
    const report = await runInboxEval(corpus, llm, {
      onProgress: (i, n) => {
        if (i % 10 === 0 || i === n) {
          process.stdout.write(`  [eval] ${i}/${n}\n`);
        }
      },
    });
    // eslint-disable-next-line no-console
    console.log('\n=== HAIKU ===\n' + formatReport(report) + '\n');
    expect(report.bucketMatchPct).toBeGreaterThanOrEqual(PASS_THRESHOLD_PCT);
    expect(report.missedRequiresUser).toBe(0);
  }, 5 * 60 * 1000);
});
