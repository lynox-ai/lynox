// === Durable Knowledge Substrate — DK-OFF baseline replay ===
//
// The counterfactual half of the gate. `knowledge-substrate-replay.ts` measures
// what the substrate captures with `durable_memory_enabled` ON; this file
// measures what the SAME corpus produces with the flag OFF — the legacy
// pipeline that a tenant runs today.
//
// WHY this exists: the tier-1 bar was set as an absolute ("if the agent can't
// reliably remember who a client is, the memory is useless"), never against a
// comparison. But a flip gate answers "is this better than what we run today?",
// and the legacy pipeline's own failure mode is measured (see the private PRD
// §1) but was never in the harness. Without a baseline the DK number is
// unreadable in either direction: it could be a regression or a large
// improvement, and nothing in the run tells you which.
//
// Faithfulness — the flag is flipped exactly where production flips it:
//   - `durableMemoryEnabled: false` on the Agent, which is what gates the
//     auto-extraction path (`agent.ts:821-833`). The extraction is NOT rebuilt
//     here; it runs because the flag is off, same as on a real tenant.
//   - the six legacy `memory_*` tools instead of the six DK tools, per the
//     no-partial-swap rule at `engine.ts:1289-1305`.
//   - the shared role preamble + the LEGACY memory doctrine verbatim from the
//     production `SYSTEM_PROMPT` (`prompts.ts:474,495`), and no
//     `DURABLE_MEMORY_PROMPT_SUFFIX` — that suffix only ships when the flag is
//     on. Giving the baseline NO memory instruction, as the first version did,
//     was the single largest bias in the withdrawn first run, and it ran in
//     DK's favour.
//   - `initLLMProvider` is called before the run: `Memory.maybeUpdate` resolves
//     its extractor model through the GLOBAL active provider
//     (`memory.ts:517-518`), which only `initLLMProvider` ever sets. Without it
//     an openai/proxy run posts an Anthropic model id to the wrong endpoint, 400s,
//     and `maybeUpdate`'s catch swallows it — the extraction half of the baseline
//     would silently never run while the numbers looked ordinary.
//
// Readback: the legacy store is flat per-namespace text, not rows. Each line is
// one captured entry; new lines after a turn are attributed to that turn, which
// mirrors how the DK path attributes new `knowledge_entries` rows.
//
// KNOWN ASYMMETRIES — real product differences, NOT harness bias, and the report
// must name them rather than silently score them:
//   · the legacy store has no subject link, so every entry carries `subject: null`.
//     Its subject-attribution number is therefore NOT a link-quality measurement:
//     `scoreCaptures` counts both-null as CORRECT, so the score is simply the share
//     of matched gold facts that were themselves unscoped — free credit for the side
//     that has no subjects at all, tilting toward the baseline. Read it as "how many
//     gold facts had no subject either", never as "how well it attributed".
//     (An earlier revision of this comment claimed the number is "0 by construction".
//     It is not: the 2026-07-28 full run scored 22.9%, and a 4-thread preflight 40%.
//     The wrong claim was the more dangerous half — it invited citing the number.)
//   · the legacy store has no trust routing, so every entry reads as `active`
//     while `sourceUntrusted` is derived from the turn. A legacy `memory_store`
//     after a `mail_read` genuinely does land external text active — that is a
//     real H4 exposure the routing metric should SEE, not a vacuous pass. It does:
//     the 2026-07-28 baseline run recorded 32 violations against DK's 0.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/core/agent.js';
import { Memory } from '../../src/core/memory.js';
import {
  memoryStoreTool, memoryRecallTool, memoryDeleteTool,
  memoryUpdateTool, memoryListTool, memoryPromoteTool,
} from '../../src/tools/builtin/memory.js';
import { initLLMProvider, getActiveProvider } from '../../src/core/llm-client.js';
import { ALL_NAMESPACES } from '../../src/types/index.js';
import type { MemoryNamespace, ToolEntry } from '../../src/types/index.js';
import type { CapturedEntry, GoldThread } from './knowledge-substrate-runner.js';
import { makeMailReadStub, sendWithRetry, WatchdogError, REPLAY_PREAMBLE, replayFailures, type RealReplayOpts, providerAgentFields } from './knowledge-substrate-replay.js';

