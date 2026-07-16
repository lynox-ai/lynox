#!/usr/bin/env npx tsx
/**
 * Durable Knowledge Substrate (DK.0) — gold-set corpus extractor + label proposer.
 *
 * Pulls + stratifies real threads from a `history.db`, extracts them turn-by-turn
 * into the `GoldThread` shape the replay harness consumes, and (optionally) runs an
 * offline Mistral-EU pass proposing per-thread candidate labels
 * `{fact, subject, turnSeq, untrusted}`. The output is a DRAFT for rafael to
 * confirm/edit → frozen `gold.jsonl` (PRD `knowledge-substrate.md` §5, D-9).
 *
 * ⚠️  The DRAFT contains REAL thread content. It is written OUTSIDE every git repo
 *     and MUST stay local — never commit it to the public core repo. Only the
 *     synthetic `tests/eval/knowledge-substrate-fixtures.json` is committed. The
 *     frozen gold.jsonl is pointed at via `LYNOX_KNOWLEDGE_GOLD` for the gated eval.
 *
 * EU residency: the label-proposal pass uses Mistral Paris only (no US egress for
 * real-customer-shaped content) — the same pin as `scripts/inbox-eval-gen.ts`.
 *
 * Usage:
 *   MISTRAL_API_KEY=$(jq -r .mistral_api_key ~/.lynox/config.json) \
 *     npx tsx scripts/knowledge-gold-gen.ts [history.db] [--out PATH] [--max 40] [--no-llm]
 *
 *   Defaults: history.db = $LYNOX_HISTORY_DB or ~/.lynox/history.db
 *             --out       = ~/.lynox/knowledge-gold/gold.draft.jsonl   (outside repos)
 *             --max       = 40 threads (PRD target: 30-50)
 *             --no-llm    = emit threads with EMPTY gold[] for fully-manual labeling
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RunHistory } from '../src/core/run-history.js';
import { ThreadStore, type ThreadMessageRecord, type ThreadRecord } from '../src/core/thread-store.js';
import { createMistralEuLLMCaller } from '../src/integrations/inbox/classifier/llm-mistral.js';

type ThreadStratum = 'work' | 'email-triage' | 'junk-control';

interface GoldTurn { text: string; untrusted?: boolean; externalPayload?: string }
interface GoldFact { id: string; fact: string; subject: string | null; kind?: string; turnSeq: number; untrusted: boolean }
interface GoldThread { id: string; stratum: ThreadStratum; turns: GoldTurn[]; gold: GoldFact[] }

// Tool names that ingest external, attacker-controllable content — a thread that
// used one is an email-triage / external-read candidate (mirror of the DK.1 H4
// EXTERNAL_CONTENT_TOOLS set; kept loose here since this is a proposal, not a gate).
const EXTERNAL_TOOLS = new Set([
  'mail_read', 'mail_search', 'mail_triage', 'http_request', 'web_research', 'read_file',
  'google_docs', 'google_drive', 'google_sheets',
]);

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { historyDb: string; out: string; max: number; useLlm: boolean } {
  const positional: string[] = [];
  let out = join(homedir(), '.lynox', 'knowledge-gold', 'gold.draft.jsonl');
  let max = 40;
  let useLlm = true;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--out') { out = argv[++i] ?? out; }
    else if (a === '--max') { max = Number(argv[++i] ?? max); }
    else if (a === '--no-llm') { useLlm = false; }
    else if (!a.startsWith('--')) { positional.push(a); }
  }
  const historyDb = positional[0] ?? process.env['LYNOX_HISTORY_DB'] ?? join(homedir(), '.lynox', 'history.db');
  return { historyDb, out: resolve(out), max, useLlm };
}

/** Refuse to write anywhere inside a git repo — the DRAFT holds real thread content. */
function assertOutsideGitRepo(path: string): void {
  let dir = dirname(path);
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      throw new Error(
        `refusing to write the gold DRAFT inside a git repo (${join(dir, '.git')}). ` +
        `It contains real thread content and must stay local. Pass --out to a path outside every repo, e.g. ~/.lynox/knowledge-gold/.`,
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
}

// ── thread → turns ───────────────────────────────────────────────────────────

/** Tolerant text extraction from a stored message's content_json (string | blocks). */
function extractText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      return parsed
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
            return (b as { text: string }).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
  } catch { /* fall through */ }
  return '';
}

/** Names of tool_use blocks in an assistant message (for external-read detection). */
function toolUseNames(contentJson: string): string[] {
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b): b is { type: string; name: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use' && typeof (b as { name?: unknown }).name === 'string')
      .map((b) => b.name);
  } catch { return []; }
}

