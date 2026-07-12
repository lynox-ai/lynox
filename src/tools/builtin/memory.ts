import type { ToolEntry, MemoryNamespace, IAgent, MemoryScopeRef } from '../../types/index.js';
import { ALL_NAMESPACES } from '../../types/index.js';
import { channels } from '../../core/observability.js';
import { parseScopeString, formatScopeRef, isMoreSpecific, SCOPE_PARAM_DESCRIPTION } from '../../core/scope-resolver.js';
import { estimateTokens } from '../../core/llm-helper.js';

// KnowledgeLayer accessed via agent.toolContext.knowledgeLayer

/**
 * Token budget for memory_recall responses (applied to BOTH paths).
 *
 * A full namespace dump (~15-20K tokens) thrashes the agent context window
 * and re-caches on every subsequent turn — pure cost + bloat. Cap both
 * paths at ~20K tokens (well below model output limits):
 *  - No-query path: recency/importance-ranked subset of the namespace.
 *  - Query path: substring-filtered subset over the namespace.
 *
 * Pre-#529 the no-query path was capped at 5K and the query path was
 * unbounded. This revert raises the no-query cap to 20K (matching the
 * query path) so the agent gets a more useful chunk of memory by default
 * while still keeping the contract bounded.
 */
const RECALL_NO_QUERY_TOKEN_BUDGET = 20_000;
const RECALL_QUERY_TOKEN_BUDGET = 20_000;

interface MemoryStoreInput {
  namespace: MemoryNamespace;
  content: string;
  scope?: string | undefined;
}

interface MemoryRecallInput {
  namespace: MemoryNamespace;
  query?: string | undefined;
  scope?: string | undefined;
}

/** A single memory line paired with the score used to rank it. */
interface RankedEntry {
  line: string;
  score: number;
}

/**
 * Rank the lines of a namespace file for a no-query recall and return the
 * highest-scoring subset that fits within tokenBudget.
 *
 * Ranking signal (no query available, so no relevance signal):
 *  - Recency: a [YYYY-MM-DD] date prefix (present on status entries and on
 *    any dated line) contributes a score proportional to how recent it is;
 *    undated lines get a neutral baseline. File order is the tiebreaker --
 *    append writes newest lines last, so later lines rank above earlier ones.
 *  - Importance: longer, substantive lines (a real fact vs. a stray fragment)
 *    get a small boost, capped so verbosity cannot dominate recency.
 *
 * Entries are emitted in their original file order (not score order) so the
 * returned subset still reads as a coherent, chronological slice of memory.
 */
function rankNoQueryEntries(content: string, tokenBudget: number): {
  text: string;
  shown: number;
  total: number;
} {
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const total = lines.length;
  if (total === 0) {
    return { text: '', shown: 0, total: 0 };
  }

  const dateRe = /^\[(\d{4}-\d{2}-\d{2})\]/;
  const now = Date.now();
  const RECENCY_WINDOW_MS = 90 * 86_400_000; // dates older than 90d score ~0 for recency

  const ranked: RankedEntry[] = lines.map((line, index) => {
    // File-order signal: newest lines are appended last -> later index ranks higher.
    const orderScore = (index + 1) / total;

    // Recency signal from an explicit date prefix, if present.
    let recencyScore = 0.5; // neutral baseline for undated lines
    const match = dateRe.exec(line);
    if (match) {
      const entryTime = new Date(match[1]!).getTime();
      if (!Number.isNaN(entryTime)) {
        const ageMs = Math.max(0, now - entryTime);
        recencyScore = Math.max(0, 1 - ageMs / RECENCY_WINDOW_MS);
      }
    }

    // Importance signal: substantive lines beat fragments, but capped at 0.3
    // so a long line can never outrank a recent one on length alone.
    const importanceScore = Math.min(line.trim().length / 200, 1) * 0.3;

    const score = recencyScore + orderScore * 0.5 + importanceScore;
    return { line, score };
  });

  // Pick the top entries by score until the token budget is exhausted.
  const selected = new Set<number>();
  let usedTokens = 0;
  const byScore = ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score);

  for (const { entry, index } of byScore) {
    const cost = estimateTokens(entry.line) + 1; // +1 for the joining newline
    if (usedTokens + cost > tokenBudget && selected.size > 0) {
      continue; // skip -- would overflow; keep scanning for smaller entries
    }
    selected.add(index);
    usedTokens += cost;
    if (usedTokens >= tokenBudget) break;
  }

  // Emit in original file order so the slice reads chronologically.
  const text = lines.filter((_, index) => selected.has(index)).join('\n');
  return { text, shown: selected.size, total };
}

