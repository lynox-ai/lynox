// === Durable Knowledge Substrate — DK-OFF baseline replay ===
//
// The counterfactual half of the gate. `knowledge-substrate-replay.ts` measures
// what the substrate captures with `durable_memory_enabled` ON; this file
// measures what the SAME corpus produces with the flag OFF — the legacy
// pipeline that a tenant runs today.
//
// WHY this exists: the 0.90 tier-1 bar was set as an absolute ("if the agent
// can't reliably remember who a client is, the memory is useless"), never
// against a comparison. But a flip gate answers "is this better than what we
// run today?", and PRD §1 measured today as 450 subjects / 90% ghosts /
// 32-of-32 low-trust memories in one session. Without this number, 63.6% is
// unreadable: it could be a regression or a large improvement.
//
// Faithfulness — the flag is flipped exactly where production flips it:
//   - `durableMemoryEnabled: false` on the Agent, which is what gates the
//     auto-extraction path (`agent.ts:821-833`). The extraction is NOT rebuilt
//     here; it runs because the flag is off, same as on a real tenant.
//   - the six legacy `memory_*` tools instead of the six DK tools, per the
//     no-partial-swap rule at `engine.ts:1289-1305`.
//   - the system prompt WITHOUT `DURABLE_MEMORY_PROMPT_SUFFIX` — that suffix
//     only ships when the flag is on, so including it would measure a
//     configuration that cannot exist.
//
// Readback: the legacy store is flat per-namespace text, not rows. Each line is
// one captured entry; new lines after a turn are attributed to that turn, which
// mirrors how the DK path attributes new `knowledge_entries` rows.
//
// KNOWN ASYMMETRIES — both are real product differences, NOT harness bias, and
// the report must name them rather than silently score them:
//   · the legacy store has no subject link, so subject-attribution is 0 by
//     construction. It cannot answer "whose fact is this?" at all.
//   · the legacy store has no trust routing, so every entry reads as `active`.
//     There is no pending_review path to violate — routing scores vacuously.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/core/agent.js';
import { Memory } from '../../src/core/memory.js';
import { createToolContext } from '../../src/core/tool-context.js';
import {
  memoryStoreTool, memoryRecallTool, memoryListTool,
} from '../../src/tools/builtin/memory.js';
import { ALL_NAMESPACES } from '../../src/types/index.js';
import type { MemoryNamespace, ToolEntry } from '../../src/types/index.js';
import type { CapturedEntry, GoldThread } from './knowledge-substrate-runner.js';
import { makeMailReadStub, sendWithRetry, type RealReplayOpts, providerAgentFields } from './knowledge-substrate-replay.js';

/**
 * The DK-OFF system prompt: the same role preamble as the DK replay, with the
 * durable-memory suffix omitted. Nothing is substituted in its place — a
 * flag-off tenant genuinely gets no memory instruction beyond the tool
 * descriptions, and inventing one here would measure a product that does not
 * exist.
 */
export const BASELINE_SYSTEM_PROMPT = [
  'You are lynox, a business assistant working for an operator. Keep replies to one or two sentences.',
  'When a message says an email or document has arrived, call `mail_read` to read it BEFORE acting on it.',
].join('\n');

/** Split a namespace blob into entries. The legacy store is line-oriented; blank
 *  lines and markdown bullets are normalised so a bullet list does not read as
 *  one giant entry. */
function linesOf(blob: string | null): string[] {
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
  return async (thread: GoldThread): Promise<CapturedEntry[]> => {
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
      // `memory` rides the AgentConfig (`types/config.ts:23`), NOT the tool context —
      // the legacy tools read `agent.memory` (`tools/builtin/memory.ts:259`).
      const ctx = createToolContext({} as never);
      const mail = makeMailReadStub();

      const agent = new Agent({
        name: `baseline-${thread.id}`,
        model: opts.model,
        apiKey: opts.apiKey,
        maxIterations: opts.maxIterations ?? 6,
        durableMemoryEnabled: false, // ← the whole point
        memory,
        systemPrompt: BASELINE_SYSTEM_PROMPT,
        toolContext: ctx,
        tools: [memoryStoreTool, memoryRecallTool, memoryListTool, mail.tool] as ToolEntry[],
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
        try {
          // eslint-disable-next-line no-await-in-loop
          await sendWithRetry(agent, turn.text, `${thread.id} t${i}`);
        } catch (err) {
          process.stderr.write(`  [baseline] ${thread.id} t${i} send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}\n`);
          break; // same abandon-the-rest semantics as the DK replay
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
              sourceUntrusted: false,
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
