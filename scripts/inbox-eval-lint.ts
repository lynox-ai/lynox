#!/usr/bin/env npx tsx
/**
 * Anti-PII lint for the inbox-classifier eval corpus
 * (PRD-INBOX-PHASE-3 §"Anti-PII spot-check pre-commit").
 *
 * The Phase-2 labeler is instructed to use placeholder names only, but
 * Mistral occasionally leaks real-looking patterns. This script greps
 * the committed JSON for:
 *
 *   - lynox.* / brandfusion.* domains (operator infra leak)
 *   - "real first-name + last-name" pairs not in the Mustermann/
 *     Beispiel allowlist
 *   - non-example top-level domains in sender addresses
 *
 * Allowed placeholders:
 *   - Mustermann (Max, Erika, …)
 *   - Beispiel
 *   - Acme (in company / vendor names)
 *   - *.example, example.* TLDs
 *
 * Run BEFORE committing a regenerated fixture file:
 *   npx tsx scripts/inbox-eval-lint.ts
 *
 * Exit codes:
 *   0  — clean
 *   1  — at least one finding the operator must review/replace
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, '..', 'tests', 'eval', 'inbox-classifier-fixtures.json');

export interface Fixture {
  id: string;
  fromAddress: string;
  fromName?: string;
  subject: string;
  body: string;
}

const ALLOWED_LAST_NAMES = new Set(['mustermann', 'beispiel', 'acme', 'tester']);
const SAFE_DOMAINS = /\.example(\.[a-z]{2})?$|\bexample\.[a-z]{2,}$/i;
const DANGEROUS_DOMAINS = /\b(lynox|brandfusion)\.[a-z]{2,}\b/i;

export interface LintFinding {
  fixtureId: string;
  where: 'fromAddress' | 'fromName' | 'subject' | 'body';
  text: string;
  reason: string;
}

export function lintCorpus(fixtures: ReadonlyArray<Fixture>): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const f of fixtures) {
    // 1. Dangerous-domain canary (never allowed even with replacement).
    for (const where of ['fromAddress', 'fromName', 'subject', 'body'] as const) {
      const value = (f[where] ?? '') as string;
      if (DANGEROUS_DOMAINS.test(value)) {
        findings.push({
          fixtureId: f.id,
          where,
          text: value,
          reason: 'contains lynox.* or brandfusion.* domain — REJECT, replace with example.* placeholder',
        });
      }
    }
    // 2. fromAddress domain check (must end in *.example or be allow-listed).
    const fromDomain = f.fromAddress.split('@')[1] ?? '';
    if (fromDomain.length > 0 && !SAFE_DOMAINS.test(fromDomain) && !fromDomain.endsWith('.example')) {
      findings.push({
        fixtureId: f.id,
        where: 'fromAddress',
        text: f.fromAddress,
        reason: `domain "${fromDomain}" is not a *.example placeholder — manual review`,
      });
    }
    // 3. Real-looking surname check in fromName — only when the sender
    // is a PERSON (heuristic: local-part contains a dot like first.last
    // or matches a personal-name regex). Brand senders (newsletter@,
    // support@, noreply@, billing@, receipts@) get their fromName from
    // the company, not a person, so "Acme Shop" / "Acme Logistics" /
    // "Acme Dienstleister AG" are valid brand names, not surname leaks.
    const fromName = (f.fromName ?? '').trim();
    const localPart = f.fromAddress.split('@')[0] ?? '';
    // Role-address allowlist — when the local-part's first segment is
    // one of these the fromName is conceptually a brand, not a person,
    // so multi-word capitalised names ("Acme Vendor Support") are
    // legitimate. The `.split('.')[0]` deliberately handles dotted role
    // prefixes (`support.team@`, `billing.eu@`) as roles too.
    const ROLE_PREFIXES = /^(newsletter|news|noreply|no-reply|support|billing|receipts|info|hello|contact|admin|events|marketing|promo|sales|team|notifications|orders|shipping|tracking)$/i;
    const looksPersonal = localPart.includes('.') && !ROLE_PREFIXES.test(localPart.split('.')[0] ?? '');
    if (fromName.length > 0 && looksPersonal) {
      const parts = fromName.split(/\s+/).filter((w) => /^[A-ZÄÖÜ][a-zäöü-]+$/.test(w));
      if (parts.length >= 2) {
        const last = parts[parts.length - 1]!.toLowerCase();
        if (!ALLOWED_LAST_NAMES.has(last)) {
          findings.push({
            fixtureId: f.id,
            where: 'fromName',
            text: fromName,
            reason: `surname "${parts[parts.length - 1]}" is not in the Mustermann/Beispiel/Acme allowlist — replace`,
          });
        }
      }
    }
  }
  return findings;
}

function main(): void {
  const raw = readFileSync(FIXTURES_PATH, 'utf8');
  const corpus = JSON.parse(raw) as { fixtures: Fixture[] };
  const findings = lintCorpus(corpus.fixtures);
  if (findings.length === 0) {
    process.stdout.write(`✓ inbox-eval-lint clean (${corpus.fixtures.length} fixtures)\n`);
    process.exit(0);
  }
  process.stderr.write(`✗ inbox-eval-lint: ${findings.length} findings\n\n`);
  for (const f of findings) {
    process.stderr.write(`[${f.fixtureId}] ${f.where}: ${f.text}\n  → ${f.reason}\n\n`);
  }
  process.exit(1);
}

// Only run main() when invoked directly (`npx tsx scripts/inbox-eval-lint.ts`)
// — importing the module from a test must NOT call process.exit().
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
