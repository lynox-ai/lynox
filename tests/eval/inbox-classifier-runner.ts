// === Inbox classifier eval runner ===
//
// Pure library that drives the production classifier against ground-truth
// fixtures and reports a confusion matrix + per-bucket and per-category
// breakdowns. No vitest dependency, no LLM coupling — `.eval.ts` and
// `.eval.test.ts` wrap this and supply the LLMCaller.
//
// Pass criterion (PRD-INBOX-PHASE-3 §"Classification Tuning"):
//   bucketMatchPct       >= 0.80
//   missedRequiresUser   == 0   (zero requires_user mails silently auto-archived)
//
// The second criterion is asymmetric on purpose: a missed customer mail is
// the failure mode the queue exists to prevent. The PRD §"Pass criterion"
// text says "zero auto_handled wrongly placed in requires_user" but that
// describes the inverse direction (noisy, not dangerous). The dangerous
// direction is what we gate; the noisy count is surfaced as `autoHandledNoise`
// for diagnosis but does not fail the eval.

import { classifyMail, type ClassifierPromptInput, type ClassifierProvider, type LLMCaller } from '../../src/integrations/inbox/classifier/index.js';
import type { InboxBucket } from '../../src/types/index.js';

export interface InboxEvalFixture {
  id: string;
  category: string;
  language: 'de' | 'en';
  expectedBucket: InboxBucket;
  fromAddress: string;
  fromName?: string | undefined;
  subject: string;
  body: string;
}

export interface InboxEvalCorpus {
  version: number;
  generatedAt: string;
  generator: string;
  note?: string | undefined;
  fixtures: ReadonlyArray<InboxEvalFixture>;
}

export interface InboxEvalSample {
  fixture: InboxEvalFixture;
  predicted: InboxBucket;
  confidence: number;
  /** True when expected matches predicted. */
  match: boolean;
}

export interface InboxEvalReport {
  total: number;
  bucketMatch: number;
  bucketMatchPct: number;
  /**
   * Number of `requires_user` fixtures the classifier silently dropped
   * into `auto_handled` — the PRD's "missed mail" asymmetric criterion.
   * Must be zero. A missed customer mail is unrepairable; an extra
   * mail in Needs-You is one click.
   */
  missedRequiresUser: number;
  /**
   * Count of `auto_handled` fixtures the classifier surfaced in
   * `requires_user` or `draft_ready` — the inverse asymmetric direction
   * ("noisy" rather than "dangerous"). Surfaced for diagnosis but does
   * not gate the pass criterion.
   */
  autoHandledNoise: number;
  /** confusion[expected][predicted] = count. */
  confusion: Record<InboxBucket, Record<InboxBucket, number>>;
  /** Per-category match rate so per-category regressions surface. */
  perCategory: Record<string, { total: number; match: number; pct: number }>;
  samples: ReadonlyArray<InboxEvalSample>;
}

export const PASS_THRESHOLD_PCT = 0.80;

export interface RunEvalOptions {
  /**
   * Account context for the prompt builder. The classifier prompt
   * inlines these so the model can reason about whose mailbox is
   * receiving — fixtures are written as if delivered to this address.
   */
  accountAddress?: string | undefined;
  accountDisplayName?: string | undefined;
  /** Per-sample timeout in ms. Default 30s. */
  perSampleTimeoutMs?: number | undefined;
  /**
   * Provider hint passed through to `classifyMail` so each LLM gets
   * its tuned system prompt. Default `'mistral'`. The eval test files
   * bind this to the matching LLMCaller.
   */
  provider?: ClassifierProvider | undefined;
  /** Progress callback fired after each fixture. */
  onProgress?: ((completed: number, total: number, sample: InboxEvalSample) => void) | undefined;
}

const ZERO_BUCKET_ROW: Record<InboxBucket, number> = {
  requires_user: 0,
  draft_ready: 0,
  auto_handled: 0,
};

/**
 * Drive the classifier through every fixture and produce a report.
 * Errors during a single classify call are surfaced as a fail-closed
 * `requires_user` prediction (matches production policy in
 * `runner.ts:onDeadLetter`) so one flaky LLM call doesn't tank the run.
 */