/** The tool_result text carried in a user-role message (the external payload). */
function toolResultText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    if (!Array.isArray(parsed)) return '';
    const out: string[] = [];
    for (const b of parsed) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result') {
        const c = (b as { content?: unknown }).content;
        if (typeof c === 'string') out.push(c);
        else if (Array.isArray(c)) out.push(extractText(JSON.stringify(c)));
      }
    }
    return out.join('\n').trim();
  } catch { return ''; }
}

/**
 * Build a GoldThread skeleton from a stored thread. A "turn" = a genuine user
 * message (not a tool_result carrier). An external read by the following assistant
 * marks the turn untrusted and lifts the tool_result as the externalPayload.
 */
function toGoldThread(id: string, messages: ThreadMessageRecord[]): GoldThread {
  const turns: GoldTurn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = extractText(m.content_json);
    // Skip pure tool_result carriers (no genuine user text).
    if (!text) continue;
    // Skip the engine's INTERNAL compaction-summary prompt ("Summarize this
    // conversation concisely…") — it is a mechanical system task, not user
    // speech; in production it runs extraction-free, so replaying it as a
    // fact-bearing user turn only manufactures unfixable recall misses
    // (caught in the first real-gold round: one such thread = 3 dead gold facts).
    if (/^\s*(\[Now:[^\]]*\]\s*)?Summarize this conversation concisely/i.test(text)) continue;
    // Did the assistant reply to THIS turn read external content? Scan forward to
    // the next user message; collect tool names + any tool_result payload.
    let untrusted = false;
    let payload = '';
    for (let j = i + 1; j < messages.length && messages[j]!.role !== 'user'; j += 1) {
      const names = toolUseNames(messages[j]!.content_json);
      if (names.some((n) => EXTERNAL_TOOLS.has(n))) untrusted = true;
    }
    // The external payload is the tool_result in the NEXT user-role carrier(s).
    for (let j = i + 1; j < messages.length; j += 1) {
      if (messages[j]!.role !== 'user') continue;
      const tr = toolResultText(messages[j]!.content_json);
      if (tr) { payload = tr; break; }
      if (extractText(messages[j]!.content_json)) break; // reached the next real user turn
    }
    turns.push(untrusted ? { text, untrusted: true, externalPayload: payload || '[REVIEW: paste the external content the agent read this turn]' } : { text });
  }
  return { id, stratum: classify(turns), turns, gold: [] };
}

function classify(turns: GoldTurn[]): ThreadStratum {
  if (turns.some((t) => t.untrusted)) return 'email-triage';
  const totalChars = turns.reduce((n, t) => n + t.text.length, 0);
  if (turns.length <= 2 && totalChars < 400) return 'junk-control';
  return 'work';
}

// ── LLM label proposal (Mistral EU) ──────────────────────────────────────────

const PROPOSE_SYSTEM = [
  'You label a chat thread for a durable-memory gold-set. Given the thread turns, list the DURABLE business facts a competent assistant SHOULD have recorded to remember across sessions.',
  'A durable fact: a client/company/project attribute, a signed decision, a standing preference, a key contact. NOT: one-off arithmetic, small talk, transient status, anything trivial. If nothing durable, return an empty list.',
  'For each fact give: the canonical fact text; the subject (the company/client/person NAME it concerns, or null); the 0-based turnSeq of the turn by which it is knowable; and untrusted=true if that turn read external content (an email/web/file the sender controlled).',
  'Output STRICT JSON: {"gold":[{"fact":"...","subject":"..."|null,"turnSeq":0,"untrusted":false}]}. No prose.',
].join('\n');