/**
 * The DK-OFF system prompt: the same role preamble as the DK replay, with the
 * durable-memory suffix omitted. Nothing is substituted in its place — a
 * flag-off tenant genuinely gets no memory instruction beyond the tool
 * descriptions, and inventing one here would measure a product that does not
 * exist.
 */
export const BASELINE_SYSTEM_PROMPT = [
  REPLAY_PREAMBLE,
  // VERBATIM from the production SYSTEM_PROMPT (`src/core/prompts.ts:474,495`), which a
  // flag-off tenant genuinely receives. An earlier version gave the baseline NO memory
  // instruction at all while DK kept its production suffix — the single largest bias in
  // the first run, and it ran in DK's favour.
  '| Data type | Tool |',
  '|-----------|------|',
  '| Knowledge, preferences | `memory_store` (knowledge/methods/status/learnings) |',
  '',
  '**Knowledge**: `memory_store` (persist facts), `memory_recall` (search), `memory_update`/`memory_delete` (maintain accuracy), `memory_promote` (share across projects). Store insights, not raw data. Entity relationships are tracked automatically.',
].join('\n');

/** Split a namespace blob into entries. The legacy store is line-oriented —
 *  `Memory.appendScoped` writes exactly one line per entry (`memory.ts:395`) — so
 *  the newline split is faithful and a bundled multi-fact entry (joined with
 *  `'; '` by `coerceExtractionValue`) correctly stays ONE entry. Blank lines and
 *  markdown bullets/headings are normalised so a list does not read as one giant
 *  entry and a section header is not scored as a captured fact.
 *  Exported for the contract test: this is the baseline's entire readback, and a
 *  wrong split silently moves its junk-rate. */
