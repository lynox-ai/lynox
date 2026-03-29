/**
 * Memory-related CLI commands: /memory, /scope, /knowledge
 */

import type { Session } from '../../core/session.js';
import type { MemoryNamespace } from '../../types/index.js';
import { getErrorMessage } from '../../core/utils.js';
import { runMemoryGc } from '../../core/memory-gc.js';
import { renderTable, BOLD, DIM, GREEN, RED, RESET } from '../ui.js';
import { VALID_NAMESPACES } from '../help-text.js';
import type { CLICtx } from './types.js';

export async function handleKnowledge(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const knowSub = parts[1];
  const rh = session.getRunHistory();
  const ctxObj = session.getContext();
  if (!rh) { ctx.stdout.write('Run history not available.\n'); return true; }
  const pid = ctxObj?.id ?? '';

  if (knowSub === 'prune') {
    const deleted = rh.deleteOldEmbeddings(90);
    ctx.stdout.write(`Pruned ${deleted} entries older than 90 days with no retrievals.\n`);
  } else {
    const entries = rh.getEmbeddings(pid);
    if (entries.length === 0) { ctx.stdout.write('No knowledge entries stored.\n'); } else {
      ctx.stdout.write(`${BOLD}Knowledge Base${RESET} (${entries.length} entries)\n`);
      const rows = entries.slice(0, 30).map(e => [
        e.namespace,
        e.text.slice(0, 50),
        e.provider,
        e.last_retrieved_at ? 'yes' : 'no',
        e.created_at,
      ]);
      ctx.stdout.write(renderTable(['Namespace', 'Text', 'Provider', 'Retrieved', 'Created'], rows) + '\n');
    }
  }
  return true;
}

