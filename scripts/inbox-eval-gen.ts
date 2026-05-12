#!/usr/bin/env npx tsx
/**
 * Two-phase inbox-classifier corpus generator (PRD-INBOX-PHASE-3
 * §"Classification Tuning — synthetic eval, gen-once-commit").
 *
 * Phase 1 generates per-category synthetic mails (subject + from + body)
 * via Mistral EU; Phase 2 re-reads each mail in fresh context and emits
 * the ground-truth bucket. The split prevents "cheat-and-match" where
 * the generator picks the label it already pre-committed.
 *
 * Usage:
 *   MISTRAL_API_KEY=... npx tsx scripts/inbox-eval-gen.ts            # full ~120-mail run
 *   MISTRAL_API_KEY=... npx tsx scripts/inbox-eval-gen.ts --dry 12   # smoke run (~12 total)
 *
 * Output (overwrites): core/tests/eval/inbox-classifier-fixtures.json
 *
 * Anti-PII: after Phase 2 the operator MUST run
 *   npx tsx scripts/inbox-eval-lint.ts
 * which greps for real-looking names/domains. Mustermann / Acme /
 * example.com are allowed placeholders; first-name+last-name combos
 * that match a CRM pattern → manual review before commit.
 *
 * EU residency: Mistral Paris is the only LLM used here. No US egress.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createMistralEuLLMCaller } from '../src/integrations/inbox/classifier/llm-mistral.js';
import type { InboxBucket } from '../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, '..', 'tests', 'eval', 'inbox-classifier-fixtures.json');

interface Category {
  id: string;
  count: number;
  /** Hint at the bucket so Phase 1 stays balanced — Phase 2 re-labels independently. */
  hintBucket: InboxBucket;
  language: 'de' | 'en' | 'mixed';
  prompt: string;
}

const CATEGORIES: ReadonlyArray<Category> = [
  {
    id: 'newsletter',
    count: 20,
    hintBucket: 'auto_handled',
    language: 'mixed',
    prompt:
      'Newsletter / Marketing-Mail. Absender ist klar eine Marketing-Adresse (newsletter@, marketing@, promo@). Betreff mit Rabatt/Aktion/Saison-Thema. Body 60-200 Zeichen, mit Abmelde-Hinweis am Ende. Verwende fiktive Firmen-Namen (Acme, Beispiel AG, example-shop.example). KEINE realen Marken.',
  },
  {
    id: 'receipt',
    count: 15,
    hintBucket: 'auto_handled',
    language: 'mixed',
    prompt:
      'Zahlungsbestätigung / Receipt. Absender ist eine Billing-Adresse (receipts@, billing@). Body bestätigt eine erfolgreiche Zahlung mit Betrag, Karte (••••), Datum. KEINE Aktion erforderlich. Fiktive Anbieter (Acme Billing, example-pay.example).',
  },
  {
    id: 'shipping-confirmation',
    count: 10,
    hintBucket: 'auto_handled',
    language: 'mixed',
    prompt:
      'Versand-/Lieferbestätigung. Absender ist noreply@logistics-style. Tracking-Nummer + ETA. Keine Aktion nötig. Fiktive Anbieter.',
  },
  {
    id: 'invoice-due',
    count: 15,
    hintBucket: 'requires_user',
    language: 'mixed',
    prompt:
      'Rechnung mit Fälligkeitsdatum. Body nennt CHF/EUR-Betrag, Konto/IBAN-Hinweis, Frist (z. B. „Zahlung bis ..."). Absender Buchhaltung@. Fiktive Firmennamen (Acme Dienstleister, example-services).',
  },
  {
    id: 'customer-question',
    count: 15,
    hintBucket: 'requires_user',
    language: 'mixed',
    prompt:
      'Kundin/Kunde stellt eine Frage oder beschwert sich. Absender ist eine realistische Personen-Mail-Adresse (vorname.nachname@kundenfirma). Body braucht eine Antwort/Entscheidung. Fiktive Namen (Max Mustermann, Erika Mustermann, Alice Beispiel).',
  },
  {
    id: 'colleague-question',
    count: 10,
    hintBucket: 'requires_user',
    language: 'mixed',
    prompt:
      'Eine Kollegin/ein Kollege bittet um Input, Termine, Entscheidung. Body 60-220 Zeichen, locker formuliert. Absender ist eine Mitarbeiter-Mail. Fiktive Namen.',
  },
  {
    id: 'payment-failed',
    count: 5,
    hintBucket: 'requires_user',
    language: 'mixed',
    prompt:
      'Zahlung fehlgeschlagen / Card declined. Body fordert Update der Zahlungsdaten innerhalb einer Frist. Anbieter fiktiv.',
  },
  {
    id: 'meeting-request',
    count: 10,
    hintBucket: 'draft_ready',
    language: 'mixed',
    prompt:
      'Anfrage für einen Call/Termin. Body schlägt 1-2 Slots vor und braucht eine kurze Zusage. Eine kurze Antwort wäre sinnvoll (draft_ready). Fiktive Namen.',
  },
  {
    id: 'clarifying-question',
    count: 10,
    hintBucket: 'draft_ready',
    language: 'mixed',
    prompt:
      'Klärungsfrage von Support oder Kolleg:in zu einem bestimmten Detail (z. B. SDK-Version, Konto-ID). Antwort sollte direkt aus Kontext machbar sein (draft_ready).',
  },
  {
    id: 'info-share',
    count: 10,
    hintBucket: 'draft_ready',
    language: 'mixed',
    prompt:
      'Info-Mail mit Status-Update / Heads-up, die eine kurze Bestätigung erwartet („Danke, gemerkt"). Body 80-180 Zeichen. Fiktive Namen.',
  },
];

