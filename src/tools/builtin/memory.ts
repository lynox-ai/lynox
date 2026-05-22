import type {
  ToolEntry, MemoryNamespace, IAgent, MemoryScopeRef,
  KnowledgeRetrievalResult,
} from '../../types/index.js';
import { ALL_NAMESPACES } from '../../types/index.js';
import { channels } from '../../core/observability.js';
import { parseScopeString, formatScopeRef, isMoreSpecific } from '../../core/scope-resolver.js';
import { estimateTokens } from '../../core/llm-helper.js';

// KnowledgeLayer accessed via agent.toolContext.knowledgeLayer

/** Max ranked KG results returned by a query-based memory_recall. */
const KG_RECALL_TOP_K = 10;
/** Max recency-ordered KG rows returned by a no-query memory_recall. */
const KG_NO_QUERY_LIMIT = 20;
/**
 * Similarity floor for the recall tool's KG call. Lower than the
 * `RetrievalEngine` default of 0.55 because the tool already bounds via
 * `topK` — we'd rather surface a marginally-relevant memory than miss one
 * the agent actually needs. The MMR re-rank still suppresses obvious noise.
 */
const KG_RECALL_THRESHOLD = 0.3;

/**
 * Token budget for a namespace-only (no-query) memory_recall.
 *
 * A no-query recall used to return the ENTIRE namespace file into context
 * (commonly 15-20K tokens), which then gets re-cached on every subsequent
 * turn -- pure cost + context bloat. When the caller gives no query we cannot
 * relevance-rank, so instead we return a recency/importance-ranked subset
 * capped at this budget. ~5K tokens keeps the most relevant memory available
 * while leaving the bulk of the context window for the actual conversation.
 * A recall WITH a query is unaffected and still returns the full namespace.
 */
const RECALL_NO_QUERY_TOKEN_BUDGET = 5_000;

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
          description: 'Scope: "organization" (all projects), "user:name" (personal), or omit for current project.',
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

    if (scopeRef) {
      await agent.memory.appendScoped(input.namespace, input.content, scopeRef);
      channels.memoryStore.publish({ namespace: input.namespace, content: input.content, scopeType: scopeRef.type, scopeId: scopeRef.id, sourceThreadId: agent.currentThreadId });
      return `Stored in ${input.namespace} (scope: ${input.scope}). Entities and relationships are extracted automatically for future cross-referencing.`;
    }

    await agent.memory.append(input.namespace, input.content);
    channels.memoryStore.publish({ namespace: input.namespace, content: input.content, sourceThreadId: agent.currentThreadId });
    return `Stored in ${input.namespace}. Entities and relationships are extracted automatically for future cross-referencing.`;
  },
};

/**
 * Format ranked KG memory rows into the recall tool's structured response.
 *
 * Each entry surfaces: namespace, relevance %, confidence %, scope, date, text.
 * This is the new contract — the agent sees ranked, attributed results instead
 * of a raw namespace dump.
 */
function formatRankedMemories(
  memories: KnowledgeRetrievalResult['memories'],
  header: string,
  footer: string,
): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m, i) => {
    const date = m.createdAt.slice(0, 10);
    const scopeLabel = m.scopeType === 'global' ? 'global' : `${m.scopeType}:${m.scopeId}`;
    const relevancePct = Math.round(m.finalScore * 100);
    const confidencePct = Math.round(m.score * 100);
    // finalScore is 0 for the no-query (recency) path — only show relevance for query-based recall.
    const scoreParts: string[] = [];
    if (relevancePct > 0) scoreParts.push(`${relevancePct}% match`);
    if (confidencePct > 0) scoreParts.push(`${confidencePct}% confidence`);
    const scoreSegment = scoreParts.length > 0 ? ` (${scoreParts.join(', ')})` : '';
    return `${i + 1}. [${m.namespace}]${scoreSegment} — ${scopeLabel} — ${date}\n   ${m.text}`;
  });
  return `${header}\n${lines.join('\n\n')}\n\n${footer}`;
}

