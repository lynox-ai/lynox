import type { ToolEntry, MemoryNamespace, IAgent, MemoryScopeRef } from '../../types/index.js';
import { ALL_NAMESPACES } from '../../types/index.js';
import { channels } from '../../core/observability.js';
import { parseScopeString, formatScopeRef, isMoreSpecific } from '../../core/scope-resolver.js';

// KnowledgeLayer accessed via agent.toolContext.knowledgeLayer

interface MemoryStoreInput {
  namespace: MemoryNamespace;
  content: string;
  scope?: string | undefined;
}

interface MemoryRecallInput {
  namespace: MemoryNamespace;
  scope?: string | undefined;
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
      channels.memoryStore.publish({ namespace: input.namespace, content: input.content, scopeType: scopeRef.type, scopeId: scopeRef.id });
      return `Stored in ${input.namespace} (scope: ${input.scope}). Entities and relationships are extracted automatically for future cross-referencing.`;
    }

    await agent.memory.append(input.namespace, input.content);
    channels.memoryStore.publish({ namespace: input.namespace, content: input.content });
    return `Stored in ${input.namespace}. Entities and relationships are extracted automatically for future cross-referencing.`;
  },
};

export const memoryRecallTool: ToolEntry<MemoryRecallInput> = {
  definition: {
    name: 'memory_recall',
    description: 'Look up previously saved knowledge by searching for relevant content.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category: knowledge (business facts), methods (techniques), status (current status), learnings (lessons learned)',
        },
        scope: {
          type: 'string',
          description: 'Scope to recall from. Format: "type:id" (e.g., "user:alex", "global"). Default: current project scope.',
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

    if (scopeRef) {
      const content = await agent.memory.loadScoped(input.namespace, scopeRef);
      return content ?? `No content found in ${input.namespace} namespace (scope: ${input.scope}).`;
    }

    const content = await agent.memory.load(input.namespace);
    return content ?? `No content found in ${input.namespace} namespace.`;
  },
};

export const memoryDeleteTool: ToolEntry<MemoryDeleteInput> = {
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

    if (scopeRef) {
      const count = await agent.memory.deleteScoped(input.namespace, input.pattern, scopeRef);
      // Sync: deactivate matching memories in Knowledge Graph
      if (count > 0 && agent.toolContext.knowledgeLayer) {
        void agent.toolContext.knowledgeLayer.deactivateByPattern(input.pattern, input.namespace).catch(() => {});
      }
      return count > 0
        ? `Removed ${count} line(s) matching "${input.pattern}" from ${input.namespace} (scope: ${input.scope}).`
        : `No lines matching "${input.pattern}" found in ${input.namespace} (scope: ${input.scope}).`;
    }

    const count = await agent.memory.delete(input.namespace, input.pattern);
    // Sync: deactivate matching memories in Knowledge Graph
    if (count > 0 && agent.toolContext.knowledgeLayer) {
      void agent.toolContext.knowledgeLayer.deactivateByPattern(input.pattern, input.namespace).catch(() => {});
    }
    return count > 0
      ? `Removed ${count} line(s) matching "${input.pattern}" from ${input.namespace}.`
      : `No lines matching "${input.pattern}" found in ${input.namespace}.`;
  },
};

export const memoryUpdateTool: ToolEntry<MemoryUpdateInput> = {
  definition: {
    name: 'memory_update',
    description: 'Correct or refine previously saved knowledge.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        namespace: {
          type: 'string',
          enum: ['knowledge', 'methods', 'status', 'learnings'],
          description: 'Category to update',
        },
        old_content: { type: 'string', description: 'Existing text to find' },
        new_content: { type: 'string', description: 'Replacement text' },
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

    if (scopeRef) {
      const success = await agent.memory.updateScoped(input.namespace, input.old_content, input.new_content, scopeRef);
      // Sync: update text in Knowledge Graph + re-extract entities
      if (success && agent.toolContext.knowledgeLayer) {
        void agent.toolContext.knowledgeLayer.updateMemoryText(input.old_content, input.new_content, input.namespace, scopeRef).catch(() => {});
      }
      return success
        ? `Updated content in ${input.namespace} namespace (scope: ${input.scope}).`
        : `Content not found in ${input.namespace} (scope: ${input.scope}) — nothing updated.`;
    }

    const success = await agent.memory.update(input.namespace, input.old_content, input.new_content);
    // Sync: update text in Knowledge Graph + re-extract entities
    if (success && agent.toolContext.knowledgeLayer) {
      const defaultScope: MemoryScopeRef = agent.activeScopes?.[0] ?? { type: 'context', id: '' };
      void agent.toolContext.knowledgeLayer.updateMemoryText(input.old_content, input.new_content, input.namespace, defaultScope).catch(() => {});
    }
    return success
      ? `Updated content in ${input.namespace} namespace.`
      : `Content not found in ${input.namespace} — nothing updated.`;
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
    });

    // Remove from source scope + sync graph
    await agent.memory.deleteScoped(input.namespace, input.content_pattern, fromRef);
    if (agent.toolContext.knowledgeLayer) {
      void agent.toolContext.knowledgeLayer.deactivateByPattern(input.content_pattern, input.namespace).catch(() => {});
    }

    return `Promoted entry from ${formatScopeRef(fromRef)} to ${formatScopeRef(toRef)}:\n"${matchedLine.slice(0, 100)}${matchedLine.length > 100 ? '...' : ''}"`;
  },
};