/**
 * Cap a substring-filtered query result at `tokenBudget` tokens. Returns the
 * most-recent matches (file order — appends are newest-last) that fit, plus
 * the count of total matches for the tail-note.
 *
 * Pre-#529 the query path returned the WHOLE namespace dump unbounded once
 * any match was found, which defeats the no-query cap (a 20K-line namespace
 * with one match still flooded the context). Now both paths are bounded.
 */
function boundQueryMatches(matches: string[], tokenBudget: number): {
  text: string;
  shown: number;
  total: number;
} {
  const total = matches.length;
  if (total === 0) return { text: '', shown: 0, total: 0 };

  // Walk newest-first (last line in the file is the most recent append)
  // and accumulate until the budget is hit.
  let usedTokens = 0;
  const selected: string[] = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const line = matches[i]!;
    const cost = estimateTokens(line) + 1;
    if (usedTokens + cost > tokenBudget && selected.length > 0) {
      break;
    }
    selected.push(line);
    usedTokens += cost;
    if (usedTokens >= tokenBudget) break;
  }
  // Re-reverse to chronological order (oldest -> newest) so the agent reads
  // the slice as a timeline.
  selected.reverse();
  return { text: selected.join('\n'), shown: selected.length, total };
}

/**
 * Stop-word list for the fuzzy supersession heuristic in memory_update.
 * Kept tiny and English-only — the heuristic is intentionally simple and
 * the fallback is "append the new line", not "drop on the floor".
 */
const SUPERSEDE_STOP_WORDS = new Set([
  'the', 'a', 'is', 'are', 'of', 'in', 'and', 'or', 'to', 'for',
]);

/** Token a line for the supersession heuristic: lowercase, alphanumeric, no stop-words. */
function tokeniseForSupersede(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 0 && !SUPERSEDE_STOP_WORDS.has(t)),
  );
}

/**
 * Find lines in a namespace file that share at least 40% of `oldText`'s
 * significant tokens. Used as the FALLBACK heuristic when an exact-substring
 * match fails — the agent passed a non-exact substring (most common: a full
 * sentence). Returns up to 3 candidates; 0 candidates means "no signal at
 * all, just append".
 *
 * NOT embedding-based: real-world ONNX cosines for distinct-but-related
 * sentences are unreliable below ~0.95 (we learned this the hard way on
 * the B1 sprint). Token-overlap is dumb but deterministic.
 */
function findFuzzySupersedeCandidates(lines: string[], oldText: string): number[] {
  const oldTokens = tokeniseForSupersede(oldText);
  if (oldTokens.size === 0) return [];

  const scored: Array<{ index: number; ratio: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const lineTokens = tokeniseForSupersede(line);
    if (lineTokens.size === 0) continue;
    let overlap = 0;
    for (const t of oldTokens) {
      if (lineTokens.has(t)) overlap++;
    }
    const ratio = overlap / oldTokens.size;
    if (ratio >= 0.4) scored.push({ index: i, ratio });
  }

  // Highest overlap wins; cap at 3 so we don't mass-supersede.
  scored.sort((a, b) => b.ratio - a.ratio);
  return scored.slice(0, 3).map(s => s.index);
}

interface MemoryDeleteInput {
  namespace: MemoryNamespace;
  pattern: string;
  scope?: string | undefined;
}

interface MemoryUpdateInput {
  namespace: MemoryNamespace;
  old_content: string;
  new_content: string;
  scope?: string | undefined;
}

function resolveScope(scopeStr: string | undefined, agent: IAgent): MemoryScopeRef | undefined {
  if (!scopeStr) return undefined;
  const parsed = parseScopeString(scopeStr);
  if (!parsed) return undefined;
  // Validate: scope must be in agent.activeScopes if available
  if (agent.activeScopes) {
    const valid = agent.activeScopes.some(s => s.type === parsed.type && s.id === parsed.id);
    if (!valid) return undefined;
  }
  return parsed;
}