export const memoryRecallTool: ToolEntry<MemoryRecallInput> = {
  definition: {
    name: 'memory_recall',
    description: 'Look up previously saved knowledge through the structured Knowledge Graph. Returns RANKED results — each entry is attributed with its namespace, relevance score, confidence score, scope, and date. With `query` you get the top relevance-ranked matches via vector + graph retrieval (capped at 10, never a full dump). Without `query` you get the most-recent active memories in the namespace (capped at 20). Results are bounded by design — old/superseded/contradictory entries are filtered out. Only call this when the CURRENT user message clearly needs prior context to answer — do NOT call it on short follow-ups ("ok", "ja", one-word replies), topic continuations, or when the visible conversation already contains what you need. Recalled entries can be from arbitrary past sessions; do not treat them as "what to do next" unless the user has just said so this turn.',
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
          description: 'What you are looking for, in natural language. With a query, the top relevance-ranked matches (max 10) are returned via vector + graph retrieval. Omit only when you want the most-recent entries in the namespace; then a bounded recency-ordered slice (max 20) is returned.',
        },
        scope: {
          type: 'string',
          description: 'Scope to recall from. Format: "type:id" (e.g., "user:alex", "global"). Default: search across all the agent\'s active scopes.',
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

    const trimmedQuery = input.query?.trim() ?? '';
    const hasQuery = trimmedQuery.length > 0;

    // === KG path (primary) ===========================================
    // The flat files are an export mirror; the structured KG is the source
    // of truth. is_active=0 / superseded rows are filtered server-side.
    const kl = agent.toolContext.knowledgeLayer;
    if (kl) {
      const scopes: MemoryScopeRef[] = scopeRef
        ? [scopeRef]
        : (agent.activeScopes ?? []);

      if (scopes.length === 0) {
        return 'No active scopes available for memory recall.';
      }

      if (hasQuery) {
        try {
          const result = await kl.retrieve(trimmedQuery, scopes, {
            namespace: input.namespace,
            topK: KG_RECALL_TOP_K,
            threshold: KG_RECALL_THRESHOLD,
            useGraphExpansion: true,
          });
          if (result.memories.length === 0) {
            const scopeNote = scopeRef ? ` (scope: ${input.scope})` : '';
            return `No memories matching "${trimmedQuery}" found in ${input.namespace}${scopeNote}.`;
          }
          return formatRankedMemories(
            result.memories,
            `=== ${result.memories.length} ranked ${input.namespace} memories for "${trimmedQuery}" ===`,
            `[Ranked by relevance + confidence + recency. Older/superseded memories are filtered out. Bounded at ${KG_RECALL_TOP_K} results by design.]`,
          );
        } catch {
          // KG path failed — fall through to flat-file mirror.
        }
      } else {
        // No query: recency-ordered slice from the KG.
        try {
          const recent = (kl as { listRecentActive?: (
            namespace: MemoryNamespace, scopes: MemoryScopeRef[], limit?: number,
          ) => KnowledgeRetrievalResult['memories'] }).listRecentActive?.(
            input.namespace, scopes, KG_NO_QUERY_LIMIT,
          ) ?? [];
          if (recent.length === 0) {
            const scopeNote = scopeRef ? ` (scope: ${input.scope})` : '';
            return `No content found in ${input.namespace} namespace${scopeNote}.`;
          }
          return formatRankedMemories(
            recent,
            `=== ${recent.length} most-recent active ${input.namespace} memories ===`,
            `[Recency-ordered (newest first). Bounded at ${KG_NO_QUERY_LIMIT} results. Pass a \`query\` to get relevance-ranked matches instead.]`,
          );
        } catch {
          // KG path failed — fall through to flat-file mirror.
        }
      }
    }

    // === Flat-file mirror fallback ===================================
    // Used when no KG is wired (e.g., minimal-agent unit tests). The mirror
    // is best-effort — the KG is the source of truth in production.
    const content = scopeRef
      ? await agent.memory.loadScoped(input.namespace, scopeRef)
      : await agent.memory.load(input.namespace);

    if (content === null) {
      return scopeRef
        ? `No content found in ${input.namespace} namespace (scope: ${input.scope}).`
        : `No content found in ${input.namespace} namespace.`;
    }

    if (hasQuery) {
      // No KG and a query: best-effort substring filter from the flat mirror.
      const matches = content.split('\n')
        .filter(l => l.trim().length > 0)
        .filter(l => l.toLowerCase().includes(trimmedQuery.toLowerCase()))
        .slice(0, KG_RECALL_TOP_K);
      if (matches.length === 0) {
        return `No memories matching "${trimmedQuery}" found in ${input.namespace} (flat-file mirror; KG unavailable).`;
      }
      return `=== ${matches.length} flat-file matches for "${trimmedQuery}" (KG unavailable) ===\n${matches.join('\n')}`;
    }

    // No KG and no query: recency-ranked subset (legacy bounded behaviour).
    const { text, shown, total } = rankNoQueryEntries(content, RECALL_NO_QUERY_TOKEN_BUDGET);
    if (shown === 0) {
      return content;
    }
    if (shown >= total) {
      return text;
    }
    return `${text}\n\n[Showing ${shown} of ${total} ${input.namespace} entries — most recent first, capped to keep context lean. Pass a \`query\` to memory_recall to retrieve the full matching set.]`;
  },
};

