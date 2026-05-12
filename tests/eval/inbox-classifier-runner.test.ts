// === Inbox classifier eval runner — contract tests ===
//
// Stub LLMCaller drives the eval pipeline so we can pin the confusion
// matrix + per-category bookkeeping shape without burning real tokens.
// Runs in every `vitest run` (no LYNOX_EVAL gate) — the companion
// `.eval.ts` does the real-LLM measurement.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMCaller } from '../../src/integrations/inbox/classifier/index.js';
import type { InboxBucket } from '../../src/types/index.js';
import {
  formatReport,
  runInboxEval,
  type InboxEvalCorpus,
} from './inbox-classifier-runner.js';

/**
 * Stub that returns whatever bucket a callback hands back. The classifier
 * prompt is opaque to the runner — we just need the LLM-shaped JSON the
 * parser expects. Key is `subject|fromAddress` so generated corpora with
 * duplicate subjects (Mistral happily writes 20 newsletters with the same
 * line) still resolve to the right fixture.
 */
function bucketStub(pick: (key: string) => InboxBucket): LLMCaller {
  return async ({ user }) => {
    // Prompt shape: "Absender: <from>" + newline + "Betreff: <subject>".
    const fromMatch = user.match(/Absender:\s*(.+)/);
    const subjMatch = user.match(/Betreff:\s*(.+)/);
    // The Absender line is `Name <addr>` or bare `addr` — keep the suffix
    // after the last `<` (or the whole string if no angles) for matching
    // against the fixture's fromAddress.
    const fromRaw = fromMatch?.[1]?.trim() ?? '';
    const fromAddr = fromRaw.includes('<')
      ? fromRaw.slice(fromRaw.lastIndexOf('<') + 1).replace(/>$/, '')
      : fromRaw;
    const subject = subjMatch?.[1]?.trim() ?? '';
    return JSON.stringify({
      bucket: pick(`${subject}|${fromAddr}`),
      confidence: 0.85,
      one_line_why_de: 'stub',
    });
  };
}

function fixtureKey(f: { subject: string; fromAddress: string }): string {
  return `${f.subject}|${f.fromAddress}`;
}

function loadCorpus(): InboxEvalCorpus {
  const raw = readFileSync(
    join(__dirname, 'inbox-classifier-fixtures.json'),
    'utf8',
  );
  return JSON.parse(raw) as InboxEvalCorpus;
}

describe('runInboxEval', () => {
  it('produces a 100% match when the stub mirrors expected buckets', async () => {
    const corpus = loadCorpus();
    // Pick the expected bucket by looking it up via subject.
    const expectedByKey = new Map(
      corpus.fixtures.map((f) => [fixtureKey(f), f.expectedBucket]),
    );
    const llm = bucketStub((key) => expectedByKey.get(key) ?? 'requires_user');
    const report = await runInboxEval(corpus, llm);
    expect(report.total).toBe(corpus.fixtures.length);
    expect(report.bucketMatch).toBe(corpus.fixtures.length);
    expect(report.bucketMatchPct).toBe(1);
    expect(report.confusion.requires_user.auto_handled).toBe(0);
    expect(report.confusion.auto_handled.requires_user).toBe(0);
  });

  it('counts auto_handled→other-bucket false-positives', async () => {
    const corpus = loadCorpus();
    // Stub always returns requires_user — every auto_handled fixture is
    // a "false positive" in PRD's asymmetric sense.
    const llm = bucketStub(() => 'requires_user');
    const report = await runInboxEval(corpus, llm);
    const autoHandledCount = corpus.fixtures.filter((f) => f.expectedBucket === 'auto_handled').length;
    expect(report.autoHandledNoise).toBe(autoHandledCount);
    // And the inverse: auto_handled column for the requires_user row is full.
    const requiresUserCount = corpus.fixtures.filter((f) => f.expectedBucket === 'requires_user').length;
    expect(report.confusion.requires_user.requires_user).toBe(requiresUserCount);
  });

  it('emits per-category breakdown matching the fixture categories', async () => {
    const corpus = loadCorpus();
    const llm = bucketStub(() => 'requires_user');
    const report = await runInboxEval(corpus, llm);
    const expectedCategories = new Set(corpus.fixtures.map((f) => f.category));
    expect(new Set(Object.keys(report.perCategory))).toEqual(expectedCategories);
    // Sum of per-category totals == fixture count.
    const sum = Object.values(report.perCategory).reduce((a, c) => a + c.total, 0);
    expect(sum).toBe(corpus.fixtures.length);
  });

  it('fail-closes (predicts requires_user) when the LLM throws', async () => {
    const corpus: InboxEvalCorpus = {
      version: 1,
      generatedAt: 'test',
      generator: 'test',
      fixtures: [
        {
          id: 'fail-1',
          category: 'failure',
          language: 'en',
          expectedBucket: 'auto_handled',
          fromAddress: 'a@b',
          subject: 's',
          body: 'b',
        },
      ],
    };
    const llm: LLMCaller = async () => { throw new Error('synthetic'); };
    const report = await runInboxEval(corpus, llm);
    expect(report.samples[0]?.predicted).toBe('requires_user');
    expect(report.samples[0]?.confidence).toBe(0);
  });

  it('formats a one-screen ASCII report', async () => {
    const corpus = loadCorpus();
    const llm = bucketStub((key) => corpus.fixtures.find((f) => fixtureKey(f) === key)?.expectedBucket ?? 'requires_user');
    const report = await runInboxEval(corpus, llm);
    const out = formatReport(report);
    expect(out).toContain('Inbox classifier eval');
    expect(out).toContain('Confusion matrix');
    expect(out).toContain('Per-category');
  });
});

describe('inbox-classifier-fixtures.json — corpus shape', () => {
  it('contains at least 12 fixtures with balanced bucket coverage', () => {
    const corpus = loadCorpus();
    expect(corpus.fixtures.length).toBeGreaterThanOrEqual(12);
    const counts = corpus.fixtures.reduce<Record<string, number>>(
      (acc, f) => ({ ...acc, [f.expectedBucket]: (acc[f.expectedBucket] ?? 0) + 1 }),
      {},
    );
    // Seed corpus pins the three-bucket coverage — generator should preserve.
    expect(counts['requires_user']).toBeGreaterThan(0);
    expect(counts['auto_handled']).toBeGreaterThan(0);
    expect(counts['draft_ready']).toBeGreaterThan(0);
  });

  it('majority of fixtures use placeholder-looking sender domains', () => {
    // Coarse smell-test at the test layer — the dedicated lint script
    // (scripts/inbox-eval-lint.ts) is the authoritative anti-PII check.
    // Mistral-generated corpora occasionally invent non-`*.example`
    // TLDs (per `antiPiiNote` in the fixture header); we just want to
    // know the corpus didn't fully drift away from the allowlist.
    const corpus = loadCorpus();
    const allowlisted = corpus.fixtures.filter((f) => /example|acme|mustermann|beispiel/i.test(f.fromAddress));
    expect(allowlisted.length / corpus.fixtures.length).toBeGreaterThan(0.5);
  });
});
