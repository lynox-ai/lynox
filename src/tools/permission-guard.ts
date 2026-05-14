import { realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join, relative, isAbsolute } from 'node:path';
import type { AutonomyLevel, PreApprovalSet, PreApproveAuditLike, ToolEntry } from '../types/index.js';
import { isWorkspaceActive } from '../core/workspace.js';
import { channels } from '../core/observability.js';
import { extractMatchString, globToRegex } from '../core/pre-approve.js';
import { detectInjectionAttempt } from '../core/data-boundary.js';

// ── isCriticalTool — moved from pre-approve.ts ─────────────

/** Representative critical commands — used by isCriticalTool to detect dangerous glob patterns */
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

/** Critical patterns as regexes — used by isCriticalTool */
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

// ── Permission guard ────────────────────────────────────────

/** Truly destructive — blocked even in autonomous mode */
export const CRITICAL_BASH: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+-rf\s+\//i,                label: 'rm -rf /' },
  { pattern: /\bsudo\b/i,                       label: 'elevated privileges' },
  { pattern: /\bgit\s+push\s+(?=.*--force)(?=.*main)/i, label: 'force push main' },
  { pattern: /\bgit\s+commit\b/i,                     label: 'git commit (requires explicit user request)' },
  { pattern: /\bgit\s+push\b/i,                       label: 'git push (requires explicit user request)' },
  { pattern: /\bgit\s+merge\b/i,                      label: 'git merge (modifies branch history)' },
  { pattern: /\bgit\s+rebase\b/i,                     label: 'git rebase (rewrites history)' },
  { pattern: /\bgit\s+cherry-pick\b/i,                label: 'git cherry-pick (modifies branch history)' },
  { pattern: /\bgit\s+revert\b/i,                     label: 'git revert (creates revert commit)' },
  // Publishing — irreversible, public-facing
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/i,        label: 'package publish (irreversible)' },
  { pattern: /\bdocker\s+push\b/i,                     label: 'docker push (publishes image)' },
  // Deploy platforms — production impact
  { pattern: /\b(wrangler|vercel|netlify|flyctl|railway|firebase|heroku)\b/i, label: 'deploy platform CLI' },
  { pattern: /\bdocker[\s-]compose\b/i,                label: 'docker compose (service lifecycle)' },
  // Infrastructure — production mutations
  { pattern: /\bkubectl\s+(apply|delete|drain|cordon|taint|scale|replace|patch|edit|rollout)\b/i, label: 'kubectl mutation (production impact)' },
  { pattern: /\b(terraform|tofu)\s+(apply|destroy)\b/i, label: 'infrastructure change (production impact)' },
  { pattern: /\b(ansible|ansible-playbook)\b/i,        label: 'ansible (modifies remote systems)' },
  { pattern: /\bhelm\s+(install|upgrade|delete|uninstall|rollback)\b/i, label: 'helm mutation (production impact)' },
  { pattern: /\bpulumi\s+(up|destroy|update)\b/i,      label: 'infrastructure change (production impact)' },
  // Service management
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable|mask)\b/i, label: 'service management' },
  { pattern: /\blaunchctl\b/i,                         label: 'service management (macOS)' },
  // Destructive HTTP via bash
  { pattern: /\bcurl\b.*-X\s*DELETE/i,                 label: 'destructive API call (HTTP DELETE)' },
  { pattern: /\bmkfs\b/i,                       label: 'format disk' },
  { pattern: /\b(shutdown|reboot|halt)\b/i,     label: 'system control' },
  { pattern: />\s*\/dev\/(?!null\b)/i,           label: 'write to device' },
  { pattern: /\bprintenv\b/i,                   label: 'print environment (secrets)' },
  { pattern: /^\s*env\s*$|\benv\b\s*[|>]/im,   label: 'dump environment (secrets)' },
  { pattern: /\/proc\/.*\/environ/i,             label: 'read process environment (secrets)' },
  { pattern: /\b(declare\s+-x|export\s+-p)\b/i, label: 'dump exported vars (secrets)' },
  { pattern: /^\s*set\s*$|\bset\b\s*[|>]/im,   label: 'dump all variables (secrets)' },
  { pattern: /\bchroot\b/i,                     label: 'chroot escape' },
  { pattern: /\bnsenter\b/i,                    label: 'namespace escape' },
  { pattern: /\bdocker\s+(exec|run)\b/i,        label: 'container execution' },
  { pattern: /\bmount\b/i,                      label: 'mount filesystem' },
  { pattern: /\becho\s+\$[A-Z_]*(?:API|KEY|SECRET|TOKEN|PASSWORD|PASS)\b/i, label: 'echo secret variable' },
  // SQL — irreversible data destruction
  { pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER))\b/i, label: 'SQL DROP (irreversible data destruction)' },
  { pattern: /\bTRUNCATE\b/i, label: 'SQL TRUNCATE (irreversible data destruction)' },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*;/i, label: 'SQL DELETE without WHERE (full table wipe)' },
  // Payment CLIs — financial mutations
  { pattern: /\bstripe\s+(charges|payouts|transfers|refunds|customers\s+delete|subscriptions\s+cancel)\b/i, label: 'payment mutation (financial impact)' },
  // Reverse shell / covert channel enablers — always block
  { pattern: /\b(ncat|socat)\b/i,                  label: 'reverse shell enabler (ncat/socat)' },
  { pattern: /\bopenssl\s+s_client\b/i,            label: 'covert channel (openssl s_client)' },
  // Bash built-in networking — bypasses http tool entirely
  { pattern: /\/dev\/(tcp|udp)\//i,                label: 'bash built-in networking (/dev/tcp)' },
  // Data exfiltration via file upload
  { pattern: /\bcurl\b.*(-T\s|--upload-file\s)/i,  label: 'file exfiltration (curl upload)' },
  // Local HTTP server for data staging/exfiltration
  { pattern: /\bpython[23]?\s+-m\s+(http\.server|SimpleHTTPServer)\b/i, label: 'local HTTP server (data exfiltration)' },
];

