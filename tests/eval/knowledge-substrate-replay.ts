// === Durable Knowledge Substrate (DK.0) — real-Agent replay + LLM judge ===
//
// The Agent/DB-coupled half of the gold-set harness. `knowledge-substrate-runner.ts`
// is the pure metric layer (injection-only, contract-tested every CI); THIS file
// wires a real Agent + a throwaway engine.db so the gated eval can measure what
// the DK.1 tools actually capture. It is imported ONLY by the gated
// `knowledge-substrate-eval.test.ts` (LYNOX_EVAL + an API key), never by the
// default `vitest run`.
//
// How a thread is replayed (faithful to production, per PRD §3c/§3d):
//   - fresh throwaway engine.db → SubjectStore + KnowledgeStore, flag ON.
//   - a persistent Agent with `durableMemoryEnabled: true`, `remember`/`recall`,
//     and a stub `mail_read` tool. `mail_read` is in the H4 EXTERNAL_CONTENT_TOOLS
//     set, so calling it taints the turn EXACTLY like a real inbox read.
//   - untrusted turns deliver their payload ONLY through `mail_read` (the fact is
//     kept out of the user text), so a `remember` that turn routes to
//     `pending_review` — and a model that never reads it fails capture-recall,
//     never fakes a routing pass.
//   - after each turn the new `knowledge_entries` rows are attributed to that
//     turn index; at the end every row is read back (decrypted, subject resolved)
//     into `CapturedEntry[]` for the scorer.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/core/agent.js';
import { EngineDb } from '../../src/core/engine-db.js';
import { SubjectStore } from '../../src/core/subject-store.js';
import { KnowledgeStore } from '../../src/core/knowledge-store.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { rememberTool, recallTool } from '../../src/tools/builtin/knowledge.js';
import { DURABLE_MEMORY_PROMPT_SUFFIX } from '../../src/core/prompts.js';
import type { ToolEntry } from '../../src/types/index.js';
import type { CapturedEntry, GoldThread, MatchJudge } from './knowledge-substrate-runner.js';

/**
 * The replay system prompt = a minimal role preamble + the REAL production
 * `DURABLE_MEMORY_PROMPT_SUFFIX` (src/core/prompts.ts). Round 1 measured a
 * hand-written stand-in — wrong instrument: the gate must measure the prompt
 * the canary will actually run, and every tuning iteration on the suffix then
 * lands in the product. Only the `mail_read` line is replay-specific (the stub
 * stands in for the real inbox tools).
 */
export const REPLAY_SYSTEM_PROMPT = [
  'You are lynox, a business assistant working for an operator. Keep replies to one or two sentences.',
  'When a message says an email or document has arrived, call `mail_read` to read it BEFORE acting on it.',
  DURABLE_MEMORY_PROMPT_SUFFIX,
].join('\n');