export const memoryStoreTool: ToolEntry<MemoryStoreInput> = {
  definition: {
    name: 'memory_store',
    description: 'Save qualitative knowledge for future sessions — business context, preferences, techniques, or lessons learned. NOT for structured/quantitative data (use data_store_insert) or deliverables with deadlines (use task_create).',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category: knowledge (business facts), methods (techniques), status (current status), learnings (lessons learned)',
        },
        content: { type: 'string', description: 'Content to store' },
        scope: {
          type: 'string',
          description: SCOPE_PARAM_DESCRIPTION,
        },
      },
      required: ['namespace', 'content'],
    },
  },
  handler: async (input: MemoryStoreInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }
    if (agent.secretStore?.containsSecret(input.content)) {
      return 'Cannot store content containing secret values in memory. Remove secrets and try again.';
    }

    const scopeRef = resolveScope(input.scope, agent);
    if (input.scope && !scopeRef) {
      return `Invalid or unauthorized scope: "${input.scope}". Active scopes: ${(agent.activeScopes ?? []).map(s => s.type === 'global' ? 'global' : `${s.type}:${s.id}`).join(', ') || 'none'}.`;
    }

    // Memory Foundation Wave 0.6: the tier is FORCE-FLOORED to agent_inferred. The
    // agent can no longer self-declare provenance (the removed `sourceType` param
    // was a live privilege escalation — injected content could instruct the agent
    // to store its own text as `user_asserted`, the tier the system prompt trusts
    // most; PRD §2.8). A genuine user fact still lands, honestly as agent_inferred;
    // Wave 1.3 re-derives the tier from the write-boundary channel, not the agent.
    if (scopeRef) {
      await agent.memory.appendScoped(input.namespace, input.content, scopeRef);
      channels.memoryStore.publish({ namespace: input.namespace, content: input.content, scopeType: scopeRef.type, scopeId: scopeRef.id, sourceThreadId: agent.currentThreadId, sourceChannel: 'agent', sourceRunId: agent.currentRunId, sourceUntrusted: agent.sawUntrustedData });
      return `Stored in ${input.namespace} (scope: ${input.scope}). Entities and relationships are extracted automatically for future cross-referencing.`;
    }

    await agent.memory.append(input.namespace, input.content);
    channels.memoryStore.publish({ namespace: input.namespace, content: input.content, sourceThreadId: agent.currentThreadId, sourceChannel: 'agent', sourceRunId: agent.currentRunId, sourceUntrusted: agent.sawUntrustedData });
    return `Stored in ${input.namespace}. Entities and relationships are extracted automatically for future cross-referencing.`;
  },
};

export const memoryRecallTool: ToolEntry<MemoryRecallInput> = {
  definition: {
    name: 'memory_recall',
    description: 'Look up previously saved knowledge by searching for relevant content. Pass a `query` describing what you need — this returns the matching memory lines (bounded by a token budget so the most recent matches are preferred when there are many). Omitting `query` returns only a bounded, recency-ranked sample of the namespace (not everything), so always prefer passing a query when you know what you are after. Only call this when the CURRENT user message clearly needs prior context to answer — do NOT call it on short follow-ups ("ok", "ja", one-word replies), topic continuations, or when the visible conversation already contains what you need. Recalled entries can be from arbitrary past sessions and may be stale; do not treat them as "what to do next" unless the user has just said so this turn.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category to recall from. knowledge = durable business facts about the user/company. methods = reusable techniques or playbooks. status = the user\'s explicitly stated focus; treat returned status entries as historical notes, never as the current session\'s goals unless the user has restated them this turn. learnings = lessons from past outcomes.',
        },
        query: {
          type: 'string',
          description: 'What you are looking for. With a query, the matching memory lines are returned, capped at the response token budget (newest matches preferred). Omit only when you genuinely want a broad sample — then a bounded recency-ranked subset is returned instead of the whole namespace.',
        },
        scope: {
          type: 'string',
          description: `Scope to recall from. ${SCOPE_PARAM_DESCRIPTION}`,
        },
      },
      required: ['namespace'],
    },
  },
  handler: async (input: MemoryRecallInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }

    const scopeRef = resolveScope(input.scope, agent);
    if (input.scope && !scopeRef) {
      return `Invalid or unauthorized scope: "${input.scope}".`;
    }

    const content = scopeRef
      ? await agent.memory.loadScoped(input.namespace, scopeRef)
      : await agent.memory.load(input.namespace);

    if (content === null) {
      return scopeRef
        ? `No content found in ${input.namespace} namespace (scope: ${input.scope}).`
        : `No content found in ${input.namespace} namespace.`;
    }

    // With a query: substring-filter, then cap at the response token budget
    // so a 20K-line namespace with a thousand matches doesn't flood context.
    // Newest matches are preferred (file order = append order = chronology).
    if (input.query !== undefined && input.query.trim().length > 0) {
      const queryLower = input.query.toLowerCase();
      const matches = content
        .split('\n')
        .filter(l => l.trim().length > 0)
        .filter(l => l.toLowerCase().includes(queryLower));
      if (matches.length === 0) {
        return content; // no matches — return the whole namespace as before
      }
      const { text, shown, total } = boundQueryMatches(matches, RECALL_QUERY_TOKEN_BUDGET);
      if (shown >= total) {
        return text;
      }
      return `${text}\n\n[Showing ${shown} of ${total} matching ${input.namespace} entries — most recent first, capped to keep context lean.]`;
    }

    // No-query (namespace-only): a full dump is 15-20K tokens of context bloat.
    // Return a recency/importance-ranked subset capped at the token budget.
    const { text, shown, total } = rankNoQueryEntries(content, RECALL_NO_QUERY_TOKEN_BUDGET);
    if (shown === 0) {
      return content; // nothing to rank (single empty line etc.) — return as-is
    }
    if (shown >= total) {
      return text; // whole namespace fit within the budget — no truncation note
    }
    return `${text}\n\n[Showing ${shown} of ${total} ${input.namespace} entries — most recent first, capped to keep context lean. Pass a \`query\` to memory_recall to retrieve the full matching set.]`;
  },
};

