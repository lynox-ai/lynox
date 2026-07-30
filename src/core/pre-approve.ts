import { randomUUID } from 'node:crypto';
import type { PreApprovalPattern, PreApprovalSet, PreApproveAuditLike } from '../types/index.js';
import { channels } from './observability.js';
import { isCriticalTool } from '../tools/permission-guard.js';

/**
 * Convert a glob pattern to a RegExp.
 * - `**` matches anything (including `/`)
 * - `*` matches anything except `/`
 * - All other regex-special characters are escaped.
 *
 * INVARIANT: the emitted pattern never contains two ADJACENT unanchored
 * quantifiers (`.*`/`[^/]*`), which is the catastrophic-backtracking shape — a
 * hostile glob (e.g. an imported capability-contract `hostPattern`) tested
 * against a non-matching host would otherwise freeze the event loop. Adjacency
 * arises not only from consecutive stars but from repeated double-star groups
 * separated by slashes: each double-star also consumes its trailing slash, so the
 * separators vanish and the quantifiers land side by side — both cases coalesce.
 * Two adjacent unanchored quantifiers are match-equivalent to a single `.*` (both
 * match any run), so they merge; a quantifier separated by any literal (a `?`, a
 * dot, a domain label, an un-eaten slash) stays anchored and never backtracks.
 */
export function globToRegex(glob: string): RegExp {
  const parts: string[] = [];
  // Append an unanchored quantifier, merging with a preceding one so the output
  // can never hold two in a row (`.*` ⊇ `[^/]*`, so the union is always `.*`).
  const coalesceQuantifier = (q: '.*' | '[^/]*'): void => {
    const last = parts[parts.length - 1];
    if (last === '.*' || last === '[^/]*') {
      parts[parts.length - 1] = '.*';
    } else {
      parts.push(q);
    }
  };
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      coalesceQuantifier('.*');
      i += 2;
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      coalesceQuantifier('[^/]*');
      i++;
    } else if (ch === '?') {
      parts.push('[^/]');
      i++;
    } else if ('.+(){}[]^$|\\'.includes(ch)) {
      parts.push('\\' + ch);
      i++;
    } else {
      parts.push(ch);
      i++;
    }
  }
  return new RegExp(`^${parts.join('')}$`);
}

/** Structurally-unrelated probe hosts across unrelated TLDs. A single host glob
 *  that matches ≥2 of these matches (nearly) any host (`*`, `**`, `*.*`, …) — an
 *  over-broad grant. A bounded label wildcard (`*.googleapis.com`) matches none. */
const OVERBROAD_HOST_PROBES = [
  'a.example.com',
  'b.attacker-domain.net',
  'c.some-host.org',
  'internal.local',
] as const;

/**
 * Is `pattern` an over-broad host glob — one that grants (nearly) any host rather
 * than pinning specific ones? Reuses {@link globToRegex} (the SAME matcher the
 * capability-contract enforcement uses, so this can't drift from it) and tests it
 * against structurally-unrelated probes: a match on ≥2 unrelated TLDs means the
 * pattern is a match-anything wildcard = fleet-wide egress intent. An unparseable
 * pattern is treated as over-broad (fail-closed). Used to reject an over-broad
 * grant at contract save-time and to flag one on the workflow-import consent surface.
 */
export function isOverbroadHostPattern(pattern: string): boolean {
  let re: RegExp;
  try {
    re = globToRegex(pattern);
  } catch {
    return true;
  }
  return OVERBROAD_HOST_PROBES.filter(h => re.test(h)).length >= 2;
}

/**
 * Extract a match string from a tool call for pattern matching.
 */
export function extractMatchString(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'bash':
      return typeof obj['command'] === 'string' ? obj['command'] : '';
    case 'write_file':
    case 'edit_file':
    case 'read_file':
      return typeof obj['path'] === 'string' ? obj['path'] : '';
    case 'http_request':
      return `${String(obj['method'] ?? 'GET')} ${String(obj['url'] ?? '')}`;
    case 'spawn_agent':
      return `spawn:${String(obj['task'] ?? '')}`;
    case 'batch_files':
      return `${String(obj['operation'] ?? '')}:${String(obj['pattern'] ?? '')}`;
    default:
      return JSON.stringify(input).slice(0, 500);
  }
}

/**
 * Check if a tool call matches any pre-approved pattern.
 * Returns `true` if auto-approved (caller should skip the permission prompt).
 * Mutates `set.usageCounts` on match.
 */
export function matchesPreApproval(
  toolName: string,
  input: unknown,
  set: PreApprovalSet,
  audit?: PreApproveAuditLike | undefined,
): boolean {
  if (set.patterns.length === 0) return false;

  const matchStr = extractMatchString(toolName, input);
  if (!matchStr) return false;

  // TTL check
  if (set.ttlMs > 0) {
    const elapsed = Date.now() - new Date(set.approvedAt).getTime();
    if (elapsed > set.ttlMs) {
      // Record expired for the first matching tool pattern
      for (let i = 0; i < set.patterns.length; i++) {
        if (set.patterns[i]!.tool === toolName) {
          audit?.recordCheck({
            setId: set.id, patternIdx: i, toolName, matchString: matchStr,
            pattern: set.patterns[i]!.pattern, decision: 'expired',
          });
          channels.preApprovalExpired.publish({ setId: set.id, toolName, matchString: matchStr });
          break;
        }
      }
      return false;
    }
  }

  for (let i = 0; i < set.patterns.length; i++) {
    const pat = set.patterns[i]!;
    if (pat.tool !== toolName) continue;

    // Usage limit check (0 = unlimited)
    if (set.maxUses > 0 && (set.usageCounts[i] ?? 0) >= set.maxUses) {
      audit?.recordCheck({
        setId: set.id, patternIdx: i, toolName, matchString: matchStr,
        pattern: pat.pattern, decision: 'exhausted',
      });
      channels.preApprovalExhausted.publish({ setId: set.id, toolName, matchString: matchStr, pattern: pat.pattern });
      continue;
    }

    const regex = globToRegex(pat.pattern);
    if (regex.test(matchStr)) {
      set.usageCounts[i] = (set.usageCounts[i] ?? 0) + 1;
      audit?.recordCheck({
        setId: set.id, patternIdx: i, toolName, matchString: matchStr,
        pattern: pat.pattern, decision: 'approved',
      });
      channels.preApprovalMatch.publish({ setId: set.id, toolName, matchString: matchStr, pattern: pat.pattern });
      return true;
    }
  }

  return false;
}

// Re-export isCriticalTool from permission-guard (canonical location)
export { isCriticalTool } from '../tools/permission-guard.js';

/**
 * Build a PreApprovalSet from patterns, filtering out any that would
 * match critical operations.
 */
export function buildApprovalSet(
  patterns: PreApprovalPattern[],
  options?: {
    maxUses?: number | undefined;
    ttlMs?: number | undefined;
    taskSummary?: string | undefined;
  },
): PreApprovalSet {
  const safePatterns = patterns.filter(p => !isCriticalTool(p.tool, p.pattern));

  return {
    id: randomUUID(),
    approvedAt: new Date().toISOString(),
    approvedBy: 'operator',
    taskSummary: options?.taskSummary ?? 'CLI session',
    patterns: safePatterns,
    maxUses: options?.maxUses ?? 10,
    ttlMs: options?.ttlMs ?? 0,
    usageCounts: new Array(safePatterns.length).fill(0) as number[],
  };
}