export async function handleScope(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];
  const scopes = session.getActiveScopes();

  if (!sub || sub === 'info') {
    // Show active scopes for current session
    if (scopes.length === 0) {
      ctx.stdout.write(`${DIM}No active scopes.${RESET}\n`);
    } else {
      ctx.stdout.write(`${BOLD}Active memory scopes:${RESET}\n`);
      const { SCOPE_WEIGHTS: SW } = await import('../../types/index.js');
      const history = session.getRunHistory();
      for (const s of scopes) {
        const label = s.type === 'global' ? 'global' : `${s.type}:${s.id}`;
        let parentInfo = '';
        if (history) {
          const scopeRecord = history.getScope(s.id);
          if (scopeRecord?.parent_id) parentInfo = ` → parent: ${scopeRecord.parent_id}`;
        }
        ctx.stdout.write(`  ${GREEN}${label}${RESET} ${DIM}(weight: ${SW[s.type]}${parentInfo})${RESET}\n`);
      }
      const uid = session.getUserId();
      if (uid) ctx.stdout.write(`\n${DIM}User ID: ${uid}${RESET}\n`);
    }
  } else if (sub === 'list') {
    // List all registered scopes from SQLite
    const history = session.getRunHistory();
    if (!history) {
      ctx.stdout.write(`${DIM}No run history available.${RESET}\n`);
    } else {
      const allScopes = history.listScopes();
      if (allScopes.length === 0) {
        ctx.stdout.write(`${DIM}No scopes registered.${RESET}\n`);
      } else {
        const rows = allScopes.map(s => [s.id.slice(0, 16), s.type, s.name, s.created_at]);
        ctx.stdout.write(renderTable(['ID', 'Type', 'Name', 'Created'], rows));
      }
    }
  } else if (sub === 'create') {
    const type = parts[2];
    const id = parts[3];
    const parentFlag = parts.indexOf('--parent');
    const parentId = parentFlag !== -1 ? parts[parentFlag + 1] : undefined;
    if (!type || (type !== 'global' && !id)) {
      ctx.stdout.write(`Usage: /scope create <user|project|organization|client|global> [id] [--parent <id>]\n`);
    } else {
      const history = session.getRunHistory();
      if (!history) {
        ctx.stdout.write(`${DIM}No run history available.${RESET}\n`);
      } else {
        const scopeId = type === 'global' ? 'global' : id!;
        const name = type === 'global' ? 'Global'
          : type === 'user' ? `User ${scopeId}`
          : type === 'organization' ? `Organization ${scopeId.slice(0, 8)}`
          : type === 'client' ? `Client ${scopeId.slice(0, 8)}`
          : `Project ${scopeId.slice(0, 8)}`;
        history.insertScope(scopeId, type, name, parentId);
        ctx.stdout.write(`${GREEN}Scope created: ${type}:${scopeId}${parentId ? ` (parent: ${parentId})` : ''}${RESET}\n`);
      }
    }
  } else if (sub === 'tree') {
    const rootId = parts[2] ?? 'global';
    const history = session.getRunHistory();
    if (!history) {
      ctx.stdout.write(`${DIM}No run history available.${RESET}\n`);
    } else {
      const tree = history.getScopeTree(rootId);
      if (tree.length === 0) {
        ctx.stdout.write(`${DIM}No scope found with id: ${rootId}${RESET}\n`);
      } else {
        for (const node of tree) {
          const indent = '  '.repeat(node.depth);
          const label = node.type === 'global' ? 'global' : `${node.type}:${node.id}`;
          ctx.stdout.write(`${indent}${GREEN}${label}${RESET} ${DIM}(${node.name})${RESET}\n`);
        }
      }
    }
  } else if (sub === 'overrides') {
    const mem = session.getMemory();
    if (!mem) {
      ctx.stdout.write(`${DIM}Memory not configured.${RESET}\n`);
    } else {
      const { inferScopeFromContext } = await import('../../core/scope-resolver.js');
      const entries: Array<{ namespace: 'knowledge' | 'methods' | 'status' | 'learnings'; text: string; scope: import('../../types/index.js').MemoryScopeRef }> = [];
      for (const s of scopes) {
        for (const ns of ['knowledge', 'methods', 'status', 'learnings'] as const) {
          const content = await mem.loadScoped(ns, s);
          if (content) {
            for (const line of content.split('\n').filter(l => l.trim().length > 10)) {
              entries.push({ namespace: ns, text: line.trim(), scope: s });
            }
          }
        }
      }
      const overrides = inferScopeFromContext(entries);
      if (overrides.length === 0) {
        ctx.stdout.write(`${DIM}No scope overrides detected.${RESET}\n`);
      } else {
        ctx.stdout.write(`${BOLD}Potential scope overrides:${RESET}\n`);
        for (const o of overrides) {
          const { formatScopeRef } = await import('../../core/scope-resolver.js');
          ctx.stdout.write(`\n  ${BOLD}[${o.namespace}]${RESET} ${formatScopeRef(o.specificScope)} overrides ${formatScopeRef(o.generalScope)}\n`);
          ctx.stdout.write(`    ${DIM}Specific: ${o.specificText}${RESET}\n`);
          ctx.stdout.write(`    ${DIM}General:  ${o.generalText}${RESET}\n`);
        }
      }
    }
  } else if (sub === 'memory') {
    const scopeStr = parts[2];
    if (!scopeStr) {
      ctx.stdout.write(`Usage: /scope memory <type:id> (e.g., /scope memory global, /scope memory user:alex)\n`);
    } else {
      const { parseScopeString } = await import('../../core/scope-resolver.js');
      const ref = parseScopeString(scopeStr);
      if (!ref) {
        ctx.stdout.write(`${RED}Invalid scope format: ${scopeStr}${RESET}\n`);
      } else {
        const mem = session.getMemory();
        if (!mem) {
          ctx.stdout.write(`${DIM}Memory not configured.${RESET}\n`);
        } else {
          const nss: Array<'knowledge' | 'methods' | 'status' | 'learnings'> = ['knowledge', 'methods', 'status', 'learnings'];
          let hasAny = false;
          for (const ns of nss) {
            const content = await mem.loadScoped(ns, ref);
            if (content) {
              ctx.stdout.write(`\n${BOLD}[${ns}]${RESET} ${DIM}(${scopeStr})${RESET}\n${content}\n`);
              hasAny = true;
            }
          }
          if (!hasAny) {
            ctx.stdout.write(`${DIM}No memory content in scope ${scopeStr}.${RESET}\n`);
          }
        }
      }
    }
  } else if (sub === 'stats') {
    // Show per-scope memory counts, average age, last updated
    const mem = session.getMemory();
    if (!mem) {
      ctx.stdout.write(`${DIM}Memory not configured.${RESET}\n`);
    } else {
      const rows: string[][] = [];
      for (const s of scopes) {
        const scopeLabel = s.type === 'global' ? 'global' : `${s.type}:${s.id}`;
        let totalEntries = 0;
        for (const ns of ['knowledge', 'methods', 'status', 'learnings'] as const) {
          const content = await mem.loadScoped(ns, s);
          if (content) {
            totalEntries += content.split('\n').filter(l => l.trim().length > 0).length;
          }
        }
        // Check embedding count from history
        const history = session.getRunHistory();
        let embCount = 0;
        if (history) {
          const embs = history.getEmbeddingsByScope(s.type, s.id);
          embCount = embs.length;
        }
        rows.push([scopeLabel, String(totalEntries), String(embCount)]);
      }
      if (rows.length === 0) {
        ctx.stdout.write(`${DIM}No active scopes.${RESET}\n`);
      } else {
        ctx.stdout.write(renderTable(['Scope', 'Memory Lines', 'Embeddings'], rows));
      }
    }
  } else if (sub === 'migrate') {
    const fromStr = parts[2];
    const toStr = parts[3];
    if (!fromStr || !toStr) {
      ctx.stdout.write(`Usage: /scope migrate <from_scope> <to_scope> (e.g., /scope migrate project:abc123 organization:acme)\n`);
    } else {
      const { parseScopeString, isMoreSpecific: imsCheck, formatScopeRef: fsr } = await import('../../core/scope-resolver.js');
      const fromRef = parseScopeString(fromStr);
      const toRef = parseScopeString(toStr);
      if (!fromRef || !toRef) {
        ctx.stdout.write(`${RED}Invalid scope format.${RESET}\n`);
      } else if (!imsCheck(fromRef.type, toRef.type)) {
        ctx.stdout.write(`${RED}Source must be more specific than target.${RESET}\n`);
      } else {
        const mem = session.getMemory();
        if (!mem) {
          ctx.stdout.write(`${DIM}Memory not configured.${RESET}\n`);
        } else {
          let totalMigrated = 0;
          for (const ns of ['knowledge', 'methods', 'status', 'learnings'] as const) {
            const content = await mem.loadScoped(ns, fromRef);
            if (!content) continue;
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
              await mem.appendScoped(ns, line, toRef);
              totalMigrated++;
            }
          }
          ctx.stdout.write(`${GREEN}Migrated ${totalMigrated} entries from ${fsr(fromRef)} to ${fsr(toRef)}.${RESET}\n`);
          ctx.stdout.write(`${DIM}Source scope content preserved. Use /scope memory ${fromStr} to verify, then manually clear if desired.${RESET}\n`);
        }
      }
    }
  } else {
    ctx.stdout.write(`Usage: /scope [info|list|create|tree|overrides|memory|stats|migrate]\n`);
  }
  return true;
}