export const memoryDeleteTool: ToolEntry<MemoryDeleteInput> = {
  destructive: { mode: 'data' },
  definition: {
    name: 'memory_delete',
    description: 'Remove outdated information from your knowledge base.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category to delete from',
        },
        pattern: { type: 'string', description: 'Text pattern — lines containing this will be removed' },
        scope: {
          type: 'string',
          description: SCOPE_PARAM_DESCRIPTION,
        },
      },
      required: ['namespace', 'pattern'],
    },
  },
  handler: async (input: MemoryDeleteInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }

    // An empty/whitespace pattern would substring-match (and thus remove) EVERYTHING —
    // never the intent, and a prompt-injected empty pattern must not wipe the notebook.
    if (!input.pattern.trim()) {
      return 'A non-empty pattern is required to delete.';
    }

    const scopeRef = resolveScope(input.scope, agent);
    if (input.scope && !scopeRef) {
      return `Invalid or unauthorized scope: "${input.scope}".`;
    }

    const scopeSuffix = input.scope ? ` (scope: ${input.scope})` : '';
    const flatCount = scopeRef
      ? await agent.memory.deleteScoped(input.namespace, input.pattern, scopeRef)
      : await agent.memory.delete(input.namespace, input.pattern);

    // This is the agent's CURATION path ("remove outdated information"), so it SOFT-
    // deactivates the knowledge-graph twins (is_active = 0, recoverable) — deliberately
    // NOT the hard erase. Hard, physical erasure (GDPR Art. 17, irreversible) is a
    // human-gated action behind the UI confirm dialog (MemoryFacade.delete); routing an
    // agent-callable tool there would make one prompt-injected call an irreversible
    // namespace wipe. Run UNCONDITIONALLY (not gated on the flat-file count) so a
    // document-ingest row with no flat-file twin is deactivated too; awaited + surfaced
    // so a failed reap does not report a clean success (§0.1 loud contract).
    const kg = agent.toolContext.knowledgeLayer;
    if (!kg) {
      return flatCount > 0
        ? `Removed ${flatCount} line(s) matching "${input.pattern}" from ${input.namespace}${scopeSuffix}.`
        : `No lines matching "${input.pattern}" found in ${input.namespace}${scopeSuffix}.`;
    }
    try {
      const deactivated = await kg.deactivateByPattern(input.pattern, input.namespace);
      // Prefer the flat-file line count (what the agent sees in memory_list), but fall
      // back to the KG count so a document-ingest row (0 flat-file lines, live KG rows)
      // is not falsely reported as "nothing found".
      const total = flatCount > 0 ? flatCount : deactivated;
      return total > 0
        ? `Removed ${total} entr${total === 1 ? 'y' : 'ies'} matching "${input.pattern}" from ${input.namespace}${scopeSuffix}.`
        : `No entries matching "${input.pattern}" found in ${input.namespace}${scopeSuffix}.`;
    } catch {
      return `Removed "${input.pattern}" from ${input.namespace}${scopeSuffix}, but the recall mirror could not be updated — it may still surface until it is reconciled. This has been logged.`;
    }
  },
};