const DANGEROUS_BASH: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s/i,                     label: 'remove files' },
  { pattern: /\bsudo\b/i,                   label: 'elevated privileges' },
  { pattern: /\bkill\b/i,                   label: 'kill process' },
  { pattern: /\bchmod\b/i,                  label: 'change permissions' },
  { pattern: /\bchown\b/i,                  label: 'change ownership' },
  { pattern: /\bgit\s+push\s+.*--force/i,   label: 'force push' },
  { pattern: /\bgit\s+push\b/i,             label: 'git push (requires explicit user request)' },
  { pattern: /\bgit\s+reset\s+--hard/i,     label: 'hard reset' },
  { pattern: /\bgit\s+add\s+(-A|--all|\.)\s*(?:$|[|;&])/im, label: 'stage all files (review before committing)' },
  { pattern: /\bgit\s+commit\b/i,           label: 'git commit (requires explicit user request)' },
  { pattern: /\bgit\s+merge\b/i,            label: 'git merge' },
  { pattern: /\bgit\s+rebase\b/i,           label: 'git rebase' },
  { pattern: /\bgit\s+cherry-pick\b/i,      label: 'git cherry-pick' },
  { pattern: /\bgit\s+revert\b/i,           label: 'git revert' },
  { pattern: /\bgit\s+clean\b/i,            label: 'git clean (deletes untracked files)' },
  { pattern: /\bgit\s+checkout\s+(--\s|\.)/i, label: 'discard uncommitted changes' },
  { pattern: /\bgit\s+restore\b/i,          label: 'git restore (discard changes)' },
  { pattern: /\bgit\s+branch\s+(-[dD]|--delete)\b/i, label: 'delete branch' },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/i,      label: 'discard stashed changes' },
  { pattern: /\bdd\b/i,                     label: 'disk dump' },
  { pattern: /\bmkfs\b/i,                   label: 'format disk' },
  { pattern: /\b(shutdown|reboot|halt)\b/i, label: 'system control' },
  { pattern: />\s*\/dev\/(?!null\b)/i,      label: 'write to device' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash)/i,   label: 'pipe to shell' },
  { pattern: /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i, label: 'package publish' },
  { pattern: /\bdocker\s+push\b/i,          label: 'docker push' },
  { pattern: /\bdocker\s+(rm|rmi|prune)/i,  label: 'docker cleanup' },
  { pattern: /\bdocker[\s-]compose\b/i,     label: 'docker compose' },
  // Deploy platforms & infrastructure
  { pattern: /\b(wrangler|vercel|netlify|flyctl|railway|firebase|heroku)\b/i, label: 'deploy platform CLI' },
  { pattern: /\bkubectl\b/i,                label: 'kubectl (Kubernetes)' },
  { pattern: /\b(terraform|tofu)\b/i,       label: 'terraform/tofu (infrastructure)' },
  { pattern: /\bpulumi\b/i,                 label: 'pulumi (infrastructure)' },
  { pattern: /\b(ansible|ansible-playbook)\b/i, label: 'ansible (remote configuration)' },
  { pattern: /\bhelm\b/i,                   label: 'helm (Kubernetes packages)' },
  { pattern: /\baws\s/i,                    label: 'AWS CLI' },
  { pattern: /\bgcloud\s/i,                 label: 'Google Cloud CLI' },
  { pattern: /\baz\s/i,                     label: 'Azure CLI' },
  { pattern: /\bsystemctl\b/i,              label: 'service management' },
  { pattern: /\blaunchctl\b/i,              label: 'service management (macOS)' },
  // Remote access
  { pattern: /\bssh\s/i,                    label: 'remote shell access' },
  { pattern: /\bscp\s/i,                    label: 'remote file copy' },
  { pattern: /\brsync\s/i,                  label: 'remote sync' },
  { pattern: /\bsftp\s/i,                   label: 'remote file transfer' },
  // Broad process killing
  { pattern: /\bpkill\b/i,                  label: 'kill processes by name' },
  { pattern: /\bkillall\b/i,                label: 'kill all processes by name' },
  // Package execution/installation (arbitrary code)
  { pattern: /\bnpx\s/i,                    label: 'execute npm package (arbitrary code)' },
  { pattern: /\bpip3?\s+install\b/i,        label: 'install Python package' },
  { pattern: /\bgem\s+install\b/i,          label: 'install Ruby gem' },
  { pattern: /\bcargo\s+install\b/i,        label: 'install Rust crate' },
  { pattern: /\bgo\s+install\b/i,           label: 'install Go package' },
  { pattern: /\bprintenv\b/i,               label: 'print environment (secrets)' },
  { pattern: /^\s*env\s*$|\benv\b\s*[|>]/im, label: 'dump environment (secrets)' },
  { pattern: /\bwget\b.*\|\s*(sh|bash)/i,   label: 'pipe to shell' },
  { pattern: /\bnc\b\s+\S+\s+\d+/i,        label: 'outbound netcat connection' },
  { pattern: /\b(cat|less|more|head|tail|xxd|strings|od)\b.*\/proc\//i, label: 'read proc filesystem' },
  { pattern: /\b(cat|less|more|head|tail)\b.*\.env\b/i, label: 'read secrets file' },
  { pattern: /\bln\s+(-[a-zA-Z]*s|-[a-zA-Z]*\s+-[a-zA-Z]*s|--symbolic)\b/i, label: 'create symlink' },
  { pattern: /\bpython[23]?\s+-c\b/i,       label: 'python code execution' },
  { pattern: /\bnode\s+-e\b/i,              label: 'node code execution' },
  { pattern: /\bperl\s+-e\b/i,              label: 'perl code execution' },
  { pattern: /\bruby\s+-e\b/i,              label: 'ruby code execution' },
  { pattern: /\bcrontab\b/i,                label: 'modify cron jobs' },
  { pattern: /\biptables\b/i,               label: 'modify firewall rules' },
  { pattern: /\buseradd\b|\busermod\b|\bgroupadd\b/i, label: 'modify users/groups' },
  { pattern: /\bcat\b.*[^2]>\s*(?!\/tmp\/|\/dev\/null)/i, label: 'write file via bash (use write_file instead)' },
  { pattern: /\becho\b.*[^2]>\s*(?!\/tmp\/|\/dev\/null)/i, label: 'write file via bash (use write_file instead)' },
  { pattern: /\btee\b\s+(?!\/tmp\/)/i,      label: 'write file via bash (use write_file instead)' },
  { pattern: /\bsed\s+-i\b/i,               label: 'in-place file edit via bash (use write_file instead)' },
  // HTTP mutations via bash (bypasses http_request SSRF protection) — keep AFTER secrets patterns
  { pattern: /\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)/i, label: 'HTTP mutation via curl' },
  { pattern: /\bcurl\b.*(--data\b|-d\s|-F\s|--form\b)/i, label: 'HTTP data submission via curl' },
  { pattern: /\bwget\b.*(--post-data|--post-file|--method)/i, label: 'HTTP mutation via wget' },
  // Shell escape / arbitrary code execution
  { pattern: /\beval\b/i,                             label: 'eval (arbitrary code execution)' },
  { pattern: /base64.*\|.*(?:bash|sh|zsh)\b/i,        label: 'base64 decode piped to shell' },
  { pattern: /\bbash\s+-c\b/i,                        label: 'bash -c (explicit subshell)' },
  { pattern: /\becho\b.*\|.*\b(?:bash|sh|zsh)\b/i,    label: 'echo piped to shell' },
  // SQL — data destruction (also in CRITICAL_BASH for autonomous blocking)
  { pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER))\b/i, label: 'SQL DROP (irreversible data destruction)' },
  { pattern: /\bTRUNCATE\b/i, label: 'SQL TRUNCATE (irreversible data destruction)' },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*;/i, label: 'SQL DELETE without WHERE (full table wipe)' },
  // Database CLIs — data access and modification
  { pattern: /\b(psql|mysql|sqlite3|mongosh|mongo)\b/i, label: 'database CLI' },
  { pattern: /\b(pg_dump|mysqldump|mongodump|pg_restore|mysqlimport|mongoexport)\b/i, label: 'database dump/restore (data exfiltration risk)' },
  // Email sending — outbound communication
  { pattern: /\b(sendmail|msmtp|mutt|mailx?)\s/i, label: 'send email' },
  // Payment CLIs — financial mutations (also in CRITICAL_BASH for specific mutations)
  { pattern: /\bstripe\s+(charges|payouts|transfers|refunds|customers\s+delete|subscriptions\s+cancel)\b/i, label: 'payment mutation (financial impact)' },
  { pattern: /\b(stripe|paypal)\s/i, label: 'payment platform CLI' },
  // Webhook/notification URLs via curl
  { pattern: /\bcurl\b.*\b(hooks\.slack\.com|discord\.com\/api\/webhooks|webhook\.site)\b/i, label: 'webhook notification' },
  // Messaging CLIs
  { pattern: /\b(slack-cli|twilio)\s/i, label: 'messaging platform CLI' },
  // Encoding bypass — hex/octal decode piped to shell
  { pattern: /\bxxd\b.*-r.*\|\s*(?:bash|sh|zsh)\b/i, label: 'hex decode piped to shell' },
  { pattern: /\bprintf\b.*\\x[0-9a-f].*\|\s*(?:bash|sh|zsh)\b/i, label: 'printf hex escape piped to shell' },
  // File upload via curl form (file exfiltration)
  { pattern: /\bcurl\b.*-F\s*"?[^"]*@/i,           label: 'file upload via curl form (data exfiltration)' },
  // Reverse shell / covert channel (also in CRITICAL for autonomous blocking)
  { pattern: /\b(ncat|socat)\b/i,                  label: 'reverse shell enabler (ncat/socat)' },
  // Bash built-in networking
  { pattern: /\/dev\/(tcp|udp)\//i,                label: 'bash built-in networking (/dev/tcp)' },
  // Local HTTP server
  { pattern: /\bpython[23]?\s+-m\s+(http\.server|SimpleHTTPServer)\b/i, label: 'local HTTP server (data exfiltration)' },
];