const TOTAL_DEFAULT = CATEGORIES.reduce((sum, c) => sum + c.count, 0);

function getApiKey(): string {
  if (process.env['MISTRAL_API_KEY']) return process.env['MISTRAL_API_KEY'];
  try {
    const raw = readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config['mistral_api_key'] === 'string' && config['mistral_api_key'].length > 0) {
      return config['mistral_api_key'];
    }
  } catch { /* fall through */ }
  throw new Error('No MISTRAL_API_KEY env var or ~/.lynox/config.json mistral_api_key field');
}

interface GenMail {
  subject: string;
  fromAddress: string;
  fromName: string;
  body: string;
  language: 'de' | 'en';
}

// ── Phase 1 ──────────────────────────────────────────────────────────────

const PHASE1_SYSTEM = `Du bist ein Generator für synthetische Mail-Daten. Du erzeugst realistische Mails für eine Klassifizierer-Eval — keine echten Personen, keine echten Firmen.

Erlaubte Platzhalter: Mustermann, Acme, Beispiel, example.* Domains.
Verboten: lynox.*, brandfusion.*, reale Vornamen-Nachnamen-Kombinationen (Roland Müller, Anna Schmidt, etc.), reale Firmennamen (Google, Stripe, Cloudflare).

Antworte ausschließlich mit gültigem JSON, ohne Markdown-Fences, ohne Erklärung.

Schema:
{ "mails": [ { "subject": "...", "fromAddress": "...@example.example", "fromName": "...", "body": "...", "language": "de" | "en" } ] }`;