export const memoryUpdateTool: ToolEntry<MemoryUpdateInput> = {
  definition: {
    name: 'memory_update',
    description: 'Correct or refine previously saved knowledge. Tries an exact substring match first; if no line contains `old_content`, the closest matching lines (by token overlap) are marked `[SUPERSEDED YYYY-MM-DD]` and `new_content` is appended as a new line — so the new knowledge is never silently lost.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category to update',
        },
        old_content: {
          type: 'string',
          description: "A unique substring from the prior memory line you want to supersede. Best to pass an unambiguous span (e.g. 'PostgreSQL 16' rather than a full sentence) so the fuzzy matching finds the right line.",
        },
        new_content: { type: 'string', description: 'Replacement text' },
        scope: {
          type: 'string',
          description: SCOPE_PARAM_DESCRIPTION,
        },
      },
      required: ['namespace', 'old_content', 'new_content'],
    },
  },
  handler: async (input: MemoryUpdateInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }
    if (agent.secretStore?.containsSecret(input.new_content)) {
      return 'Cannot store content containing secret values in memory. Remove secrets and try again.';
    }

    const scopeRef = resolveScope(input.scope, agent);
    if (input.scope && !scopeRef) {
      return `Invalid or unauthorized scope: "${input.scope}".`;
    }

    // Try the exact substring path first (pre-#529 behaviour). When that
    // succeeds, KG mirror sync runs as before.
    const exactOk = scopeRef
      ? await agent.memory.updateScoped(input.namespace, input.old_content, input.new_content, scopeRef)
      : await agent.memory.update(input.namespace, input.old_content, input.new_content);

    if (exactOk) {
      // Mirror to KG so entity re-extraction picks up the corrected text.
      if (agent.toolContext.knowledgeLayer) {
        const defaultScope: MemoryScopeRef = scopeRef
          ?? agent.activeScopes?.[0]
          ?? { type: 'context', id: '' };
        void agent.toolContext.knowledgeLayer.updateMemoryText(
          input.old_content, input.new_content, input.namespace, defaultScope,
        ).catch(() => {});
      }
      return scopeRef
        ? `Updated content in ${input.namespace} namespace (scope: ${input.scope}).`
        : `Updated content in ${input.namespace} namespace.`;
    }

    // === Fallback: [SUPERSEDED YYYY-MM-DD] marker ===
    // Pre-#529 returned "not found" here and the new knowledge was lost.
    // Now we mark the closest matching prior lines and append the new content
    // as a fresh line — the agent is never silently dropping data.
    const content = scopeRef
      ? await agent.memory.loadScoped(input.namespace, scopeRef)
      : await agent.memory.load(input.namespace);

    const today = new Date().toISOString().slice(0, 10);
    const supersededMarker = `[SUPERSEDED ${today}] `;
    const lines = (content ?? '').split('\n');
    const candidates = findFuzzySupersedeCandidates(lines, input.old_content);
    let marked = 0;

    // Mark candidate lines in-memory; we'll persist via delete+append below.
    const linesToRewrite: Array<{ originalLine: string; markedLine: string }> = [];
    for (const idx of candidates) {
      const line = lines[idx]!;
      if (line.startsWith('[SUPERSEDED ')) continue; // don't double-prefix
      const markedLine = supersededMarker + line;
      linesToRewrite.push({ originalLine: line, markedLine });
      marked++;
    }

    // Persist via the same scoped/unscoped path the memory abstraction uses.
    // The IMemory interface doesn't expose a bulk "save" for scoped writes,
    // so we use deleteScoped({exact:true}) + appendScoped to swap each line
    // in place. The exact:true option (kept from T2-M1) is critical here so
    // substring matches don't bulk-delete unrelated lines.
    if (scopeRef) {
      for (const { originalLine, markedLine } of linesToRewrite) {
        await agent.memory.deleteScoped(
          input.namespace, originalLine, scopeRef, { exact: true },
        );
        await agent.memory.appendScoped(input.namespace, markedLine, scopeRef);
      }
      await agent.memory.appendScoped(input.namespace, input.new_content, scopeRef);
    } else {
      // Unscoped path: IMemory.delete has no {exact} option, so we use
      // substring delete. The originalLine is a full line so substring
      // collision is unlikely; if it happens, the duplicate marker on the
      // re-append still records the intent.
      for (const { originalLine, markedLine } of linesToRewrite) {
        await agent.memory.delete(input.namespace, originalLine);
        await agent.memory.append(input.namespace, markedLine);
      }
      await agent.memory.append(input.namespace, input.new_content);
    }

    // Mirror new content to KG via the same channel store uses — the
    // subscription in engine-init.ts will pick this up and create the
    // KG row + entity extraction.
    if (agent.toolContext.knowledgeLayer) {
      const defaultScope: MemoryScopeRef = scopeRef
        ?? agent.activeScopes?.[0]
        ?? { type: 'context', id: '' };
      channels.memoryStore.publish({
        namespace: input.namespace,
        content: input.new_content,
        scopeType: defaultScope.type,
        scopeId: defaultScope.id,
        sourceThreadId: agent.currentThreadId,
        // Wave 0.6: force-floored — no agent-declared provenance (PRD §2.8).
        sourceChannel: 'agent', sourceRunId: agent.currentRunId, sourceUntrusted: agent.sawUntrustedData,
      });
    }

    if (marked > 0) {
      return `Superseded ${marked} memor${marked === 1 ? 'y' : 'ies'} and added new content to ${input.namespace}${scopeRef ? ` (scope: ${input.scope})` : ''}.`;
    }
    return `Appended new content to ${input.namespace}${scopeRef ? ` (scope: ${input.scope})` : ''} (no prior memory matched the old_content pattern).`;
  },
};