const SENSITIVE_PATHS: RegExp[] = [
  /^\/etc\//, /^\/usr\//, /^\/sys\//, /^\/proc\//, /^\/root\//,
  /\.(env|pem|key|p12|pfx|jks)$/,
  /id_(rsa|ed25519|ecdsa|dsa)/, /authorized_keys/, /known_hosts/,
  /credentials/i, /\.netrc$/,
  /\.(ssh|gnupg|aws|config|docker|kube|npm)\//,
  /\.token$/, /\.secret$/,
];

function resolveRealPath(filePath: string): string {
  const resolved = resolve(filePath);
  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }
  const parent = dirname(resolved);
  if (existsSync(parent)) {
    return join(realpathSync(parent), basename(resolved));
  }
  return resolved;
}

function isPathWithin(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isDangerous(toolName: string, input: unknown, autonomy?: AutonomyLevel, preApproval?: PreApprovalSet, audit?: PreApproveAuditLike, entry?: ToolEntry): string | null {
  const warning = _detectDanger(toolName, input, autonomy, entry);
  if (!warning) return null;

  // Pre-approval can override non-critical dangers.
  // Critical ops (BLOCKED) are never auto-approved — they contain "[BLOCKED" marker.
  if (preApproval && !warning.includes('[BLOCKED')) {
    if (_matchesPreApproval(toolName, input, preApproval, audit)) {
      return null;
    }
  }

  // Publish guard block for observability / audit
  if (channels.guardBlock.hasSubscribers) {
    channels.guardBlock.publish({ toolName, warning, autonomy });
  }

  return warning;
}

/**
 * Pre-approval matching using shared utilities from pre-approve.ts.
 * Lighter than full `matchesPreApproval` — no observability channel publishes.
 */
function _matchesPreApproval(toolName: string, input: unknown, set: PreApprovalSet, audit?: PreApproveAuditLike): boolean {
  if (set.patterns.length === 0) return false;

  const matchStr = extractMatchString(toolName, input);
  if (!matchStr) return false;

  // TTL check
  if (set.ttlMs > 0) {
    const elapsed = Date.now() - new Date(set.approvedAt).getTime();
    if (elapsed > set.ttlMs) {
      for (let i = 0; i < set.patterns.length; i++) {
        if (set.patterns[i]!.tool === toolName) {
          audit?.recordCheck({
            setId: set.id, patternIdx: i, toolName, matchString: matchStr,
            pattern: set.patterns[i]!.pattern, decision: 'expired',
          });
          break;
        }
      }
      return false;
    }
  }

  for (let i = 0; i < set.patterns.length; i++) {
    const pat = set.patterns[i]!;
    if (pat.tool !== toolName) continue;
    if (set.maxUses > 0 && (set.usageCounts[i] ?? 0) >= set.maxUses) {
      audit?.recordCheck({
        setId: set.id, patternIdx: i, toolName, matchString: matchStr,
        pattern: pat.pattern, decision: 'exhausted',
      });
      continue;
    }

    const regex = globToRegex(pat.pattern);
    if (regex.test(matchStr)) {
      set.usageCounts[i] = (set.usageCounts[i] ?? 0) + 1;
      audit?.recordCheck({
        setId: set.id, patternIdx: i, toolName, matchString: matchStr,
        pattern: pat.pattern, decision: 'approved',
      });
      return true;
    }
  }

  return false;
}

/** Max command length for regex safety checks (prevents ReDoS on adversarial inputs). */
const MAX_CMD_CHECK_LEN = 10_000;

/**
 * Normalize a shell command to defeat encoding bypass attempts.
 * Strips ANSI escapes, decodes common shell encoding tricks, normalizes whitespace.
 */
export function normalizeCommand(cmd: string): string {
  let normalized = cmd;
  // Strip ANSI escape sequences
  normalized = normalized.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // Strip null bytes and control chars (keep \n, \t)
  normalized = normalized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  // Decode $'\xHH' bash ANSI-C quoting (e.g., $'\x72\x6d' → rm)
  normalized = normalized.replace(/\$'((?:[^'\\]|\\x[0-9a-fA-F]{2}|\\[0-7]{1,3}|\\.)*)'/g, (_match, inner: string) => {
    return inner
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\([0-7]{1,3})/g, (_m: string, oct: string) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\').replace(/\\'/g, "'");
  });
  // Collapse multiple spaces/tabs into single space (preserve newlines for chaining detection)
  normalized = normalized.replace(/[ \t]+/g, ' ');
  return normalized;
}