export async function handleMemory(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const ns = parts[1];
  const mem = session.getMemory();
  if (!mem) {
    ctx.stdout.write('Memory is not configured.\n');
    return true;
  }
  if (ns === 'cleanup' || ns === 'gc') {
    const provider = session.getEmbeddingProvider();
    const history = session.getRunHistory();
    const scopes = session.getActiveScopes();
    if (!provider || !history) {
      ctx.stdout.write('Memory GC requires embedding provider and run history.\n');
      return true;
    }
    if (scopes.length === 0) {
      ctx.stdout.write('No active scopes configured.\n');
      return true;
    }
    const dryRun = parts[2] === 'dry';
    ctx.stdout.write(`Running knowledge cleanup${dryRun ? ' (dry run)' : ''}...\n`);
    try {
      const gcResult = await runMemoryGc(mem, scopes, provider, history, { dryRun });
      ctx.stdout.write(`${BOLD}Cleanup complete:${RESET}\n`);
      ctx.stdout.write(`  Deduplicated: ${GREEN}${gcResult.deduplicated}${RESET} lines\n`);
      ctx.stdout.write(`  Pruned:       ${GREEN}${gcResult.pruned}${RESET} stale entries\n`);
      ctx.stdout.write(`  Scopes:       ${gcResult.scopesProcessed}/${scopes.length}\n`);
      ctx.stdout.write(`  Namespaces:   ${gcResult.namespacesProcessed}\n`);
      if (dryRun) ctx.stdout.write(`${DIM}Dry run — no changes made.${RESET}\n`);
    } catch (err: unknown) {
      ctx.stdout.write(`Cleanup failed: ${getErrorMessage(err)}\n`);
    }
    return true;
  }
  // Delegate to embedded subcommands
  if (ns === 'embeddings') {
    return handleKnowledge(['', ...parts.slice(2)], session, ctx);
  }
  if (ns === 'scope') {
    return handleScope(['', ...parts.slice(2)], session, ctx);
  }
  if (ns && VALID_NAMESPACES.has(ns)) {
    const content = await mem.load(ns as MemoryNamespace);
    ctx.stdout.write(content ? `[${ns}]\n${content}\n` : `No content in ${ns}.\n`);
  } else if (ns) {
    ctx.stdout.write(`Unknown subcommand: ${ns}. Use: cleanup, or a namespace (knowledge/methods/status/learnings). See also /knowledge and /scope.\n`);
  } else {
    const rendered = mem.render();
    ctx.stdout.write(rendered ? `${rendered}\n` : 'Memory is empty.\n');
  }
  return true;
}