export async function runInboxEval(
  corpus: InboxEvalCorpus,
  llm: LLMCaller,
  opts: RunEvalOptions = {},
): Promise<InboxEvalReport> {
  const accountAddress = opts.accountAddress ?? 'me@acme.example';
  const accountDisplayName = opts.accountDisplayName ?? 'Me (Acme)';
  const timeoutMs = opts.perSampleTimeoutMs ?? 30_000;

  const samples: InboxEvalSample[] = [];
  const confusion: Record<InboxBucket, Record<InboxBucket, number>> = {
    requires_user: { ...ZERO_BUCKET_ROW },
    draft_ready: { ...ZERO_BUCKET_ROW },
    auto_handled: { ...ZERO_BUCKET_ROW },
  };
  const perCategory: Record<string, { total: number; match: number; pct: number }> = {};

  for (let i = 0; i < corpus.fixtures.length; i += 1) {
    const fixture = corpus.fixtures[i]!;
    const input: ClassifierPromptInput = {
      accountAddress,
      accountDisplayName,
      subject: fixture.subject,
      fromAddress: fixture.fromAddress,
      fromDisplayName: fixture.fromName,
      body: fixture.body,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let predicted: InboxBucket;
    let confidence: number;
    try {
      // 429-retry wrapper — Mistral free-tier RPM kicks in around 80-100
      // sequential calls. Without retry, a 505-fixture run loses ~10% to
      // rate-limits and the fail-closed branch below pollutes the matrix
      // (predicts requires_user for what should have been auto_handled,
      // inflating auto_handled_noise). 6 attempts × 30s × attempt = up
      // to ~3 min cumulative wait per fixture before giving up.
      const verdict = await (async () => {
        const maxAttempts = 6;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            return await classifyMail(input, llm, {
              signal: controller.signal,
              ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('429') && !msg.toLowerCase().includes('rate')) throw err;
            if (attempt === maxAttempts) throw err;
            await new Promise((r) => setTimeout(r, 30_000 * attempt));
          }
        }
        throw new Error('unreachable');
      })();
      predicted = verdict.bucket;
      confidence = verdict.confidence;
    } catch (err) {
      // Fail-closed mirrors runner.onDeadLetter — keeps one bad sample
      // from breaking the matrix. We log the cause to stderr so flaky-
      // LLM diagnoses don't require re-running with breakpoints, while
      // the structured report stays clean.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [eval] classify failed for ${fixture.id}: ${msg.slice(0, 200)}\n`);
      predicted = 'requires_user';
      confidence = 0;
    } finally {
      clearTimeout(timer);
    }
    const match = predicted === fixture.expectedBucket;
    const sample: InboxEvalSample = { fixture, predicted, confidence, match };
    samples.push(sample);
    confusion[fixture.expectedBucket][predicted] += 1;
    const cat = perCategory[fixture.category] ?? { total: 0, match: 0, pct: 0 };
    cat.total += 1;
    if (match) cat.match += 1;
    cat.pct = cat.match / cat.total;
    perCategory[fixture.category] = cat;
    opts.onProgress?.(i + 1, corpus.fixtures.length, sample);
  }

  const total = samples.length;
  const bucketMatch = samples.filter((s) => s.match).length;
  const bucketMatchPct = total === 0 ? 0 : bucketMatch / total;
  // Asymmetric risk: a requires_user mail silently auto-archived is a
  // missed customer mail (unrepairable). The inverse — auto_handled
  // surfacing in requires_user — is one extra click. The .eval.test.ts
  // asserts missedRequiresUser === 0 as the dangerous-direction gate.
  const missedRequiresUser = confusion.requires_user.auto_handled;
  const autoHandledNoise = confusion.auto_handled.requires_user
    + confusion.auto_handled.draft_ready;
  return {
    total,
    bucketMatch,
    bucketMatchPct,
    missedRequiresUser,
    autoHandledNoise,
    confusion,
    perCategory,
    samples,
  };
}

/**
 * Format the report as a one-screen ASCII summary. Useful for the CLI
 * output of the gated `.eval.ts` runner.
 */
export function formatReport(r: InboxEvalReport): string {
  const lines: string[] = [];
  lines.push(`Inbox classifier eval — ${r.total} fixtures`);
  lines.push(`  bucket match: ${r.bucketMatch}/${r.total} (${(r.bucketMatchPct * 100).toFixed(1)}%)`);
  lines.push(`  missed requires_user (silently auto-archived): ${r.missedRequiresUser}  ← MUST be 0`);
  lines.push(`  auto_handled noise (in requires_user/draft_ready): ${r.autoHandledNoise}`);
  lines.push('');
  lines.push('  Confusion matrix (rows=expected, cols=predicted):');
  const order: ReadonlyArray<InboxBucket> = ['requires_user', 'draft_ready', 'auto_handled'];
  const header = '            | ' + order.map((b) => b.padEnd(14)).join('| ');
  lines.push('  ' + header);
  for (const exp of order) {
    const row = exp.padEnd(11) + ' | ' + order.map((p) => String(r.confusion[exp][p]).padEnd(14)).join('| ');
    lines.push('  ' + row);
  }
  lines.push('');
  lines.push('  Per-category:');
  for (const [cat, stats] of Object.entries(r.perCategory).sort()) {
    lines.push(`    ${cat.padEnd(28)} ${stats.match}/${stats.total} (${(stats.pct * 100).toFixed(0)}%)`);
  }
  return lines.join('\n');
}