/**
 * Split a compound command into individual segments for independent checking.
 * Splits on ;, &&, ||, and newlines. Does NOT split on | (pipes are legitimate).
 * Handles quoted strings to avoid splitting inside them.
 */
export function splitCommandSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i]!;

    // Handle escape inside double quotes
    if (ch === '\\' && inDouble && i + 1 < cmd.length) {
      current += ch + cmd[i + 1]!;
      i += 2;
      continue;
    }

    // Toggle quote state
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

    // Only split when NOT inside quotes
    if (!inSingle && !inDouble) {
      // Split on ; or newline
      if (ch === ';' || ch === '\n') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      // Split on && or ||
      if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
    }

    current += ch;
    i++;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function _checkPatterns(segments: string[], patterns: Array<{ pattern: RegExp; label: string }>): { label: string } | null {
  for (const segment of segments) {
    for (const { pattern, label } of patterns) {
      if (pattern.test(segment)) {
        return { label };
      }
    }
  }
  return null;
}

function _detectDanger(toolName: string, input: unknown, autonomy?: AutonomyLevel, entry?: ToolEntry): string | null {
  if (toolName === 'bash' && input && typeof input === 'object' && 'command' in input) {
    const rawCmd = String((input as { command: unknown }).command);
    // Truncate for regex matching to prevent ReDoS; the actual command still executes in full.
    // Also check the last 2K chars of long commands to catch payloads appended at the end.
    const truncated = rawCmd.length > MAX_CMD_CHECK_LEN
      ? rawCmd.slice(0, MAX_CMD_CHECK_LEN) + rawCmd.slice(-2000)
      : rawCmd;
    // Normalize to defeat encoding bypasses, then split into segments for per-segment checking
    const normalized = normalizeCommand(truncated);
    const segments = splitCommandSegments(normalized);
    // Also check the full normalized string (catches cross-segment patterns like pipes)
    const allSegments = [normalized, ...segments];

    // Short preview for user display (first line, max 80 chars)
    const firstLine = rawCmd.split('\n')[0]!;
    const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;

    // In autonomous mode, only block truly critical operations
    if (autonomy === 'autonomous') {
      const hit = _checkPatterns(allSegments, CRITICAL_BASH);
      if (hit) {
        return `⚠ ${toolName}: ${hit.label} — "${preview}" [BLOCKED — this action needs to be run manually for safety]`;
      }
      return null;
    }

    const hit = _checkPatterns(allSegments, DANGEROUS_BASH);
    if (hit) {
      return `⚠ ${toolName}: ${hit.label} — "${preview}"`;
    }
  }

  if (toolName === 'read_file' && input && typeof input === 'object' && 'path' in input) {
    const rawPath = resolve(String((input as { path: unknown }).path));
    const filePath = resolveRealPath(rawPath);
    for (const pattern of SENSITIVE_PATHS) {
      // Check both raw (pre-symlink) and resolved path — /etc/ → /private/etc/ on macOS
      if (pattern.test(rawPath) || pattern.test(filePath)) {
        if (autonomy === 'autonomous') {
          return `⚠ ${toolName}: read sensitive path — "${filePath}" [BLOCKED — this path contains system or security files]`;
        }
        return `⚠ ${toolName}: read sensitive path — "${filePath}" — this path contains system or security files`;
      }
    }
  }

  if (toolName === 'write_file' && input && typeof input === 'object' && 'path' in input) {
    const filePath = resolveRealPath(String((input as { path: unknown }).path));
    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.test(filePath)) {
        if (autonomy === 'autonomous') {
          return `⚠ ${toolName}: write to sensitive path — "${filePath}" [BLOCKED — this path contains system or security files]`;
        }
        return `⚠ ${toolName}: write to sensitive path — "${filePath}" — this path contains system or security files`;
      }
    }
    // Overwriting an existing file with empty content destroys it (rm bypass)
    const content = (input as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim() === '') {
      if (autonomy === 'autonomous') {
        return `⚠ ${toolName}: overwrite with empty content — "${filePath}" [BLOCKED]`;
      }
      return `⚠ ${toolName}: overwrite file with empty content — "${filePath}"`;
    }
    // In autonomous mode without workspace, restrict writes to project directory
    if (autonomy === 'autonomous' && !isWorkspaceActive()) {
      const cwd = resolveRealPath(process.cwd());
      if (!isPathWithin(filePath, cwd)) {
        return `⚠ ${toolName}: write outside project directory — "${filePath}" [BLOCKED — I can only write files within the current project]`;
      }
    }
  }

  if (toolName === 'batch_files' && input && typeof input === 'object') {
    const obj = input as { directory?: unknown; operation?: unknown; destination?: unknown };
    const dirRaw = typeof obj.directory === 'string' ? resolve(obj.directory) : '';
    const dirPath = dirRaw ? resolveRealPath(dirRaw) : '';

    if (dirPath) {
      for (const pattern of SENSITIVE_PATHS) {
        if (pattern.test(dirRaw) || pattern.test(dirPath)) {
          if (autonomy === 'autonomous') {
            return `⚠ ${toolName}: operate in sensitive directory — "${dirPath}" [BLOCKED]`;
          }
          return `⚠ ${toolName}: operate in sensitive directory — "${dirPath}"`;
        }
      }
    }

    if (obj.operation === 'move' && typeof obj.destination === 'string') {
      const destRaw = resolve(obj.destination);
      const destPath = resolveRealPath(destRaw);
      for (const pattern of SENSITIVE_PATHS) {
        if (pattern.test(destRaw) || pattern.test(destPath)) {
          if (autonomy === 'autonomous') {
            return `⚠ ${toolName}: move into sensitive path — "${destPath}" [BLOCKED]`;
          }
          return `⚠ ${toolName}: move files into sensitive path — "${destPath}"`;
        }
      }

      const cwd = resolveRealPath(process.cwd());
      if (!isPathWithin(destPath, cwd)) {
        if (autonomy === 'autonomous') {
          return `⚠ ${toolName}: move destination outside project — "${destPath}" [BLOCKED]`;
        }
        return `⚠ ${toolName}: move destination outside project — "${destPath}"`;
      }
    }
  }

  // Mail (provider-agnostic IMAP/SMTP) write tools — block in autonomous mode.
  // In interactive mode, the ToolEntry.requiresConfirmation flag causes the
  // agent to skip this generic warning (the tool shows its own email preview).
  const MAIL_WRITE_TOOLS = new Set(['mail_send', 'mail_reply']);
  if (MAIL_WRITE_TOOLS.has(toolName)) {
    if (autonomy === 'autonomous') {
      return `⚠ ${toolName} [BLOCKED — sending mail needs your OK]`;
    }
    return `⚠ ${toolName} — sends external mail`;
  }

  // Declarative destructive-tool gate. Each tool registers
  // `ToolEntry.destructive` next to its schema; this block reads that
  // metadata so writes/deletes can be added at the tool's source-of-truth.
  //
  // Covers structured-data destructive tools (data_store_drop, _delete,
  // artifact_delete, memory_delete — bash equivalents like DROP TABLE /
  // rm -rf are blocked via CRITICAL_BASH; without this gate a sub-agent
  // could destroy the same data through the structured tool) and Google
  // Workspace write actions.
  if (entry?.destructive) {
    const { mode, check } = entry.destructive;
    const detail = check ? check(input) : '';
    if (detail !== null) {
      const suffix = detail ? `: ${detail}` : '';
      if (autonomy === 'autonomous') {
        const blockReason = mode === 'data'
          ? '[BLOCKED — destructive data operation needs your OK]'
          : '[BLOCKED — I need your OK before doing this]';
        return `⚠ ${toolName}${suffix} ${blockReason}`;
      }
      const label = mode === 'data' ? 'destroys stored data' : 'modifies external data';
      return `⚠ ${toolName}${suffix} — ${label}`;
    }
  }

  // http_request write methods — block DELETE in autonomous mode
  if (toolName === 'http_request' && input && typeof input === 'object' && 'method' in input) {
    const method = String((input as { method: unknown }).method).toUpperCase();
    if (method === 'DELETE') {
      if (autonomy === 'autonomous') {
        return `⚠ ${toolName}: HTTP DELETE [BLOCKED — destructive operation]`;
      }
    }
    // Block write methods in autonomous mode — can send emails, create invoices, modify records.
    // No [BLOCKED] marker so operators can pre-approve specific endpoints.
    if (['POST', 'PUT', 'PATCH'].includes(method) && autonomy === 'autonomous') {
      return `⚠ ${toolName}: HTTP ${method} — write operation (pre-approve to allow)`;
    }
  }

  // spawn_agent: scan task + context for injection patterns in autonomous mode
  if (toolName === 'spawn_agent' && autonomy === 'autonomous' && input && typeof input === 'object' && 'agents' in input) {
    const agentSpecs = (input as { agents?: Array<{ task?: string; context?: string }> }).agents;
    for (const spec of agentSpecs ?? []) {
      const combined = [spec.task, spec.context].filter(Boolean).join('\n');
      const injection = detectInjectionAttempt(combined);
      if (injection.detected) {
        return `⚠ ${toolName}: spawn task contains suspicious patterns (${injection.patterns.join(', ')}). Review needed.`;
      }
    }
  }

  return null;
}