async function proposeGold(
  llm: ReturnType<typeof createMistralEuLLMCaller>,
  thread: GoldThread,
): Promise<GoldFact[]> {
  const turnsBlock = thread.turns
    .map((t, i) => `[turn ${i}${t.untrusted ? ' · untrusted' : ''}] ${t.text}${t.externalPayload ? `\n  <external>${t.externalPayload.slice(0, 800)}</external>` : ''}`)
    .join('\n');
  try {
    const raw = await llm({ system: PROPOSE_SYSTEM, user: turnsBlock });
    const parsed = JSON.parse(raw) as { gold?: Array<{ fact?: unknown; subject?: unknown; turnSeq?: unknown; untrusted?: unknown }> };
    const facts = Array.isArray(parsed.gold) ? parsed.gold : [];
    return facts
      .filter((f) => typeof f.fact === 'string' && (f.fact as string).trim().length > 0)
      .map((f, i): GoldFact => {
        const turnSeq = Number.isInteger(f.turnSeq) ? Math.max(0, Math.min(thread.turns.length - 1, f.turnSeq as number)) : 0;
        return {
          id: `${thread.id}-f${i}`,
          fact: (f.fact as string).trim(),
          subject: typeof f.subject === 'string' && f.subject.trim() ? f.subject.trim() : null,
          // untrusted is AUTHORITATIVE from the thread structure, not the model's guess.
          turnSeq,
          untrusted: thread.turns[turnSeq]?.untrusted === true,
        };
      });
  } catch (err) {
    process.stderr.write(`  [propose] ${thread.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)} — leaving gold empty for manual labeling\n`);
    return [];
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { historyDb, out, max, useLlm } = parseArgs(process.argv.slice(2));

  assertOutsideGitRepo(out);
  if (!existsSync(historyDb)) throw new Error(`history.db not found: ${historyDb} (pass a path, set LYNOX_HISTORY_DB, or place it at ~/.lynox/history.db)`);
  if (!statSync(historyDb).isFile()) throw new Error(`not a file: ${historyDb}`);

  const runHistory = new RunHistory(historyDb);
  const threadStore = new ThreadStore(runHistory.getDb());

  const all: ThreadRecord[] = threadStore.listThreads({ limit: 200, includeArchived: true });
  process.stdout.write(`[gold-gen] ${all.length} candidate threads in ${historyDb}\n`);

  const built: GoldThread[] = [];
  for (const rec of all) {
    const messages = threadStore.getMessages(rec.id, { apiOnly: false });
    const gt = toGoldThread(rec.id, messages);
    if (gt.turns.length === 0) continue;
    built.push(gt);
  }

  // Stratify + sample toward a balanced --max (PRD: work chats · email-triage · short junk-control).
  const byStratum: Record<ThreadStratum, GoldThread[]> = { work: [], 'email-triage': [], 'junk-control': [] };
  for (const gt of built) byStratum[gt.stratum].push(gt);
  const perStratum = Math.max(1, Math.ceil(max / 3));
  const selected: GoldThread[] = [
    ...byStratum['work'].slice(0, perStratum),
    ...byStratum['email-triage'].slice(0, perStratum),
    ...byStratum['junk-control'].slice(0, perStratum),
  ].slice(0, max);
  process.stdout.write(
    `[gold-gen] selected ${selected.length}: ${byStratum['work'].slice(0, perStratum).length} work · ` +
    `${byStratum['email-triage'].slice(0, perStratum).length} email-triage · ${byStratum['junk-control'].slice(0, perStratum).length} junk-control\n`,
  );

  if (useLlm) {
    const key = process.env['MISTRAL_API_KEY'];
    if (!key) {
      process.stderr.write('[gold-gen] no MISTRAL_API_KEY — skipping label proposal (threads get empty gold[] for manual labeling). Use --no-llm to silence.\n');
    } else {
      const llm = createMistralEuLLMCaller({ apiKey: key, maxTokens: 2048 });
      for (let i = 0; i < selected.length; i += 1) {
        const gt = selected[i]!;
        // eslint-disable-next-line no-await-in-loop
        gt.gold = await proposeGold(llm, gt);
        process.stdout.write(`  [propose ${i + 1}/${selected.length}] ${gt.id} (${gt.stratum}): ${gt.gold.length} candidate facts\n`);
      }
    }
  }

  runHistory.close();

  mkdirSync(dirname(out), { recursive: true });
  const jsonl = selected.map((gt) => JSON.stringify(gt)).join('\n') + '\n';
  writeFileSync(out, jsonl, 'utf8');
  const readme = out.replace(/\.jsonl$/, '') + '.README.txt';
  writeFileSync(readme, [
    'DK.0 gold-set DRAFT — REAL thread content, keep LOCAL.',
    '',
    'This file is a machine-proposed DRAFT. Before it becomes the gate:',
    '  1. Review EVERY thread: fix stratum, prune non-durable "facts", correct subjects.',
    '  2. For every untrusted turn, paste the real external content into `externalPayload`',
    '     (drafts mark missing ones with a [REVIEW: ...] placeholder).',
    '  3. Scrub anything you would not want in a test artifact.',
    '  4. Freeze it, then point the gated eval at it:',
    `        LYNOX_EVAL=1 LYNOX_KNOWLEDGE_GOLD=${out.replace(/\.draft\.jsonl$/, '.jsonl')} \\`,
    '          ANTHROPIC_API_KEY=… npx vitest run tests/eval/knowledge-substrate-eval.test.ts',
    '',
    '⚠️  NEVER commit this to the public core repo. Only the synthetic',
    '    tests/eval/knowledge-substrate-fixtures.json is committed.',
    '',
    `Flip gate (PRD §5/§10): recall ≥ 0.7 AND junk ≤ 0.2, worst of 2-3 replay runs.`,
  ].join('\n'), 'utf8');

  process.stdout.write(`\n[gold-gen] wrote ${selected.length} threads → ${out}\n[gold-gen] review guide → ${readme}\n`);
  process.stdout.write('[gold-gen] ⚠️  DRAFT holds real content — review, freeze, keep local, never commit to the public repo.\n');
}

main().catch((err) => {
  process.stderr.write(`[gold-gen] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