export const memoryDeleteTool: ToolEntry<MemoryDeleteInput> = {
  destructive: { mode: 'data' },
  definition: {
    name: 'memory_delete',
    description: 'Remove outdated information from your knowledge base. Matching memories are deactivated in the Knowledge Graph (is_active=0) — they stay in the database for audit and are filtered out of all future memory_recall calls. The flat-file export mirror is updated in sync.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category to delete from',
        },
        pattern: { type: 'string', description: 'Text pattern — memories containing this will be deactivated' },
        scope: {
          type: 'string',
          description: 'Scope: "organization" (all projects), "user:name" (personal), or omit for current project.',
        },
      },
      required: ['namespace', 'pattern'],
    },
  },
  handler: async (input: MemoryDeleteInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
    }

    const scopeRef = resolveScope(input.scope, agent);
    if (input.scope && !scopeRef) {
      return `Invalid or unauthorized scope: "${input.scope}".`;
    }

    // KG deactivation is the authoritative delete (is_active=0). The flat
    // file is the export mirror and is kept in sync. We prefer the KG count
    // when available so the user sees the truth, not a side-effect of file
    // substring matching.
    const kl = agent.toolContext.knowledgeLayer;

    if (scopeRef) {
      const mirrorCount = await agent.memory.deleteScoped(input.namespace, input.pattern, scopeRef);
      let kgCount = 0;
      if (kl) {
        try { kgCount = await kl.deactivateByPattern(input.pattern, input.namespace); }
        catch { /* best-effort */ }
      }
      const count = Math.max(kgCount, mirrorCount);
      return count > 0
        ? `Deactivated ${count} memor${count === 1 ? 'y' : 'ies'} matching "${input.pattern}" in ${input.namespace} (scope: ${input.scope}). History preserved via is_active=0.`
        : `No memories matching "${input.pattern}" found in ${input.namespace} (scope: ${input.scope}).`;
    }

    const mirrorCount = await agent.memory.delete(input.namespace, input.pattern);
    let kgCount = 0;
    if (kl) {
      try { kgCount = await kl.deactivateByPattern(input.pattern, input.namespace); }
      catch { /* best-effort */ }
    }
    const count = Math.max(kgCount, mirrorCount);
    return count > 0
      ? `Deactivated ${count} memor${count === 1 ? 'y' : 'ies'} matching "${input.pattern}" in ${input.namespace}. History preserved via is_active=0.`
      : `No memories matching "${input.pattern}" found in ${input.namespace}.`;
  },
};

export const memoryUpdateTool: ToolEntry<MemoryUpdateInput> = {
  definition: {
    name: 'memory_update',
    description: 'Correct or refine previously saved knowledge. The matching memory is superseded — the old row is preserved (is_active=0, superseded_by=new.id) and a new active row carrying the corrected text is created. History stays intact; memory_recall returns only the active (corrected) row going forward. The flat-file export mirror is updated in sync.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category to update',
        },
        old_content: { type: 'string', description: 'Existing memory text to supersede (exact match within the chosen scope).' },
        new_content: { type: 'string', description: 'Replacement text for the new active memory.' },
        scope: {
          type: 'string',
          description: 'Scope: "organization" (all projects), "user:name" (personal), or omit for current project.',
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

    // KG supersession is the authoritative update — old row stays in the
    // table marked superseded, new row is created active. The flat file is
    // a mirror and is kept in sync via the existing substring update.
    const kl = agent.toolContext.knowledgeLayer;
    const effectiveScope: MemoryScopeRef = scopeRef
      ?? agent.activeScopes?.[0]
      ?? { type: 'context', id: '' };

    let kgUpdated = false;
    if (kl) {
      try {
        const newId = await kl.updateMemoryWithSupersession(
          input.old_content, input.new_content, input.namespace, effectiveScope,
          { sourceThreadId: agent.currentThreadId },
        );
        kgUpdated = newId !== null;
      } catch {
        kgUpdated = false;
      }
    }

    // Mirror the change into the flat file too (substring update).
    const mirrorOk = scopeRef
      ? await agent.memory.updateScoped(input.namespace, input.old_content, input.new_content, scopeRef)
      : await agent.memory.update(input.namespace, input.old_content, input.new_content);

    const success = kgUpdated || mirrorOk;
    const scopeLabel = input.scope ?? formatScopeRef(effectiveScope);
    if (!success) {
      return `Content not found in ${input.namespace} (scope: ${scopeLabel}) — nothing updated.`;
    }
    if (kgUpdated) {
      return `Superseded memory in ${input.namespace} (scope: ${scopeLabel}). Old row preserved (is_active=0, superseded_by=new). Mirror file ${mirrorOk ? 'synced' : 'sync-skipped'}.`;
    }
    return `Updated content in ${input.namespace} namespace (scope: ${scopeLabel}). KG sync skipped (no graph attached).`;
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
          description: 'Filter by scope. Format: "type:id" (e.g., "user:alex", "global"). Omit to list all active scopes.',
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
          description: 'Source scope. Format: "type:id" (e.g., "project:abc123").',
        },
        to_scope: {
          type: 'string',
          description: 'Target scope (must be broader). Format: "type:id" (e.g., "organization:acme").',
        },
      },
      required: ['namespace', 'content_pattern', 'from_scope', 'to_scope'],
    },
  },
  handler: async (input: MemoryPromoteInput, agent: IAgent): Promise<string> => {
    if (!agent.memory) {
      return 'Memory is not configured for this agent.';
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
    });

    // Remove from source scope + sync graph
    await agent.memory.deleteScoped(input.namespace, input.content_pattern, fromRef);
    if (agent.toolContext.knowledgeLayer) {
      void agent.toolContext.knowledgeLayer.deactivateByPattern(input.content_pattern, input.namespace).catch(() => {});
    }

    return `Promoted entry from ${formatScopeRef(fromRef)} to ${formatScopeRef(toRef)}:\n"${matchedLine.slice(0, 100)}${matchedLine.length > 100 ? '...' : ''}"`;
  },
};