// === Phase 3: memory_list + memory_promote ===

interface MemoryListInput {
  namespace?: MemoryNamespace | undefined;
  scope?: string | undefined;
  pattern?: string | undefined;
  limit?: number | undefined;
}

interface MemoryPromoteInput {
  namespace: MemoryNamespace;
  content_pattern: string;
  from_scope: string;
  to_scope: string;
}

export const memoryListTool: ToolEntry<MemoryListInput> = {
  definition: {
    name: 'memory_list',
    description: 'Browse all saved knowledge organized by category and scope.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Filter by namespace. Omit to list all namespaces.',
        },
        scope: {
          type: 'string',
          description: 'Filter by scope. Format: "context:<id>" (a project), "user:<name>", or "global". Omit to list all active scopes.',
        },
        pattern: {
          type: 'string',
          description: 'Filter entries containing this text (case-insensitive).',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return per namespace. Default: 20.',
        },
      },
      required: [],
    },
  },
  handler: async (input: MemoryListInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }

    const scopes: MemoryScopeRef[] = [];
    if (input.scope) {
      const parsed = resolveScope(input.scope, agent);
      if (!parsed) {
        return `Invalid or unauthorized scope: "${input.scope}".`;
      }
      scopes.push(parsed);
    } else {
      scopes.push(...(agent.activeScopes ?? []));
    }
    if (scopes.length === 0) {
      return 'No active scopes available.';
    }

    const namespaces = input.namespace ? [input.namespace] : ALL_NAMESPACES;
    const limit = input.limit ?? 20;
    const patternLower = input.pattern?.toLowerCase();

    const sections: string[] = [];

    for (const scope of scopes) {
      const scopeLabel = formatScopeRef(scope);
      const nsResults: string[] = [];

      for (const ns of namespaces) {
        const content = await agent.memory.loadScoped(ns, scope);
        if (!content) continue;

        let lines = content.split('\n').filter(l => l.trim().length > 0);
        if (patternLower) {
          lines = lines.filter(l => l.toLowerCase().includes(patternLower));
        }
        if (lines.length === 0) continue;

        const truncated = lines.slice(0, limit);
        const remaining = lines.length - truncated.length;
        const entriesText = truncated.map(l => `  - ${l}`).join('\n');
        nsResults.push(`[${ns}] (${lines.length} entries)\n${entriesText}${remaining > 0 ? `\n  ... and ${remaining} more` : ''}`);
      }

      if (nsResults.length > 0) {
        sections.push(`=== ${scopeLabel} ===\n${nsResults.join('\n\n')}`);
      }
    }

    if (sections.length === 0) {
      return 'No memory entries found matching the criteria.';
    }

    return sections.join('\n\n');
  },
};

