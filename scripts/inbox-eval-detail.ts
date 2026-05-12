// One-off diagnostic: re-runs the eval and prints per-fixture mismatches
// (especially the auto_handled false-negatives) so the operator can see
// which specific subjects+bodies the classifier is silently archiving.
//
// Usage: MISTRAL_API_KEY=... npx tsx scripts/inbox-eval-detail.ts

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createMistralEuLLMCaller } from '../src/integrations/inbox/classifier/llm-mistral.js';
import { createHaikuLLMCaller } from '../src/integrations/inbox/classifier/llm.js';
import type { LLMCaller } from '../src/integrations/inbox/classifier/index.js';
import {
  runInboxEval,
  type InboxEvalCorpus,
} from '../tests/eval/inbox-classifier-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, '..', 'tests', 'eval', 'inbox-classifier-fixtures.json');

type Provider = 'mistral' | 'haiku';

function buildLlm(provider: Provider): LLMCaller {
  const raw = readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8');
  const config = JSON.parse(raw) as Record<string, string>;
  if (provider === 'haiku') {
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? config['anthropic_api_key'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing — set env or config.json:anthropic_api_key');
    return createHaikuLLMCaller({ apiKey });
  }
  const apiKey = process.env['MISTRAL_API_KEY'] ?? config['mistral_api_key'];
  if (!apiKey) throw new Error('MISTRAL_API_KEY missing — set env or config.json:mistral_api_key');
  return createMistralEuLLMCaller({ apiKey });
}

async function main(): Promise<void> {
  const providerArg = process.argv.indexOf('--provider');
  const provider: Provider = providerArg !== -1 && process.argv[providerArg + 1] === 'haiku' ? 'haiku' : 'mistral';

  const corpus = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as InboxEvalCorpus;
  const llm = buildLlm(provider);
  const promptProvider = provider === 'haiku' ? 'anthropic' : 'mistral';

  process.stdout.write(`Provider: ${provider} (prompt: ${promptProvider})\nRunning eval over ${corpus.fixtures.length} fixtures…\n`);
  const report = await runInboxEval(corpus, llm, {
    provider: promptProvider,
    onProgress: (i, n) => {
      if (i % 20 === 0 || i === n) process.stdout.write(`  ${i}/${n}\n`);
    },
  });
  process.stdout.write('\n=== Missed requires_user (DANGEROUS — silently auto_handled) ===\n');
  const missed = report.samples.filter(
    (s) => s.fixture.expectedBucket === 'requires_user' && s.predicted === 'auto_handled',
  );
  for (const s of missed) {
    process.stdout.write(`\n[${s.fixture.id}] (${s.fixture.category}, ${s.fixture.language})\n`);
    process.stdout.write(`  From: ${s.fixture.fromName ?? ''} <${s.fixture.fromAddress}>\n`);
    process.stdout.write(`  Subject: ${s.fixture.subject}\n`);
    process.stdout.write(`  Body: ${s.fixture.body.slice(0, 200).replace(/\n/g, ' ')}…\n`);
    process.stdout.write(`  Predicted: ${s.predicted} (confidence ${s.confidence.toFixed(2)})\n`);
  }
  process.stdout.write(`\nTotal missed: ${missed.length}\n`);

  process.stdout.write('\n=== requires_user → draft_ready (not dangerous, but lost urgency) ===\n');
  const downgraded = report.samples.filter(
    (s) => s.fixture.expectedBucket === 'requires_user' && s.predicted === 'draft_ready',
  );
  for (const s of downgraded.slice(0, 5)) {
    process.stdout.write(`  [${s.fixture.id}] ${s.fixture.category} / ${s.fixture.subject.slice(0, 60)}\n`);
  }
  process.stdout.write(`(${downgraded.length} total)\n`);

  process.stdout.write('\n=== draft_ready → auto_handled (also dangerous) ===\n');
  const draftMissed = report.samples.filter(
    (s) => s.fixture.expectedBucket === 'draft_ready' && s.predicted === 'auto_handled',
  );
  for (const s of draftMissed) {
    process.stdout.write(`  [${s.fixture.id}] ${s.fixture.category} / ${s.fixture.subject.slice(0, 60)}\n`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