export function linesOf(blob: string | null): string[] {
  if (!blob) return [];
  return blob
    .split('\n')
    .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(l => l.length > 0 && !/^#{1,6}\s/.test(l));
}

/** Read every namespace and flatten to one list of entry texts. */
async function readAll(memory: Memory): Promise<Map<MemoryNamespace, string[]>> {
  const out = new Map<MemoryNamespace, string[]>();
  for (const ns of ALL_NAMESPACES) {
    // eslint-disable-next-line no-await-in-loop
    out.set(ns, linesOf(await memory.load(ns)));
  }
  return out;
}

/**
 * Build the DK-OFF `replayThread` for the pure runner — same signature as
 * {@link makeRealReplayThread}, so `runReplayEval` and every metric downstream
 * are shared and the two numbers are comparable by construction.
 */
export function makeLegacyReplayThread(opts: RealReplayOpts): (thread: GoldThread) => Promise<CapturedEntry[]> {
  let providerReady: Promise<void> | null = null;
  /** Idempotent, once per harness: see the header note on `initLLMProvider`. */
  const ensureProvider = (): Promise<void> => (providerReady ??= initLLMProvider(opts.provider ?? 'anthropic'));

  return async (thread: GoldThread): Promise<CapturedEntry[]> => {
    await ensureProvider();
    if (getActiveProvider() !== (opts.provider ?? 'anthropic')) {
      // Fail LOUD. A mismatch here does not degrade the measurement, it deletes
      // half of it in silence — and a silent half-measurement is what this whole
      // harness exists to stop producing.
      throw new Error(`baseline: active LLM provider is "${getActiveProvider()}", expected "${opts.provider ?? 'anthropic'}" — the auto-extraction would post to the wrong endpoint and be swallowed`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'lynox-know-baseline-'));
    try {
      const memory = new Memory(
        dir,
        opts.apiKey,
        opts.apiBaseURL,
        undefined,
        undefined,
        true,
        opts.provider,
        opts.openaiModelId,
      );
      // `memory` rides the AgentConfig (`types/config.ts:23`) — the legacy tools read
      // `agent.memory` (`tools/builtin/memory.ts:259`), never the tool context.
      const mail = makeMailReadStub();

      const agent = new Agent({
        name: `baseline-${thread.id}`,
        model: opts.model,
        apiKey: opts.apiKey,
        maxIterations: opts.maxIterations ?? 6,
        durableMemoryEnabled: false, // ← the whole point
        memory,
        systemPrompt: BASELINE_SYSTEM_PROMPT,
        // ALL SIX, per the no-partial-swap rule this file cites (`engine.ts:1297-1305`).
        // An earlier version wired three and starved the baseline of update/delete/promote.
        tools: [
          memoryStoreTool, memoryRecallTool, memoryDeleteTool,
          memoryUpdateTool, memoryListTool, memoryPromoteTool, mail.tool,
        ] as ToolEntry[],
        ...providerAgentFields(opts),
      });

      // seen-per-namespace, so a line is attributed to the turn it first appeared in
      const seen = new Map<MemoryNamespace, Set<string>>();
      for (const ns of ALL_NAMESPACES) seen.set(ns, new Set());
      const captured: CapturedEntry[] = [];

      for (let i = 0; i < thread.turns.length; i += 1) {
        const turn = thread.turns[i]!;
        agent.currentThreadId = thread.id;
        agent.currentRunId = `${thread.id}-t${i}`;
        mail.stage(turn.untrusted === true ? (turn.externalPayload ?? '') : undefined);
        opts.onTurn?.(thread.id, i);
        replayFailures.turns += 1;
        let abandoned = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          await sendWithRetry(agent, turn.text, `${thread.id} t${i}`);
        } catch (err) {
          replayFailures.sends += 1;
          process.stderr.write(`  [baseline] ${thread.id} t${i} send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}\n`);
          // MIRROR the DK twin exactly (`knowledge-substrate-replay.ts:205-223`): only a
          // watchdog abandons the rest of the thread, and the readback below still runs
          // for this turn. Breaking on ANY error — as an earlier version did — let one
          // transient 500 zero a whole thread on the baseline side only.
          if (err instanceof WatchdogError) abandoned = true;
        }

        // The agent drains its own fire-and-forget extraction in send()'s finally
        // (agent.ts:1010-1015), but only what was already pending when that block
        // ran. Poll until the store stops growing so a late-settling extraction is
        // not scored as a miss — this is the ONE place where under-waiting would
        // silently flatter the DK side of the comparison.
        // eslint-disable-next-line no-await-in-loop
        let snapshot = await readAll(memory);
        for (let wait = 0; wait < 8; wait += 1) {
          const before = [...snapshot.values()].reduce((n, l) => n + l.length, 0);
          // eslint-disable-next-line no-await-in-loop
          await new Promise(r => setTimeout(r, 1500));
          // eslint-disable-next-line no-await-in-loop
          const next = await readAll(memory);
          const after = [...next.values()].reduce((n, l) => n + l.length, 0);
          snapshot = next;
          if (after === before) break;
        }

        for (const ns of ALL_NAMESPACES) {
          const set = seen.get(ns)!;
          for (const line of snapshot.get(ns) ?? []) {
            if (set.has(line)) continue;
            set.add(line);
            captured.push({
              threadId: thread.id,
              turnSeq: i,
              text: line,
              // No subject link exists in the legacy store — see the asymmetry
              // note at the top. Null is the honest value, not a gap to fill.
              subject: null,
              status: 'active',
              pinned: false,
              // Derived, NOT hardcoded false: legacy `memory_store` after a `mail_read`
              // really does land external text as active, and that is the H4 exposure the
              // routing metric exists to catch. Hardcoding false made the eval's only HARD
              // security assertion unfailable in baseline mode.
              sourceUntrusted: turn.untrusted === true,
            });
          }
        }
      }

      return captured;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