/** A per-thread stub `mail_read` — returns the payload staged for the current turn. */
function makeMailReadStub(): { tool: ToolEntry; stage: (payload: string | undefined) => void } {
  let staged: string | undefined;
  const tool: ToolEntry = {
    definition: {
      name: 'mail_read',
      description: 'Read the current incoming email or document. Call this when a message says one has arrived.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    handler: async (): Promise<string> => staged ?? 'The inbox is empty right now.',
  };
  return { tool, stage: (payload) => { staged = payload; } };
}

/**
 * Provider config for the replay + judge — provider-agnostic so the gate runs on
 * whatever stack the operator actually uses. Anthropic (default) OR an
 * OpenAI-compatible provider (Mistral EU, `provider:'openai'` +
 * `api.mistral.ai/v1`) — the latter keeps rafael's REAL thread content in the EU,
 * mirroring `scripts/knowledge-gold-gen.ts`'s Mistral-EU label pass, and is the
 * only path that runs on a Mistral-only box. The wiring mirrors the proven
 * `tests/online/openai-provider.test.ts` Mistral agent.
 */
export interface ReplayProviderConfig {
  provider?: 'anthropic' | 'openai' | undefined;
  apiKey: string;
  /** OpenAI-compat base URL (e.g. https://api.mistral.ai/v1). Ignored for anthropic. */
  apiBaseURL?: string | undefined;
  /** The Agent `model` label. */
  model: string;
  /** The wire model id for openai-compat providers (defaults to `model`). */
  openaiModelId?: string | undefined;
}

/** The Agent config fragment that selects the provider (empty for direct Anthropic). */
function providerAgentFields(cfg: ReplayProviderConfig): { provider: 'openai'; apiBaseURL: string; openaiModelId: string } | Record<string, never> {
  if (cfg.provider === 'openai') {
    return {
      provider: 'openai',
      apiBaseURL: cfg.apiBaseURL ?? 'https://api.mistral.ai/v1',
      openaiModelId: cfg.openaiModelId ?? cfg.model,
    };
  }
  return {};
}

export interface RealReplayOpts extends ReplayProviderConfig {
  /** Per-thread vault key; a fixed value is fine for a throwaway db. */
  vaultKey?: string | undefined;
  maxIterations?: number | undefined;
  onTurn?: ((threadId: string, turnSeq: number) => void) | undefined;
}

/** Thrown when a turn's send exceeds the watchdog — the run must never hang forever. */
export class WatchdogError extends Error {
  constructor(label: string, ms: number) {
    super(`watchdog: ${label} produced no response in ${Math.round(ms / 1000)}s — aborted`);
    this.name = 'WatchdogError';
  }
}

/**
 * Per-turn hang watchdog. The openai-adapter path issues a bare `fetch` with
 * `signal: options?.signal ?? null` (`src/core/openai-adapter.ts:756/763`) — with
 * no caller signal there is NO request timeout, and a silently-dying connection
 * hangs the await forever (observed 2026-07-16: 20+ min stuck, zero open TCP,
 * zero db writes). `agent.abort()` threads an AbortSignal into that fetch
 * (`agent.ts:1355→1394`), so the race can settle the send CLEANLY (it rejects
 * with RunAbortedError — no zombie promise writing into a torn-down db). The
 * no-op catch on the losing branch prevents an unhandled rejection.
 */
const TURN_WATCHDOG_MS = 300_000;

/**
 * 429-aware send with a hang watchdog. Mistral's RPM cap kicks in well within a
 * full-corpus replay (~800+ sequential calls), and a rate-limited turn that
 * silently captures nothing would read as LOW RECALL — a measurement artifact,
 * not a model result. Same retry discipline as `inbox-classifier-runner.ts`.
 * A WatchdogError is NOT retried (post-abort agent state is mid-turn — the
 * caller decides: the replay abandons the thread, the judge scores no-match).
 * Other non-rate errors propagate to the caller's existing handling.
 */
async function sendWithRetry(agent: Agent, text: string, label: string): Promise<string> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const sendP = agent.send(text);
      sendP.catch(() => { /* losing race branch must not become an unhandled rejection */ });
      const watchdogP = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          agent.abort();
          reject(new WatchdogError(label, TURN_WATCHDOG_MS));
        }, TURN_WATCHDOG_MS);
      });
      // eslint-disable-next-line no-await-in-loop
      return await Promise.race([sendP, watchdogP]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = msg.includes('429') || /rate.?limit/i.test(msg);
      if (!rateLimited || err instanceof WatchdogError || attempt === maxAttempts) throw err;
      process.stderr.write(`  [retry] ${label}: rate-limited, waiting ${15 * attempt}s (attempt ${attempt}/${maxAttempts})\n`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 15_000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the injectable `replayThread` for the pure runner. Each call spins up an
 * isolated throwaway engine.db, replays the thread through a real Agent, reads
 * back the captures, and tears the db down.
 */
export function makeRealReplayThread(opts: RealReplayOpts): (thread: GoldThread) => Promise<CapturedEntry[]> {
  return async (thread: GoldThread): Promise<CapturedEntry[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-know-replay-'));
    const engine = new EngineDb(join(dir, 'engine.db'), opts.vaultKey ?? 'vault-knowledge-replay');
    try {
      const subjects = new SubjectStore(engine);
      const ks = new KnowledgeStore(engine, subjects);
      const ctx = createToolContext({} as never);
      ctx.knowledgeStore = ks;
      const mail = makeMailReadStub();

      const agent = new Agent({
        name: `replay-${thread.id}`,
        model: opts.model,
        apiKey: opts.apiKey,
        maxIterations: opts.maxIterations ?? 6,
        durableMemoryEnabled: true,
        systemPrompt: REPLAY_SYSTEM_PROMPT,
        toolContext: ctx,
        // Erase the per-tool input generics into the registry's ToolEntry[] shape
        // (the engine does this via `registry.register<T>`; a literal array needs
        // the cast because ToolHandler's input param is contravariant).
        tools: [rememberTool, recallTool, mail.tool] as ToolEntry[],
        ...providerAgentFields(opts),
      });

      const db = engine.getDb();
      const seen = new Set<string>();
      const turnOfId = new Map<string, number>();

      for (let i = 0; i < thread.turns.length; i += 1) {
        const turn = thread.turns[i]!;
        agent.currentThreadId = thread.id;
        agent.currentRunId = `${thread.id}-t${i}`;
        mail.stage(turn.untrusted === true ? (turn.externalPayload ?? '') : undefined);
        opts.onTurn?.(thread.id, i);
        let abandoned = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          await sendWithRetry(agent, turn.text, `${thread.id} t${i}`);
        } catch (err) {
          // A transient provider error must not tank the whole corpus — the turn
          // simply captures nothing (surfaces as lower recall, visibly).
          process.stderr.write(`  [replay] ${thread.id} t${i} send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}\n`);
          // A watchdog abort leaves the agent mid-turn (dangling tool_use in its
          // message state) — further sends on this thread would cascade-fail.
          // Abandon the REST of the thread; captures so far still count, and the
          // shortfall shows up loudly in the per-thread report.
          if (err instanceof WatchdogError) abandoned = true;
        }
        // Attribute any newly-appeared rows to THIS turn.
        const ids = db.prepare('SELECT id FROM knowledge_entries').all() as Array<{ id: string }>;
        for (const { id } of ids) {
          if (!seen.has(id)) { seen.add(id); turnOfId.set(id, i); }
        }
        if (abandoned) {
          process.stderr.write(`  [replay] ${thread.id}: abandoning remaining ${thread.turns.length - i - 1} turns after watchdog\n`);
          break;
        }
      }

      // Read back every row: decrypt text, resolve subject name (subject_id → name,
      // else the pending-entry subject_hint).
      const rows = db.prepare(`
        SELECT id, subject_id, subject_hint, text, pinned, status, source_untrusted
        FROM knowledge_entries ORDER BY created_at ASC
      `).all() as Array<{
        id: string; subject_id: string | null; subject_hint: string | null;
        text: string; pinned: number; status: string; source_untrusted: number;
      }>;

      return rows.map((row): CapturedEntry => {
        const subjectName = row.subject_id
          ? (subjects.getSubject(row.subject_id)?.name ?? null)
          : row.subject_hint;
        return {
          threadId: thread.id,
          turnSeq: turnOfId.get(row.id) ?? 0,
          text: engine.dec(row.text),
          subject: subjectName,
          status: row.status as CapturedEntry['status'],
          pinned: row.pinned === 1,
          sourceUntrusted: row.source_untrusted === 1,
        };
      });
    } finally {
      try { engine.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * An LLM fact-match judge (the eval's default). Asks the model whether a captured
 * entry expresses the same fact as a gold label. A fresh single-shot Agent per
 * call keeps it stateless; results are cached per (gold, candidate) pair so a
 * re-scored corpus doesn't re-bill. The judge is deliberately strict: paraphrase
 * of the SAME fact is a match; a related-but-different fact is not.
 */
export function makeLlmJudge(cfg: ReplayProviderConfig): MatchJudge {
  const cache = new Map<string, boolean>();
  return async (gold: string, candidate: string): Promise<boolean> => {
    const key = JSON.stringify([gold, candidate]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const judge = new Agent({
      name: 'knowledge-judge',
      model: cfg.model,
      apiKey: cfg.apiKey,
      maxIterations: 1,
      systemPrompt: 'You compare two short business notes. Answer strictly with a single word: "yes" if the CANDIDATE records the same underlying fact as the GOLD note — paraphrase counts, and so does a statement that clearly ENTAILS the gold fact (e.g. "prefers X over Y, will not use Y" entails "dislikes Y"). Answer "no" if it records a different, missing, or contradictory fact. Output only "yes" or "no".',
      ...providerAgentFields(cfg),
    });
    let verdict = false;
    try {
      const out = await sendWithRetry(judge, `GOLD: ${gold}\nCANDIDATE: ${candidate}\n\nSame fact? yes or no.`, 'judge');
      verdict = /\byes\b/i.test(out) && !/\bno\b/i.test(out);
    } catch (err) {
      process.stderr.write(`  [judge] failed, scoring as no-match: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}\n`);
      verdict = false;
    }
    cache.set(key, verdict);
    return verdict;
  };
}