export const memoryPromoteTool: ToolEntry<MemoryPromoteInput> = {
  // Promotion deletes from the source scope, so it is a data-destructive op — gate
  // it in autonomous mode exactly like memory_delete (an injected promote must not
  // silently move/erase knowledge without the destructive-op check).
  destructive: { mode: 'data' },
  definition: {
    name: 'memory_promote',
    description: 'Make knowledge available across all projects instead of just this one.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Memory namespace.',
        },
        content_pattern: {
          type: 'string',
          description: 'Text pattern to match the entry to promote. The first matching line will be promoted.',
        },
        from_scope: {
          type: 'string',
          description: 'Source scope to promote FROM (the narrower one). Format: "context:<id>" (a project) or "user:<name>".',
        },
        to_scope: {
          type: 'string',
          description: 'Target scope to promote TO (must be broader). Format: "global" (all projects) or "context:<id>".',
        },
      },
      required: ['namespace', 'content_pattern', 'from_scope', 'to_scope'],
    },
  },
  handler: async (input: MemoryPromoteInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }

    // An empty/whitespace pattern substring-matches (and would then delete) EVERY
    // line — an injected empty promote must not wipe the source namespace. Mirror
    // memory_delete's guard.
    if (!input.content_pattern.trim()) {
      return 'A non-empty content_pattern is required to promote.';
    }

    const fromRef = resolveScope(input.from_scope, agent);
    if (!fromRef) {
      return `Invalid or unauthorized source scope: "${input.from_scope}".`;
    }

    const toRef = resolveScope(input.to_scope, agent);
    if (!toRef) {
      return `Invalid or unauthorized target scope: "${input.to_scope}".`;
    }

    // Validate hierarchy: from must be more specific than to
    if (!isMoreSpecific(fromRef.type, toRef.type)) {
      return `Cannot promote: ${formatScopeRef(fromRef)} is not more specific than ${formatScopeRef(toRef)}. Promotion only works upward in the hierarchy (user → context → global).`;
    }

    // Find the entry to promote
    const content = await agent.memory.loadScoped(input.namespace, fromRef);
    if (!content) {
      return `No content found in ${input.namespace} (scope: ${input.from_scope}).`;
    }

    const lines = content.split('\n');
    const matchIdx = lines.findIndex(l => l.includes(input.content_pattern));
    if (matchIdx === -1) {
      return `No entry matching "${input.content_pattern}" found in ${input.namespace} (scope: ${input.from_scope}).`;
    }

    const matchedLine = lines[matchIdx]!;

    // Copy to target scope
    await agent.memory.appendScoped(input.namespace, matchedLine, toRef);
    channels.memoryStore.publish({
      namespace: input.namespace,
      content: matchedLine,
      scopeType: toRef.type,
      scopeId: toRef.id,
      sourceThreadId: agent.currentThreadId,
      // Promotion moves an existing line across scopes. The original tier
      // isn't available from the flat-file line without a KG lookup, so the
      // re-embedded copy lands at the conservative default — never falsely
      // elevated to tool_verified.
      sourceChannel: 'agent', sourceRunId: agent.currentRunId, sourceUntrusted: agent.sawUntrustedData,
    });

    // Remove from source scope + sync graph. Delete EXACTLY the one line we
    // promoted (`{exact:true}`), NOT every line containing content_pattern — a
    // substring delete erased sibling lines that were never promoted (silent data
    // loss; the tool copies ONE match but used to delete ALL). The KG twin is
    // deactivated by the promoted line's body (date prefix stripped to match the
    // stored statement text), same single-line scope.
    await agent.memory.deleteScoped(input.namespace, matchedLine, fromRef, { exact: true });
    const matchedBody = matchedLine.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').trim();
    if (agent.toolContext.knowledgeLayer && matchedBody) {
      void agent.toolContext.knowledgeLayer.deactivateByPattern(matchedBody, input.namespace).catch(() => {});
    }

    return `Promoted entry from ${formatScopeRef(fromRef)} to ${formatScopeRef(toRef)}:\n"${matchedLine.slice(0, 100)}${matchedLine.length > 100 ? '...' : ''}"`;
  },
};