async function generateBatch(
  llm: ReturnType<typeof createMistralEuLLMCaller>,
  category: Category,
  n: number,
): Promise<GenMail[]> {
  const user = `Generiere ${n} Mails dieser Kategorie:\n\n${category.prompt}\n\nSprache: ${category.language === 'mixed' ? 'mische DE und EN (~50/50)' : category.language}. Body 40-220 Zeichen. Jede Mail muss subject, fromAddress, fromName, body, language haben.`;
  const raw = await llm({ system: PHASE1_SYSTEM, user });
  try {
    const parsed = JSON.parse(raw) as { mails?: unknown };
    if (!Array.isArray(parsed.mails)) return [];
    const out: GenMail[] = [];
    for (const m of parsed.mails) {
      if (typeof m !== 'object' || m === null) continue;
      const r = m as Record<string, unknown>;
      if (typeof r['subject'] !== 'string') continue;
      if (typeof r['fromAddress'] !== 'string') continue;
      if (typeof r['fromName'] !== 'string') continue;
      if (typeof r['body'] !== 'string') continue;
      const lang = r['language'] === 'de' || r['language'] === 'en' ? r['language'] : 'en';
      out.push({
        subject: r['subject'].trim(),
        fromAddress: r['fromAddress'].trim(),
        fromName: r['fromName'].trim(),
        body: r['body'].trim(),
        language: lang,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Phase 2 ──────────────────────────────────────────────────────────────

const PHASE2_SYSTEM = `Du bist ein Reference-Labeler für eine Inbox-Klassifizierer-Eval. Bucket-Definition:

- requires_user: Empfängerin muss entscheiden, antworten, freigeben (Rechnungen, Kundenanfragen, Failed Payment).
- draft_ready:   Sinnvolle kurze Antwort ist möglich; Empfängerin muss editieren+senden (Terminanfragen, Info-Mails mit erwartetem "Danke").
- auto_handled:  Newsletter / Receipts / Shipping / FYI — nur archivieren.

Regel bei Unsicherheit: requires_user (asymmetrisches Risiko).

Antworte ausschließlich mit gültigem JSON:
{ "bucket": "requires_user" | "draft_ready" | "auto_handled", "category": "kurzer kategorie-string" }`;

interface Label {
  bucket: InboxBucket;
  category: string;
}

async function labelMail(
  llm: ReturnType<typeof createMistralEuLLMCaller>,
  mail: GenMail,
): Promise<Label | null> {
  const user = `Absender: ${mail.fromName} <${mail.fromAddress}>\nBetreff: ${mail.subject}\nBody:\n${mail.body}`;
  const raw = await llm({ system: PHASE2_SYSTEM, user });
  try {
    const parsed = JSON.parse(raw) as { bucket?: unknown; category?: unknown };
    if (parsed.bucket !== 'requires_user' && parsed.bucket !== 'draft_ready' && parsed.bucket !== 'auto_handled') {
      return null;
    }
    const category = typeof parsed.category === 'string' && parsed.category.length > 0
      ? parsed.category.trim()
      : 'unknown';
    return { bucket: parsed.bucket, category };
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryArg = process.argv.indexOf('--dry');
  const dryTotal = dryArg !== -1 ? Number.parseInt(process.argv[dryArg + 1] ?? '12', 10) : 0;
  const isDry = dryTotal > 0;

  // DEFAULT_MAX_TOKENS in llm-mistral.ts is 256 (sized for the
  // classifier's single-verdict JSON). Generation needs much more —
  // an 8-mail batch with realistic bodies runs ~600-1000 tokens; the
  // labeler is small (~30 tokens). 4096 is generous for either.
  const llm = createMistralEuLLMCaller({ apiKey: getApiKey(), maxTokens: 4096 });
  const allMails: Array<{ mail: GenMail; hintBucket: InboxBucket; categoryId: string }> = [];

  // Scale per-category count down proportionally for dry runs.
  for (const cat of CATEGORIES) {
    const target = isDry ? Math.max(1, Math.round((cat.count / TOTAL_DEFAULT) * dryTotal)) : cat.count;
    process.stdout.write(`[gen ${cat.id}] target ${target} mails…\n`);
    let collected: GenMail[] = [];
    let stalls = 0;
    while (collected.length < target && stalls < 3) {
      const remaining = target - collected.length;
      const batch = await generateBatch(llm, cat, Math.min(8, remaining));
      if (batch.length === 0) {
        stalls += 1;
        process.stdout.write(`  empty batch (stall ${stalls}/3)\n`);
        continue;
      }
      collected.push(...batch);
      process.stdout.write(`  ${collected.length}/${target}\n`);
    }
    collected = collected.slice(0, target);
    for (const mail of collected) {
      allMails.push({ mail, hintBucket: cat.hintBucket, categoryId: cat.id });
    }
  }

  process.stdout.write(`\n[label] phase 2: ${allMails.length} mails\n`);
  const fixtures: Array<Record<string, unknown>> = [];
  for (let i = 0; i < allMails.length; i += 1) {
    const { mail, categoryId } = allMails[i]!;
    const label = await labelMail(llm, mail);
    if (label === null) {
      process.stdout.write(`  [${i + 1}/${allMails.length}] label failed — skipping\n`);
      continue;
    }
    fixtures.push({
      id: `${categoryId}-${mail.language}-${String(i).padStart(3, '0')}`,
      category: label.category || categoryId,
      language: mail.language,
      expectedBucket: label.bucket,
      fromAddress: mail.fromAddress,
      fromName: mail.fromName,
      subject: mail.subject,
      body: mail.body,
    });
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${allMails.length}\n`);
  }

  const corpus = {
    version: 2,
    generatedAt: new Date().toISOString(),
    generator: `inbox-eval-gen v1 (Mistral EU, ${isDry ? 'dry' : 'full'}); operator-must-run inbox-eval-lint before merge`,
    note: 'PRD-INBOX-PHASE-3 §"Classification Tuning". Re-run only when prompt or model bumps invalidate the corpus.',
    fixtures,
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(corpus, null, 2) + '\n');
  process.stdout.write(`\nWrote ${fixtures.length} fixtures to ${FIXTURES_PATH}\n`);
  process.stdout.write(`Next: npx tsx scripts/inbox-eval-lint.ts (anti-PII check) before committing.\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`inbox-eval-gen failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
