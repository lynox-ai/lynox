import { randomUUID } from 'node:crypto';
import type { PreApprovalPattern, PreApprovalSet, PreApproveAuditLike } from '../types/index.js';
import { channels } from './observability.js';

/**
 * Convert a glob pattern to a RegExp.
 * - `**` matches anything (including `/`)
 * - `*` matches anything except `/`
 * - All other regex-special characters are escaped.
 * No backtracking risk — produced patterns are linear.
 */
export function globToRegex(glob: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      regex += '[^/]*';
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if ('.+(){}[]^$|\\'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
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

/** Representative critical commands — mirrors CRITICAL_BASH from permission-guard */
const CRITICAL_COMMAND_SAMPLES = [
  'rm -rf /',
  'sudo apt install x',
  'git push --force main',
  'mkfs.ext4 /dev/sda',
  'shutdown -h now',
  'reboot',
  'halt',
  'echo x > /dev/sda1',
  'printenv',
  'env',
  'cat /proc/1/environ',
  'declare -x',
  'export -p',
  'set',
];

/** Critical patterns as regexes — mirrors CRITICAL_BASH from permission-guard */
const CRITICAL_REGEXES: RegExp[] = [
  /\brm\s+-rf\s+\//i,
  /\bsudo\b/i,
  /\bgit\s+push\s+(?=.*--force)(?=.*main)/i,
  /\bmkfs\b/i,
  /\b(shutdown|reboot|halt)\b/i,
  />\s*\/dev\/(?!null\b)/i,
  /\bprintenv\b/i,
  /^\s*env\s*$|\benv\b\s*[|>]/im,
  /\/proc\/.*\/environ/i,
  /\b(declare\s+-x|export\s+-p)\b/i,
  /^\s*set\s*$|\bset\b\s*[|>]/im,
];

/**
 * Check if a pattern for a given tool would match any critical operation.
 * Used by `buildApprovalSet` to filter out dangerous patterns.
 */
export function isCriticalTool(tool: string, pattern: string): boolean {
  if (tool !== 'bash') return false;

  const regex = globToRegex(pattern);

  // Check against representative critical command samples
  for (const sample of CRITICAL_COMMAND_SAMPLES) {
    if (regex.test(sample)) return true;
  }

  // Also check if the glob text itself matches a critical regex
  for (const critRegex of CRITICAL_REGEXES) {
    if (critRegex.test(pattern)) return true;
  }

  return false;
}

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
