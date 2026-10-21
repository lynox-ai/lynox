import { realpathSync, existsSync } from 'node:fs';
import { effectiveWriteMethod, isGraphqlEndpoint } from '../core/outbound-write.js';
import { DATA_DIR_INVENTORY } from '../core/data-dir-inventory.js';
import { resolve, dirname, basename, join } from 'node:path';
import type { AutonomyLevel, ProviderConfigSnapshot, ToolEntry, WarningPayload } from '../types/index.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import { isWorkspaceActive, getWorkspaceCwd, READ_ONLY_ROOTS, isPathWithin } from '../core/workspace.js';
import { proveBashCommand, BASH_OBSERVE_EVENT } from './bash-allowlist.js';
import { channels } from '../core/observability.js';
import { globToRegex } from '../core/glob.js';
import { detectInjectionAttempt } from '../core/data-boundary.js';
import { isMailProviderTarget } from '../core/bulk-mail-targets.js';
import { PROMPT_TEXT_BRAND, type PromptText } from '../types/agent.js';
import { promptSegments, promptValue, pv, singleLine } from '../core/prompt-value.js';

// lynox-internal secret files. Specific names, NOT the whole `~/.lynox/` dir — the agent may
// still read the entries that are not marked secret, `apis/` among them. Prefix is fuzzy
// (matches macOS /Users/foo AND Linux /home/foo paths). Shared between the file-tool path guard
// and both bash scan lists so they cannot drift apart. H-003 / L1-011.
//
// Two halves, joined:
//  - The names the list has always held, with the matching they have always had (a prefix, `.env`
//    up to a word boundary, `backups/` with its slash). Kept verbatim, so the rule never matches
//    less than it did: a hand-made copy such as `secrets.json-backup` or `.env-old` stays covered.
//    `runs` and `migration-export` match nothing a current writer creates — removing an entry is
//    a different decision from adding one.
//  - Every entry of the data-dir inventory (`core/data-dir-inventory.ts`) marked `secret: true`,
//    the table every store under this directory has to be declared in. The hand-kept list missed
//    the push key `vapid-keys.json`; a name declared there now reaches this rule by the flag. It
//    matches as itself, followed by anything but a word character or a hyphen: `backups` without
//    a slash, `.env.local`, but not the arming marker `wire-sink-raw-on`.
//
// `backups` covers the default location only; `backup_dir` can point elsewhere, and a relocated
// backup directory is not covered by this list. Managed-pool instances receive their provider
// keys as container environment; a hosted BYOK instance can still save a key into its
// `config.json`, which this list covers. Path matching stays a bar, not a boundary (see below).
// The shell reads `.lynox//x` and `.lynox/./x` as `.lynox/x`, so the name is matched after any
// run of empty and `.` segments, as `LYNOX_DB_FILES` already is.
const HAND_KEPT_SECRET_NAMES = String.raw`vault|agent-memory|history|runs|migration-export|http-secret|\.access-token|\.env\b|secrets\.json|backups\/`;
const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LYNOX_SECRET_FILES = new RegExp(
  `\\.lynox\\/+(?:\\.\\/+)*(?:${[
    HAND_KEPT_SECRET_NAMES,
    ...DATA_DIR_INVENTORY.filter((entry) => entry.secret).map((entry) => `${escapeForRegex(entry.name)}(?![\\w-])`),
  ].join('|')})`,
  'i',
);

// Every SQLite store the engine keeps in the lynox dir, by location rather than by
// name. The name list above protects the stores that hold secrets; it was never a
// list of the engine's databases, and it could not be one — new stores keep
// appearing (engine, datastore, mail-state, push-subscriptions, ads-optimizer were
// all outside it). A shell write to any of them bypasses the engine's own
// invariants, so a database file anywhere under the lynox dir is covered, whatever
// it is called and whichever command spells out its path (a command that reaches it
// without spelling the path — after a `cd`, or through a script — is not covered;
// path matching is a bar, not a boundary). `workspace/` stays out: the agent's
// own files live there. The match ends at the extension, so the `-wal`/`-shm`/
// `-journal` siblings are covered too; `.db.md` and the like are not.
//
// A rule that reads the path after `.lynox/` reads it only up to the next `.lynox/` that would
// start a match of its own (`LYNOX_DIR_AT`, the same text as the rule's start): that one finds
// whatever lies beyond it. So each character is read from one start, not from every `.lynox/`
// before it, and a command that repeats the prefix stays linear in its length. The rules match
// what they matched before; only the start that reports the match can be a later one.
// The start takes the whole run of slashes (`(?!\/…)`): read as a lookahead, a start that took
// only some of them would hold at `.lynox//workspace/`, where no match can start, and the read
// from an earlier `.lynox/` would stop there without anyone reporting it.
const LYNOX_DIR_AT = String.raw`\.lynox\/+(?!\/|workspace\/)`;
const LYNOX_PATH_CHAR = String.raw`(?:(?!${LYNOX_DIR_AT})[^\s'"\`;|&<>/])`;
const LYNOX_DB_FILES = new RegExp(
  String.raw`${LYNOX_DIR_AT}(?:${LYNOX_PATH_CHAR}+\/+)*${LYNOX_PATH_CHAR}*\.(?:db|db3|sqlite3?)(?![\w.])`,
  'i',
);

const WORKSPACE_IN_LYNOX = '.lynox/workspace/';
const UP_A_DIR = '/../';

/**
 * Whether some brace expansion of a word reads `.lynox/workspace/`, then anything, then `/../`,
 * read in one pass without expanding: the positions read so far are carried through each group,
 * every alternative from the positions at its `{`, and the group ends with their union. A group
 * the word does not close is read as written, as the shell does; a word that opens one in the
 * workspace and holds a dot-dot counts, since what the window cut off is not read.
 */
function braceWordLeavesWorkspace(word: string): boolean {
  const lower = word.toLowerCase();
  const before = WORKSPACE_IN_LYNOX.length;
  const done = before + UP_A_DIR.length;
  // Bit i < before: `i` characters of `.lynox/workspace/` read. Bit before + j: the prefix read,
  // and `j` characters of `/../` after it; bit `before` itself stays set once reached.
  let states = 1;
  const groups: Array<{ start: number; ends: number }> = [];
  for (const c of lower) {
    if (c === '{') {
      groups.push({ start: states, ends: 0 });
      continue;
    }
    if (c === ',' && groups.length > 0) {
      const group = groups[groups.length - 1]!;
      group.ends |= states;
      states = group.start;
      continue;
    }
    if (c === '}' && groups.length > 0) {
      states |= groups.pop()!.ends;
      continue;
    }
    let next = 1 | (states & (1 << before));
    for (let set = states; set !== 0; set &= set - 1) {
      const bit = 31 - Math.clz32(set & -set);
      const expected = bit < before ? WORKSPACE_IN_LYNOX[bit] : UP_A_DIR[bit - before];
      if (expected === c) next |= 1 << (bit + 1);
    }
    // The prefix's own last `/` is also the first of `/../`: `workspace/{..,x}/`.
    if (!((states >> before) & 1) && (next >> before) & 1 && UP_A_DIR[0] === c) next |= 1 << (before + 1);
    states = next;
    if ((states >> done) & 1) return true;
  }
  return groups.length > 0 && lower.includes('..');
}

/**
 * Whether a word of the segment leaves the workspace by a dot-dot only its braces form. Slashes
 * are read one for a run, as the path is. A word with fewer than two dots after the workspace
 * forms no dot-dot there and is not read. Exported for tests.
 */
export function _bracesLeaveWorkspace(segment: string): boolean {
  return segment.split(/\s+/).some((word) => {
    if (!word.includes('{')) return false;
    const path = word.toLowerCase().replace(/\/+/g, '/');
    const at = path.indexOf(WORKSPACE_IN_LYNOX);
    if (at < 0) return false;
    const after = path.indexOf('.', at + WORKSPACE_IN_LYNOX.length);
    return after >= 0 && path.indexOf('.', after + 1) >= 0 && braceWordLeavesWorkspace(path);
  });
}

// Bash spellings of the same read that do not name the full path: a glob into the
// lynox dir (`cat ~/.lynox/http-*`) and the bare filename after a cd
// (`cd ~/.lynox && cat http-secret`). Path-based matching only raises the bar —
// co-residency is the accepted root. The bare-name pattern covers only
// `http-secret` (the one plaintext secret; the DB names are too generic to flag
// bare without false positives), and `~/.lynox/workspace/` — the agent's default
// working area — stays globbable.
const LYNOX_SECRET_BASH: Array<{ pattern: RegExp; label: string; matches?: (segment: string) => boolean }> = [
  { pattern: LYNOX_SECRET_FILES,   label: 'access lynox secret store (secrets)' },
  { pattern: LYNOX_DB_FILES,       label: 'access lynox engine database (use the built-in tools instead)' },
  { pattern: /\bhttp-secret\b/i,   label: 'access lynox secret store (secrets)' },
  // Bare-name twin, so the `cd` spelling is covered like `http-secret`'s. Anchored
  // on the leading DOT on purpose: `access-token` unanchored is generic OAuth
  // vocabulary and would fire on ordinary `api_setup` work. The cost of a bare rule
  // is that it has no directory to key on, so it matches that exact filename
  // anywhere — the same trade the entry above already makes, more broadly.
  //
  // `.env` deliberately gets NO bare-name twin: a bare rule here lands in
  // CRITICAL_BASH, which would hard-block reading any project's own env file.
  { pattern: /\.access-token\b/i, label: 'access lynox secret store (secrets)' },
  { pattern: /\.lynox\/(?!workspace\/)(?:(?!\.lynox\/(?!workspace\/))[^\s*?[])*[*?[]/i, label: 'glob into lynox data dir (secrets)' },
  // The shell can finish a database extension the rule above keys on:
  // `engine.d{b,}`, `engine.d${X}b` never spell `.db`. An expansion that follows
  // the start of a database extension (`.d`, `.s`, `.sq`, …) is flagged as if it
  // were one. Only then: an expansion right after a bare dot (`app.$(date).log`,
  // `config.${PROFILE}.json`) is ordinary and stays allowed. A text rule cannot
  // evaluate expansion, so a name assembled any other way — an expansion before
  // the dot or over the whole name (`engine${EXT}`, `.{db,x}`, `${F}`), a brace
  // opened before the dot — is not covered.
  { pattern: new RegExp(String.raw`${LYNOX_DIR_AT}(?:${LYNOX_PATH_CHAR}+\/+)*${LYNOX_PATH_CHAR}*\.(?:d|db|s|sq|sql|sqli|sqlit|sqlite)[{$\`]`, 'i'), label: 'access lynox engine database (use the built-in tools instead)' },
  // The workspace carve-out above is lexical, so `~/.lynox/workspace/../vault.db`
  // would launder a secret path through it — any dot-dot inside a .lynox path is
  // flagged instead (the model has no reason to spell workspace paths that way).
  { pattern: /\.lynox\/(?:(?!\.lynox\/)\S)*\.\.\//i, label: 'path traversal in lynox data dir (secrets)' },
  // The same dot-dot, formed by a brace expansion out of the workspace
  // (`~/.lynox/workspace/{..,x}/engine.db`), which never spells `../` as written.
  { pattern: /\{/, label: 'path traversal in lynox data dir (secrets)', matches: _bracesLeaveWorkspace },
];

// batch_files must not operate on the lynox dir outside the workspace subtree — a
// rename/move of a secret file would strip it of the path guards above (checked
// against the raw directory, which names the dir without a filename, so
// LYNOX_SECRET_FILES cannot match it). `~/.lynox/workspace/` is the agent's
// default working area and stays available.
const LYNOX_DIR = /\.lynox\/?$|\.lynox\/(?!workspace(\/|$))/i;

// ── Permission guard ────────────────────────────────────────

/** Truly destructive — blocked even in autonomous mode */
export const CRITICAL_BASH: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+-rf\s+\//i,                label: 'rm -rf /' },
  { pattern: /\bsudo\b/i,                       label: 'elevated privileges' },
  { pattern: /\bgit\s+push\s+(?=.*--force)(?=.*main)/i, label: 'force push main' },
  { pattern: /\bgit\s+commit\b(?!-graph)/i,           label: 'git commit (requires explicit user request)' },
  { pattern: /\bgit\s+push\b/i,                       label: 'git push (requires explicit user request)' },
  { pattern: /\bgit\s+merge\b(?!-(?:base|tree)\b)/i,  label: 'git merge (modifies branch history)' },
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
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b.*-X\s*DELETE/im,                 label: 'destructive API call (HTTP DELETE)' },
  { pattern: /\bmkfs\b/i,                       label: 'format disk' },
  { pattern: /\b(shutdown|reboot|halt)\b/i,     label: 'system control' },
  { pattern: />\s*\/dev\/(?!null\b)/i,           label: 'write to device' },
  { pattern: /\bprintenv\b/i,                   label: 'print environment (secrets)' },
  // `^` under `m` starts at every line; a leading `\s*` would then run across every blank line
  // below it, the square of the run. Only spaces within the line: a line break in the run before
  // `env` is itself a line start `^` matches after, so the rules match what they matched before.
  { pattern: /^[^\S\n\r\u2028\u2029]*env\s*$|\benv\b\s*[|>]/im,   label: 'dump environment (secrets)' },
  // Read from the line's first /proc/, in linear time.
  { pattern: /^(?:(?!\/proc\/).)*\/proc\/.*\/environ/im, label: 'read process environment (secrets)' },
  ...LYNOX_SECRET_BASH,
  { pattern: /\b(declare\s+-x|export\s+-p)\b/i, label: 'dump exported vars (secrets)' },
  { pattern: /^[^\S\n\r\u2028\u2029]*set\s*$|\bset\b\s*[|>]/im,   label: 'dump all variables (secrets)' },
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
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b.*(-T\s|--upload-file\s)/im,  label: 'file exfiltration (curl upload)' },
  // Local HTTP server for data staging/exfiltration
  { pattern: /\bpython[23]?\s+-m\s+(http\.server|SimpleHTTPServer)\b/i, label: 'local HTTP server (data exfiltration)' },
];

/**
 * What a bash call may not do without being asked, in EVERY mode: send data out, run code it
 * carries inline, or write into the lynox data dir. In autonomous mode a hit here is a question
 * (the warning carries no BLOCKED marker), like the DANGEROUS_BASH rules marked `ask`, and the
 * same consent `http_request` asks for a write. Without this, an unattended run could send
 * with a one-line interpreter what `http_request` would have asked about.
 *
 * A list of commands, so it is never complete: a script written first and run afterwards, or a
 * binary with its own network access, reads as harmless text. Within its classes it errs toward
 * asking: a later command's `-d`, or a copy OUT of the lynox dir, is asked about too.
 */
/**
 * A path into the lynox data dir outside `workspace/` (`workspace/..` is outside). The rules that
 * use it match names case-insensitively, as a case-insensitive file system (a macOS self-host)
 * runs `NODE` and opens `~/.LYNOX`; only curl's short options stay case-sensitive.
 */
const LYNOX_OUTSIDE_WORKSPACE = String.raw`(?<![\w.-])\.lynox(?:\/+(?!workspace(?:$|[\s'"]|\/(?!\.\.)))|(?=$|[\s'"]))`;
/** The interpreters that run code they are handed. */
const INTERPRETER = String.raw`(?:sh|bash|dash|zsh|ksh|node|python[23]?|perl|ruby|php|bun|deno)`;
/** Exported for tests. */
export const SENDS_OR_KEEPS_BASH: Array<{ pattern: RegExp; label: string }> = [
  // Code passed inline to an interpreter, or fed to one on stdin.
  { pattern: /\bnode\s+(?:-[a-zA-Z]*[ep]\b|--eval\b|--print\b|-(?=\s|$))/i, label: 'node code execution' },
  { pattern: /\bpython(?:[23](?:\.\d+)?)?\s+(?:-[a-zA-Z]*c\b|-(?=\s|$))/i, label: 'python code execution' },
  { pattern: /\bperl\s+-[a-zA-Z]*e\b/i, label: 'perl code execution' },
  { pattern: /\bruby\s+-[a-zA-Z]*e\b/i, label: 'ruby code execution' },
  { pattern: /\bphp\s+-r\b/i, label: 'php code execution' },
  { pattern: /\bdeno\s+eval\b/i, label: 'deno code execution' },
  { pattern: /\bbun\s+(?:-[a-zA-Z]*[ep]\b|--eval\b|--print\b)/i, label: 'bun code execution' },
  { pattern: /\b(?:sh|bash|dash|zsh|ksh)\s+-[a-zA-Z]*c\b/i, label: 'shell -c (inline script)' },
  { pattern: new RegExp(String.raw`\|\s*(?:[\w.~-]*\/)*(?:env\s+(?:\w+=\S*\s+)*)?${INTERPRETER}\b`, 'i'), label: 'input piped to an interpreter' },
  { pattern: new RegExp(String.raw`\b${INTERPRETER}\b[^|;&\n]{0,256}<`, 'i'), label: 'input redirected to an interpreter' },
  // Data sent out over HTTP, or a request with any method but GET, HEAD or OPTIONS: a method set
  // with `-X` (bundled or glued) or `--request` (spaced or with `=`). Only a literal, uppercase
  // GET, HEAD or OPTIONS is free, so a quoted or lowercase `get` is asked about too. A `-X DELETE`
  // is blocked in autonomous mode by the rule above; this rule asks about the spellings it does
  // not reach. A config file (`-K`, `--config`) can set the method or the data, so it is asked
  // about too. Short options are case-sensitive, like curl's own: `-X` sets the method, `-x` a
  // proxy; `-d`, `-F` and `-T` send, `-D` and `-f` do not. A short option may be bundled or carry
  // its value glued.
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\b[cC][uU][rR][lL]\b).)*\b[cC][uU][rR][lL]\b.*(?:\s-[a-zA-Z]*X\s*|\s--request(?:\s+|=))(?!(?:GET|HEAD|OPTIONS)\b)\S/m, label: 'HTTP mutation via curl' },
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\b[cC][uU][rR][lL]\b).)*\b[cC][uU][rR][lL]\b.*\s(?:--(?:expand-)?data\b|--form\b|--upload-file\b|--json\b|--config\b|-[a-zA-Z]*[dFTK])/m, label: 'HTTP data submission via curl' },
  // Read from the line's first wget, in linear time.
  { pattern: /^(?:(?!\bwget\b).)*\bwget\b.*\s--(?:post-[df]|body-[df]|meth)/im, label: 'HTTP mutation via wget' },
  // Writes into the lynox data dir outside the workspace: profiles there are read back as
  // configuration. A command that names a writing verb and such a path is asked about, in
  // either order: read from its start, so the rule costs one pass, not one per verb.
  // The path before `.lynox` in a redirection holds no `>`, for the same reason.
  { pattern: new RegExp(String.raw`>\|?\s*[^\s<>|;&]*${LYNOX_OUTSIDE_WORKSPACE}`, 'i'), label: 'write into the lynox data dir' },
  { pattern: new RegExp(String.raw`^(?=[^\n]*?\b(?:cp|mv|install|ln|rsync|dd|tee|touch|mkdir|tar|unzip|sed|curl|wget|git|rm|rmdir|unlink|patch)\b)(?=[^\n]*?${LYNOX_OUTSIDE_WORKSPACE})`, 'i'), label: 'write into the lynox data dir' },
  { pattern: new RegExp(String.raw`\b(?:cd|pushd)\s+['"]?[^\s;&|]*${LYNOX_OUTSIDE_WORKSPACE}`, 'i'), label: 'write into the lynox data dir' },
];

/**
 * What a rule from DANGEROUS_BASH does in an unattended (autonomous) run. In a chat every rule
 * here is asked about; this field decides only what happens when no one is watching, and it is
 * required, so a new rule cannot be added without that decision.
 *
 * Most rules match a program's name wherever it stands in the command, so a path or a search term
 * that spells it (`cat terraform/main.tf`) matches too. Under `block` that is a block; under
 * `ask`, a run with no one to ask refuses it unless a contract lifts it.
 *
 * - `block`: every command the rule matches also matches CRITICAL_BASH, so it is `[BLOCKED]`.
 *   A block cannot be lifted by a capability contract. Where the run has a
 *   question channel, it is put to a person; without one it is refused.
 * - `ask`: the command talks to another system (a remote host, a cloud account, a cluster, a
 *   database, mail, a payment or messaging service), runs code fetched or decoded on the spot,
 *   reads other processes, or changes the host's services, schedule, firewall or users. A
 *   question, the same consent SENDS_OR_KEEPS_BASH asks for; a contract can
 *   lift it. The docker cleanup rule is here because the Docker daemon belongs to the host, not
 *   to the instance. A database CLI is asked about on a local file too: the rule cannot tell a
 *   file from a server.
 * - `sends`: SENDS_OR_KEEPS_BASH decides. It matches every command of this rule that sends, in
 *   its own, stricter spelling, so the rule here would add nothing an unattended run should be
 *   asked about.
 * - `allow`: the command acts on the instance itself: its files, processes and permissions, or a
 *   read whose output stays in the conversation. That is not a containment. It holds outside the
 *   workspace too, bash reaches paths that `write_file` refuses, and the rule judges the command,
 *   not what the file it writes is for. The limit is the instance's own container. These run
 *   unattended because asking would refuse every saved workflow that cleans up after itself: a
 *   headless run has no one to ask.
 */
type DangerousBashRule = {
  pattern: RegExp;
  label: string;
  unattended: 'block' | 'ask' | 'sends' | 'allow';
  /**
   * Where a regex would be slower than linear, the rule's test is this predicate, and `pattern`
   * is only a linear filter in front of it: true wherever the predicate is (so the union of a list
   * never skips a segment the rule matches), and the rule matches where both hold.
   */
  matches?: (segment: string) => boolean;
};

const isLineTerminator = (c: number): boolean => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const isAsciiWordChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const WHITESPACE_CHAR = /\s/;
const lowerAscii = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);

/**
 * Whether `segment` uploads a file with a curl form: true exactly where
 * `/\bcurl\b.*-F\s*"?[^"]*@/i` matches, read in one pass. A line holds a whole-word `curl`, then
 * on the same line a `-F` (or `-f`); after it, past any whitespace and at most one `"`, an `@`
 * comes before the next `"`, on that line or a later one. Each `-F` of the line is tried, not only
 * the first: `curl -F "a" -F @b` uploads through the second. Exported for tests.
 */
export function curlFormUploadsFile(segment: string): boolean {
  const n = segment.length;
  // From each index: where the next `@` and the next `"` are (n: none), and the first index that
  // is not whitespace. Built once from the right, so each -F is answered in constant time.
  const nextAt = new Int32Array(n + 1);
  const nextQuote = new Int32Array(n + 1);
  const nextNonSpace = new Int32Array(n + 1);
  nextAt[n] = n; nextQuote[n] = n; nextNonSpace[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const ch = segment[i]!;
    nextAt[i] = ch === '@' ? i : nextAt[i + 1]!;
    nextQuote[i] = ch === '"' ? i : nextQuote[i + 1]!;
    nextNonSpace[i] = WHITESPACE_CHAR.test(ch) ? nextNonSpace[i + 1]! : i;
  }
  const atBeforeQuote = (from: number): boolean => nextAt[from]! < n && nextAt[from]! < nextQuote[from]!;
  let curlOnLine = false;
  for (let i = 0; i < n; i++) {
    const c = segment.charCodeAt(i);
    if (isLineTerminator(c)) { curlOnLine = false; continue; }
    if (!curlOnLine && lowerAscii(c) === 0x63 && i + 4 <= n
        && lowerAscii(segment.charCodeAt(i + 1)) === 0x75 && lowerAscii(segment.charCodeAt(i + 2)) === 0x72
        && lowerAscii(segment.charCodeAt(i + 3)) === 0x6c
        && (i === 0 || !isAsciiWordChar(segment.charCodeAt(i - 1)))
        && (i + 4 === n || !isAsciiWordChar(segment.charCodeAt(i + 4)))) {
      curlOnLine = true;
      i += 3;
      continue;
    }
    if (curlOnLine && c === 0x2d && i + 1 < n && lowerAscii(segment.charCodeAt(i + 1)) === 0x66) {
      const afterF = i + 2;
      const p = nextNonSpace[afterF]!;
      if ((p < n && segment[p] === '"') ? atBeforeQuote(p + 1) : atBeforeQuote(afterF)) return true;
    }
  }
  return false;
}

export const DANGEROUS_BASH: readonly DangerousBashRule[] = [
  { pattern: /\brm\s/i,                     label: 'remove files', unattended: 'allow' },
  { pattern: /\bsudo\b/i,                   label: 'elevated privileges', unattended: 'block' },
  { pattern: /\bkill\b/i,                   label: 'kill process', unattended: 'allow' },
  { pattern: /\bchmod\b/i,                  label: 'change permissions', unattended: 'allow' },
  { pattern: /\bchown\b/i,                  label: 'change ownership', unattended: 'allow' },
  { pattern: /\bgit\s+push\s+.*--force/i,   label: 'force push', unattended: 'block' },
  { pattern: /\bgit\s+push\b/i,             label: 'git push (requires explicit user request)', unattended: 'block' },
  { pattern: /\bgit\s+reset\s+--hard/i,     label: 'hard reset', unattended: 'allow' },
  { pattern: /\bgit\s+add\s+(-A|--all|\.)\s*(?:$|[|;&])/im, label: 'stage all files (review before committing)', unattended: 'allow' },
  { pattern: /\bgit\s+commit\b(?!-graph)/i, label: 'git commit (requires explicit user request)', unattended: 'block' },
  { pattern: /\bgit\s+merge\b(?!-(?:base|tree)\b)/i, label: 'git merge', unattended: 'block' },
  { pattern: /\bgit\s+rebase\b/i,           label: 'git rebase', unattended: 'block' },
  { pattern: /\bgit\s+cherry-pick\b/i,      label: 'git cherry-pick', unattended: 'block' },
  { pattern: /\bgit\s+revert\b/i,           label: 'git revert', unattended: 'block' },
  { pattern: /\bgit\s+clean\b/i,            label: 'git clean (deletes untracked files)', unattended: 'allow' },
  { pattern: /\bgit\s+checkout\s+(--\s|\.)/i, label: 'discard uncommitted changes', unattended: 'allow' },
  { pattern: /\bgit\s+restore\b/i,          label: 'git restore (discard changes)', unattended: 'allow' },
  { pattern: /\bgit\s+branch\s+(-[dD]|--delete)\b/i, label: 'delete branch', unattended: 'allow' },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/i,      label: 'discard stashed changes', unattended: 'allow' },
  { pattern: /\bdd\b/i,                     label: 'disk dump', unattended: 'allow' },
  { pattern: /\bmkfs\b/i,                   label: 'format disk', unattended: 'block' },
  { pattern: /\b(shutdown|reboot|halt)\b/i, label: 'system control', unattended: 'block' },
  { pattern: />\s*\/dev\/(?!null\b)/i,      label: 'write to device', unattended: 'block' },
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b.*\|\s*(sh|bash)/im,   label: 'pipe to shell', unattended: 'ask' },
  { pattern: /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i, label: 'package publish', unattended: 'ask' },
  { pattern: /\bdocker\s+push\b/i,          label: 'docker push', unattended: 'block' },
  { pattern: /\bdocker\s+(rm|rmi|prune)/i,  label: 'docker cleanup', unattended: 'ask' },
  { pattern: /\bdocker[\s-]compose\b/i,     label: 'docker compose', unattended: 'block' },
  // Deploy platforms & infrastructure
  { pattern: /\b(wrangler|vercel|netlify|flyctl|railway|firebase|heroku)\b/i, label: 'deploy platform CLI', unattended: 'block' },
  { pattern: /\bkubectl\b/i,                label: 'kubectl (Kubernetes)', unattended: 'ask' },
  { pattern: /\b(terraform|tofu)\b/i,       label: 'terraform/tofu (infrastructure)', unattended: 'ask' },
  { pattern: /\bpulumi\b/i,                 label: 'pulumi (infrastructure)', unattended: 'ask' },
  { pattern: /\b(ansible|ansible-playbook)\b/i, label: 'ansible (remote configuration)', unattended: 'block' },
  { pattern: /\bhelm\b/i,                   label: 'helm (Kubernetes packages)', unattended: 'ask' },
  { pattern: /\baws\s/i,                    label: 'AWS CLI', unattended: 'ask' },
  { pattern: /\bgcloud\s/i,                 label: 'Google Cloud CLI', unattended: 'ask' },
  { pattern: /\baz\s/i,                     label: 'Azure CLI', unattended: 'ask' },
  { pattern: /\bsystemctl\b/i,              label: 'service management', unattended: 'ask' },
  { pattern: /\blaunchctl\b/i,              label: 'service management (macOS)', unattended: 'block' },
  // Remote access
  { pattern: /\bssh\s/i,                    label: 'remote shell access', unattended: 'ask' },
  { pattern: /\bscp\s/i,                    label: 'remote file copy', unattended: 'ask' },
  { pattern: /\brsync\s/i,                  label: 'remote sync', unattended: 'ask' },
  { pattern: /\bsftp\s/i,                   label: 'remote file transfer', unattended: 'ask' },
  // Broad process killing
  { pattern: /\bpkill\b/i,                  label: 'kill processes by name', unattended: 'allow' },
  { pattern: /\bkillall\b/i,                label: 'kill all processes by name', unattended: 'allow' },
  // Package execution/installation (arbitrary code)
  { pattern: /\bnpx\s/i,                    label: 'execute npm package (arbitrary code)', unattended: 'ask' },
  { pattern: /\bpip3?\s+install\b/i,        label: 'install Python package', unattended: 'ask' },
  { pattern: /\bgem\s+install\b/i,          label: 'install Ruby gem', unattended: 'ask' },
  { pattern: /\bcargo\s+install\b/i,        label: 'install Rust crate', unattended: 'ask' },
  { pattern: /\bgo\s+install\b/i,           label: 'install Go package', unattended: 'ask' },
  { pattern: /\bprintenv\b/i,               label: 'print environment (secrets)', unattended: 'block' },
  { pattern: /^[^\S\n\r\u2028\u2029]*env\s*$|\benv\b\s*[|>]/im, label: 'dump environment (secrets)', unattended: 'block' },
  // Read from the line's first wget, in linear time.
  { pattern: /^(?:(?!\bwget\b).)*\bwget\b.*\|\s*(sh|bash)/im, label: 'pipe to shell', unattended: 'ask' },
  { pattern: /\bnc\b\s+\S+\s+\d+/i,        label: 'outbound netcat connection', unattended: 'ask' },
  // Read from the line's first of these words, in linear time.
  { pattern: /^(?:(?!\b(?:cat|less|more|head|tail|xxd|strings|od)\b).)*\b(cat|less|more|head|tail|xxd|strings|od)\b.*\/proc\//im, label: 'read proc filesystem', unattended: 'ask' },
  // Read from the line's first of these words, in linear time.
  { pattern: /^(?:(?!\b(?:cat|less|more|head|tail)\b).)*\b(cat|less|more|head|tail)\b.*\.env\b/im, label: 'read secrets file', unattended: 'allow' },
  ...LYNOX_SECRET_BASH.map((entry) => ({ ...entry, unattended: 'block' as const })),
  { pattern: /\bln\s+(-[a-zA-Z]*s|-[a-zA-Z]*\s+-[a-zA-Z]*s|--symbolic)\b/i, label: 'create symlink', unattended: 'allow' },
  { pattern: /\bpython[23]?\s+-c\b/i,       label: 'python code execution', unattended: 'sends' },
  { pattern: /\bnode\s+-e\b/i,              label: 'node code execution', unattended: 'sends' },
  { pattern: /\bperl\s+-e\b/i,              label: 'perl code execution', unattended: 'sends' },
  { pattern: /\bruby\s+-e\b/i,              label: 'ruby code execution', unattended: 'sends' },
  { pattern: /\bcrontab\b/i,                label: 'modify cron jobs', unattended: 'ask' },
  { pattern: /\biptables\b/i,               label: 'modify firewall rules', unattended: 'ask' },
  { pattern: /\buseradd\b|\busermod\b|\bgroupadd\b/i, label: 'modify users/groups', unattended: 'ask' },
  // Read from the line's first cat, in linear time.
  { pattern: /^(?:(?!\bcat\b).)*\bcat\b.*[^2]>\s*(?!\/tmp\/|\/dev\/null)/im, label: 'write file via bash (use write_file instead)', unattended: 'allow' },
  // Read from the line's first echo, in linear time.
  { pattern: /^(?:(?!\becho\b).)*\becho\b.*[^2]>\s*(?!\/tmp\/|\/dev\/null)/im, label: 'write file via bash (use write_file instead)', unattended: 'allow' },
  { pattern: /\btee\b\s+(?!\/tmp\/)/i,      label: 'write file via bash (use write_file instead)', unattended: 'allow' },
  { pattern: /\bsed\s+-i\b/i,               label: 'in-place file edit via bash (use write_file instead)', unattended: 'allow' },
  // HTTP mutations via bash (bypasses http_request SSRF protection) — keep AFTER secrets patterns
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)/im, label: 'HTTP mutation via curl', unattended: 'sends' },
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b.*(--data\b|-d\s|-F\s|--form\b)/im, label: 'HTTP data submission via curl', unattended: 'sends' },
  // Read from the line's first wget, in linear time.
  { pattern: /^(?:(?!\bwget\b).)*\bwget\b.*(--post-data|--post-file|--method)/im, label: 'HTTP mutation via wget', unattended: 'sends' },
  // Shell escape / arbitrary code execution
  //
  // The four "A, then a pipe, then B" rules below read each line once. Written as `A.*\|.*B`,
  // every A was tried with every later pipe and every later B: cubic in the line, about 48 s for
  // a 10 KB command of repeated `echo |`. A line matches the old form exactly when its FIRST A is
  // followed by a pipe and a B after it (any later A, pipe or B only comes later still), so each
  // rule anchors at a line start (`^` with `m`) and reads up to the first A, then up to the next
  // pipe (or `-r`, or `\x..`), never passing them. Neither part can give back a start to retry.
  { pattern: /\beval\b/i,                             label: 'eval (arbitrary code execution)', unattended: 'ask' },
  { pattern: /^(?:(?!base64).)*base64(?:(?!\|).)*\|.*(?:bash|sh|zsh)\b/im, label: 'base64 decode piped to shell', unattended: 'ask' },
  { pattern: /\bbash\s+-c\b/i,                        label: 'bash -c (explicit subshell)', unattended: 'sends' },
  { pattern: /^(?:(?!\becho\b).)*\becho\b(?:(?!\|).)*\|.*\b(?:bash|sh|zsh)\b/im, label: 'echo piped to shell', unattended: 'ask' },
  // SQL — data destruction (also in CRITICAL_BASH for autonomous blocking)
  { pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER))\b/i, label: 'SQL DROP (irreversible data destruction)', unattended: 'block' },
  { pattern: /\bTRUNCATE\b/i, label: 'SQL TRUNCATE (irreversible data destruction)', unattended: 'block' },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*;/i, label: 'SQL DELETE without WHERE (full table wipe)', unattended: 'block' },
  // Database CLIs — data access and modification
  { pattern: /\b(psql|mysql|sqlite3|mongosh|mongo)\b/i, label: 'database CLI', unattended: 'ask' },
  { pattern: /\b(pg_dump|mysqldump|mongodump|pg_restore|mysqlimport|mongoexport)\b/i, label: 'database dump/restore (data exfiltration risk)', unattended: 'ask' },
  // Email sending — outbound communication
  { pattern: /\b(sendmail|msmtp|mutt|mailx?)\s/i, label: 'send email', unattended: 'ask' },
  // Payment CLIs — financial mutations (also in CRITICAL_BASH for specific mutations)
  { pattern: /\bstripe\s+(charges|payouts|transfers|refunds|customers\s+delete|subscriptions\s+cancel)\b/i, label: 'payment mutation (financial impact)', unattended: 'block' },
  { pattern: /\b(stripe|paypal)\s/i, label: 'payment platform CLI', unattended: 'ask' },
  // Webhook/notification URLs via curl
  // Read from the line's first curl, in linear time.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b.*\b(hooks\.slack\.com|discord\.com\/api\/webhooks|webhook\.site)\b/im, label: 'webhook notification', unattended: 'ask' },
  // Messaging CLIs
  { pattern: /\b(slack-cli|twilio)\s/i, label: 'messaging platform CLI', unattended: 'ask' },
  // Encoding bypass — hex/octal decode piped to shell
  { pattern: /^(?:(?!\bxxd\b).)*\bxxd\b(?:(?!-r).)*-r.*\|\s*(?:bash|sh|zsh)\b/im, label: 'hex decode piped to shell', unattended: 'ask' },
  { pattern: /^(?:(?!\bprintf\b).)*\bprintf\b(?:(?!\\x[0-9a-f]).)*\\x[0-9a-f].*\|\s*(?:bash|sh|zsh)\b/im, label: 'printf hex escape piped to shell', unattended: 'ask' },
  // File upload via curl form (file exfiltration). Read by `curlFormUploadsFile`, which matches
  // what `/\bcurl\b.*-F\s*"?[^"]*@/i` matched, in linear time. The pattern is the predicate's
  // filter.
  { pattern: /^(?:(?!\bcurl\b).)*\bcurl\b(?:(?!-F).)*-F/im, matches: curlFormUploadsFile, label: 'file upload via curl form (data exfiltration)', unattended: 'ask' },
  // Reverse shell / covert channel (also in CRITICAL for autonomous blocking)
  { pattern: /\b(ncat|socat)\b/i,                  label: 'reverse shell enabler (ncat/socat)', unattended: 'block' },
  // Bash built-in networking
  { pattern: /\/dev\/(tcp|udp)\//i,                label: 'bash built-in networking (/dev/tcp)', unattended: 'block' },
  // Local HTTP server
  { pattern: /\bpython[23]?\s+-m\s+(http\.server|SimpleHTTPServer)\b/i, label: 'local HTTP server (data exfiltration)', unattended: 'block' },
];

/** The rules of DANGEROUS_BASH an unattended run asks about (see DangerousBashRule). */
const UNATTENDED_ASK_BASH = DANGEROUS_BASH.filter((rule) => rule.unattended === 'ask');

/**
 * DANGEROUS_BASH without its `block` rules, for the chat scan that runs after CRITICAL_BASH found
 * nothing: a `block` rule matches only what CRITICAL_BASH matches, so it cannot hit there, and
 * scanning it would only cost time on a long command. Exported for tests.
 */
export const DANGEROUS_AFTER_CRITICAL_BASH = DANGEROUS_BASH.filter((rule) => rule.unattended !== 'block');

const SENSITIVE_PATHS: RegExp[] = [
  /^\/etc\//, /^\/usr\//, /^\/sys\//, /^\/proc\//, /^\/root\//,
  /\.(env|pem|key|p12|pfx|jks)$/,
  /id_(rsa|ed25519|ecdsa|dsa)/, /authorized_keys/, /known_hosts/,
  /credentials/i, /\.netrc$/,
  /\.(ssh|gnupg|aws|config|docker|kube|npm)\//,
  /\.token$/, /\.secret$/,
  LYNOX_SECRET_FILES,
  LYNOX_DB_FILES,
  // Shell history files — prime exfil target for env vars, ssh URLs, pasted secrets.
  /\.(bash|zsh|fish|node_repl|python)_?history$/,
  // macOS Keychain — system + user keychains hold credentials, certs, browser passwords.
  /\/Library\/Keychains\//,
  // Browser-stored secrets — cookies + saved passwords + session storage.
  // macOS Application Support paths for Chrome / Firefox / Brave / Edge + Linux ~/.mozilla.
  // (Linux ~/.config/google-chrome already covered by the broader .config/ rule above.)
  /Application\s+Support\/(Google\/Chrome|Firefox\/Profiles|Brave-Browser|Microsoft\/Edge)/i,
  /\.mozilla\//,
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


/**
 * The structured danger signal. `warning` is the GO text (identical to what
 * {@link isDangerous} returns); `payload` is present ONLY when the danger came
 * from a declarative `ToolEntry.destructive` check that returned a
 * {@link WarningPayload} (the spawn-agent deep-tier gate), letting the caller
 * (agent.ts) offer a downgrade. Dangers from `_detectDanger`'s hardcoded
 * branches (bash / read / write / mail / http / …) carry no payload — only a
 * declarative `destructive` check returning a WarningPayload sets it.
 */
export interface DangerSignal {
  /** The prompt as plain text with the agent's part as written: for the audit, the `[BLOCKED`
   *  checks and the callers that log it. */
  warning: string;
  /** The same prompt with what the agent wrote marked as values: what the person is asked with. */
  prompt: PromptText;
  payload?: WarningPayload | undefined;
  /** A hard block: refused in an unattended run instead of being queued for approval. Set only by
   *  the rule that decided it; an action that asks for an OK has `[BLOCKED` without this. */
  hardBlock?: true | undefined;
}

/**
 * Re-read the declarative destructive `check` to recover the structured
 * {@link WarningPayload}, if any. The check is PURE (reads config, no side
 * effects), so calling it a second time here — only for tools that HAVE a
 * destructive check — avoids threading a payload through `_detectDanger`'s many
 * string-return paths. A non-destructive tool, or a check that returned a plain
 * action-label string, yields null: those dangers offer no downgrade.
 * Consistent with `_detectDanger` by construction: both call the same
 * `check(input, { autonomy, parentProvider })`.
 */
function extractDangerPayload(toolName: string, input: unknown, autonomy: AutonomyLevel | undefined, entry: ToolEntry | undefined, parentProvider: ProviderConfigSnapshot | null | undefined): WarningPayload | null {
  const check = entry?.destructive?.check;
  if (!check) return null;
  const detail = check(input, { autonomy, parentProvider });
  if (detail !== null && typeof detail !== 'string') return detail;
  return null;
}

/**
 * The full danger signal with the capability-contract override and
 * the observability publish applied — the single place that logic lives.
 * {@link isDangerous} is a thin `?.warning` wrapper over this for the many
 * callers (and the test suite) that only want the warning string; agent.ts calls
 * this directly to also receive `payload`, so the GO can offer a cheaper tier
 * when `payload.downgradeTo` is set.
 */
export function isDangerousDetailed(toolName: string, input: unknown, autonomy?: AutonomyLevel, entry?: ToolEntry, runId?: string, contract?: CapabilityContract, parentProvider?: ProviderConfigSnapshot | null): DangerSignal | null {
  const signal = _decideDanger(toolName, input, autonomy, entry, runId, contract, parentProvider);
  // Observed against the FINAL decision: a call a contract lets
  // through runs without a question, and is recorded as one that does.
  observeBashProof(toolName, input, autonomy, signal?.warning ?? null, runId);
  return signal;
}

function _decideDanger(toolName: string, input: unknown, autonomy: AutonomyLevel | undefined, entry: ToolEntry | undefined, runId: string | undefined, contract: CapabilityContract | undefined, parentProvider: ProviderConfigSnapshot | null | undefined): DangerSignal | null {
  const danger = _detectDanger(toolName, input, autonomy, entry, parentProvider);
  if (!danger) return null;
  const { prompt, warning } = danger;

  // A capability contract can override NON-critical dangers only.
  // Critical ops ([BLOCKED]) are never auto-approved — they carry the "[BLOCKED"
  // marker and fall straight through to the audit publish below.
  if (!warning.includes('[BLOCKED')) {
    // Capability-contract grant (Slice B): a confirmed contract lifts a
    // warn-level autonomous denial for an explicitly declared (tool, method,
    // host, path) tuple — and only that tuple. The grant requires host AND path
    // AND method to all match, so a re-target param that resolved into a
    // different host/path/method is NOT granted → the warning stands → denied
    // (the S1 fix the host-only assertHostPolicy misses). Never reached for a
    // [BLOCKED] critical (guarded above), so a contract can't lift CRITICAL_BASH
    // / sensitive-path / http DELETE — the post-substitution bash scan in
    // _detectDanger therefore still governs every bash call regardless of the
    // contract (PRD §7 S4).
    if (contract && contractGrants(toolName, input, contract)) {
      return null;
    }
  }

  // Publish guard block for observability / audit. A2: stamp the run id this
  // decision occurred in (so a headless step's block is attributable post-hoc)
  // and the capability-contract version that governed it (Slice B: real once a
  // contract is present; null/undefined for an ungoverned run).
  if (channels.guardBlock.hasSubscribers) {
    channels.guardBlock.publish({ toolName, warning, autonomy, runId, contractVersion: contract?.version });
  }

  const payload = extractDangerPayload(toolName, input, autonomy, entry, parentProvider);
  return { warning, prompt, ...(payload ? { payload } : {}), ...(danger.hardBlock === true ? { hardBlock: true as const } : {}) };
}

/**
 * Observe mode of the bash allowlist: for every unattended bash call, record whether
 * the positive grammar in `bash-allowlist.ts` proves it, next to what the guard decided.
 * Nothing is enforced. The record names the program only when it is on the fixed
 * program list, and the reason as a fixed word; it carries no argument or path. It is
 * written once per tool call (agent.ts is the only production caller) to the local
 * security log, and it is left out of the content-free aggregate the control plane can
 * read, so it stays on the instance.
 */
function observeBashProof(toolName: string, input: unknown, autonomy: AutonomyLevel | undefined, warning: string | null, runId: string | undefined): void {
  if (toolName !== 'bash' || autonomy !== 'autonomous') return;
  if (!channels.securityFlagged.hasSubscribers) return;
  if (!input || typeof input !== 'object' || !('command' in input)) return;
  const command = String((input as { command: unknown }).command);
  const proof = proveBashCommand(command, {
    cwd: getWorkspaceCwd(),
    home: process.env['HOME'],
    readRoots: READ_ONLY_ROOTS,
    isSensitive: (realPath) => SENSITIVE_PATHS.some((re) => re.test(realPath)),
  });
  const current = !warning ? 'free' : warning.includes('[BLOCKED') ? 'blocked' : 'asks';
  channels.securityFlagged.publish({
    event_type: BASH_OBSERVE_EVENT,
    tool_name: 'bash',
    decision: proof.proven ? 'proven' : 'unproven',
    autonomy_level: autonomy,
    run_id: runId,
    detail: `program=${proof.program};reason=${proof.reason};current=${current}`,
  });
}

export function isDangerous(toolName: string, input: unknown, autonomy?: AutonomyLevel, entry?: ToolEntry, runId?: string, contract?: CapabilityContract, parentProvider?: ProviderConfigSnapshot | null): string | null {
  return isDangerousDetailed(toolName, input, autonomy, entry, runId, contract, parentProvider)?.warning ?? null;
}

/** A value matches if any glob pattern in the list matches it (empty list = no match). */
function _matchesAnyGlob(value: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (globToRegex(p).test(value)) return true;
  }
  return false;
}

/**
 * Does the capability contract explicitly grant this exact tool call? Additive
 * grant only (the caller already ruled out [BLOCKED] criticals). B1 scopes the
 * grant to `http_request` — the documented exfil write vector — and requires the
 * tool to be listed in `grantedTools` AND its method ∈ `httpMethods` AND the
 * resolved hostname ∈ `hostPatterns` AND the resolved pathname ∈ `pathPatterns`.
 * Any other tool is never granted (so e.g. a spawn_agent injection warning or a
 * non-workspace write can't be laundered through a contract).
 *
 * Exported because the `http_request` tool has a SECOND, independent
 * first-use-consent gate (`http.ts`) that the `isDangerous` grant alone doesn't
 * satisfy — a contract that grants a write IS the pre-declared consent, so that
 * gate (and its redirect re-validation) calls this to recognise the grant.
 */
export function contractGrants(toolName: string, input: unknown, contract: CapabilityContract): boolean {
  if (!contract.grantedTools?.includes(toolName)) return false;
  if (toolName !== 'http_request') return false;
  if (!input || typeof input !== 'object') return false;

  const obj = input as { url?: unknown; method?: unknown };
  const method = (typeof obj.method === 'string' ? obj.method : 'GET').toUpperCase();
  if (!(contract.httpMethods ?? []).some(m => m.toUpperCase() === method)) return false;
  if (typeof obj.url !== 'string') return false;
  // No contract grants a write to a GraphQL endpoint: there a read and every mutation the token
  // can run are the same POST to the same path, and nothing here reads the document. Read from
  // the URL alone, so it holds for the callers that never pass a body.
  if (method !== 'GET' && method !== 'HEAD' && isGraphqlEndpoint(obj.url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(obj.url);
  } catch {
    return false;
  }
  // No contract grants a mail API on the list in `core/bulk-mail-targets.ts`, whoever wrote
  // it, so no grant sends unattended through one; the mail tools ask in the chat before each
  // email.
  if (isMailProviderTarget(obj.url)) return false;
  const listQuery = LIST_QUERIES.get(contract);
  if (listQuery === undefined) {
    if (contract.origin === 'reviewed' && !isReviewableUrl(parsed, obj.url)) return false;
  } else if (!grantsListRead(input, obj.url, method, listQuery)) {
    return false;
  }
  if (contract.origin === 'reviewed' && carriesUnreviewedHeader((input as { headers?: unknown }).headers)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!_matchesAnyGlob(host, contract.hostPatterns)) return false;
  if (!_matchesAnyGlob(parsed.pathname, contract.pathPatterns)) return false;
  return true;
}

/**
 * The request headers a reviewed grant lets the caller set. Some headers re-target a call
 * past the tuple a person was shown: a caller-set `Host` (or a forwarded host, or a
 * rewritten URL a front end honours) routes the request to another virtual host or path on
 * the same address (TLS and the pin still follow the URL), and a method-override header
 * makes a server that honours it run another verb — DELETE included — under a granted POST.
 *
 * ⛔ A LIST OF WHAT IS ALLOWED, not of what re-targets. Which headers a proxy or framework
 * honours is not a closed set, so a list of the dangerous ones is never finished. These are
 * the headers that describe a body, ask for a form of the answer, or make a write
 * conditional or repeatable. No credential header is among them: this check reads the
 * headers the caller wrote, never the slot the engine fills from a profile.
 */
const REVIEWED_HEADERS = new Set([
  'content-type', 'accept', 'accept-language', 'idempotency-key', 'if-match', 'if-none-match',
]);

/**
 * Plus the API version an endpoint asks for (`Notion-Version`, `Stripe-Version`,
 * `X-GitHub-Api-Version`, `X-Shopify-Api-Version`): a name that ends in `version` picks a
 * version of the API on the same host, path and verb.
 */
const VERSION_HEADER = /^[a-z0-9]+(?:-[a-z0-9]+)*-version$/;

/**
 * May a caller set this request header under a reviewed grant? Exported so the place that
 * accepts a grant can ask the same question of a workflow's step templates.
 */
export function isReviewedHeaderName(raw: string): boolean {
  const name = raw.trim().toLowerCase();
  return REVIEWED_HEADERS.has(name) || VERSION_HEADER.test(name);
}

function carriesUnreviewedHeader(headers: unknown): boolean {
  if (headers === null || typeof headers !== 'object') return false;
  return Object.keys(headers).some((raw) => !isReviewedHeaderName(raw));
}

/**
 * The URL dimensions the grant tuple does not carry. A reviewed contract shows a person
 * `METHOD https://host/path` and the tuple compares only method, hostname and pathname, so
 * without this a reviewed grant would also admit plain http, any port, credentials in the
 * URL, and an arbitrary query. These are the rules the bulk path applies to every target at
 * planning (`externalTargetKey`); here they are checked at dispatch, because a workflow's
 * model writes its URL at run time.
 */
export function isReviewableUrl(parsed: URL, raw: string): boolean {
  if (parsed.protocol !== 'https:' || parsed.port !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  // On the raw text: a non-empty query or fragment always has its character there, and a
  // bare one that `URL` normalised away does too.
  if (raw.includes('?')) return false;
  if (raw.includes('#')) return false;
  return true;
}

/**
 * The query a reviewed list read may carry (PRD bulk-loop §3.2): name → the values it may
 * take — an exact list, or a regex the whole value must match.
 */
export interface ListQueryConstraints {
  readonly [name: string]: { readonly enum?: readonly string[] | undefined; readonly regex?: string | undefined };
}

/**
 * The query constraints of the list-read contracts the engine built in this process. Held
 * here, never on the contract: a contract that was stored, parsed or imported is a new
 * object, so it has none and takes the query-free path above, word for word. A database row
 * or an imported workflow can therefore never carry a grant for a query.
 */
const LIST_QUERIES = new WeakMap<CapabilityContract, ListQueryConstraints>();

/**
 * A reviewed contract that also admits the query `constraints` describe, on a GET — the read
 * of one paginated list by a bulk run, whose address the engine built (`bulk-list.ts`).
 * The returned contract is a frozen copy; only it carries the constraints. That a query only
 * ever rides on a GET is decided per request ({@link grantsListRead}), not here, so it holds
 * whatever contract the constraints were attached to.
 */
export function withListQuery(contract: CapabilityContract, constraints: ListQueryConstraints): CapabilityContract {
  if (contract.origin !== 'reviewed') throw new Error('a list read is only granted by a reviewed contract');
  const copy = Object.freeze({ ...contract });
  LIST_QUERIES.set(copy, Object.freeze({ ...constraints }));
  return copy;
}

/** The longest query a list read sends. A list whose longest page address would pass it is refused when it is planned (`parseListSource`). */
export const LIST_QUERY_MAX = 512;
const LIST_QUERY_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const LIST_QUERY_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
/** Names outside that alphabet a list read may still carry — each one a list form sets itself,
 *  never a planner (it is admitted only where the constraints name it, as any other). WordPress's
 *  `_fields` narrows each element to the field named, where the server honours it. */
const LIST_QUERY_FIXED_NAMES: ReadonlySet<string> = new Set(['_fields']);

/**
 * Whether `raw` — the text after `?` — is a query a list read may send. Checked on the raw
 * text, not on a parse of it: every server splits and decodes on its own, so the text admitted
 * is one no splitting can read differently. Names and values of a narrow alphabet (no `%`,
 * `+`, `;`, `[`, `.`, `=` or `&` inside), each name once and among `constraints`, each value
 * one they allow. ⛔ No name that could select a method is ever admitted, whatever the
 * constraints say: which names a framework reads as a method override is not a closed set
 * (`_method`, the override headers written as parameters, a getter of the app's choosing).
 */
export function reviewableQuery(raw: string, constraints: ListQueryConstraints): boolean {
  if (raw.length > LIST_QUERY_MAX) return false;
  const seen = new Set<string>();
  for (const segment of raw.split('&')) {
    const eq = segment.indexOf('=');
    // An empty segment, a name without a value, a value without a name. A second `=` fails
    // the value alphabet below.
    if (eq <= 0) return false;
    const name = segment.slice(0, eq);
    const value = segment.slice(eq + 1);
    if (!(LIST_QUERY_NAME.test(name) || LIST_QUERY_FIXED_NAMES.has(name)) || !LIST_QUERY_VALUE.test(value)) return false;
    if (seen.has(name)) return false;
    seen.add(name);
    // The alphabet above already leaves out every spelling a server folds into another name
    // (PHP turns `.`, ` ` and `[` into `_`; header names are written with `-`; `_method`
    // starts with `_`; the fixed names are spelled out whole), so the name a server reads is this one.
    if (name.includes('method')) return false;
    if (!Object.hasOwn(constraints, name)) return false;
    const c = constraints[name]!;
    if (c.enum !== undefined && !c.enum.includes(value)) return false;
    if (c.regex !== undefined && !new RegExp(`^(?:${c.regex})$`).test(value)) return false;
    if (c.enum === undefined && c.regex === undefined) return false;
  }
  return true;
}

/**
 * The URL rules of a list read: the address without its query is a reviewable one, the
 * query is one {@link reviewableQuery} admits, the request is a GET in effect — no override
 * raises it — and it carries no body.
 */
function grantsListRead(input: object, url: string, method: string, constraints: ListQueryConstraints): boolean {
  if ((input as { body?: unknown }).body !== undefined) return false;
  const rawHeaders = (input as { headers?: unknown }).headers;
  const headers = rawHeaders !== null && typeof rawHeaders === 'object'
    ? Object.fromEntries(Object.entries(rawHeaders as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    : {};
  if (effectiveWriteMethod(method, headers, url) !== 'GET') return false;
  const q = url.indexOf('?');
  if (q === -1) return false;
  const base = url.slice(0, q);
  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
  } catch {
    return false;
  }
  return isReviewableUrl(parsedBase, base) && reviewableQuery(url.slice(q + 1), constraints);
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
  // Expand $IFS / ${IFS} to a space — a common way to smuggle field separators
  // into a command without a literal space, so `rm$IFS-rf$IFS/` executes as
  // `rm -rf /` yet the literal-token danger patterns (which expect `\s`) miss it.
  normalized = normalized.replace(/\$\{IFS\}|\$IFS/g, ' ');
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

/**
 * Remove shell quoting/escaping the same way a POSIX shell does before it word-
 * splits — so the danger scan sees the command the shell will ACTUALLY run, not
 * the quoted spelling. Without this, intra-word quotes/backslashes defeat the
 * literal-token patterns: `r''m -rf /`, `s\udo`, `"docker" run` all pass the
 * guard as written yet execute as `rm -rf /` / `sudo` / `docker run`.
 */
export function stripShellQuotes(cmd: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; } // single quotes are literal — no escapes
      out += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < cmd.length) {
        const next = cmd[i + 1]!;
        // Inside double quotes a backslash only escapes $ ` " \ — otherwise it's literal.
        if (next === '$' || next === '`' || next === '"' || next === '\\') { out += next; i++; continue; }
        out += ch;
        continue;
      }
      if (ch === '"') { inDouble = false; continue; }
      out += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) { out += cmd[i + 1]!; i++; continue; } // unquoted backslash escapes the next char
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    out += ch;
  }
  return out;
}

/**
 * One regex for a whole list: the union of its rules, so a segment no rule matches costs one
 * pass per flag set, not one per rule. On a long command the surface runs to millions of
 * characters, and the per-rule passes were what grew with every rule added. The rules are grouped
 * by their flags, one union per group. Built only where each union is exact: no rule global or
 * sticky, and no backreference (whose number would change in the union). Otherwise `null`, and
 * every segment is read rule by rule as before.
 */
const listUnions = new WeakMap<ReadonlyArray<{ pattern: RegExp }>, RegExp[] | null>();
/** Exported for tests. */
export function _listUnions(patterns: ReadonlyArray<{ pattern: RegExp }>): RegExp[] | null {
  if (listUnions.has(patterns)) return listUnions.get(patterns)!;
  let unions: RegExp[] | null = null;
  if (patterns.every(({ pattern }) => !/[gy]/.test(pattern.flags) && !/\\[1-9]|\\k</.test(pattern.source))) {
    const byFlags = new Map<string, string[]>();
    for (const { pattern } of patterns) {
      const sources = byFlags.get(pattern.flags) ?? [];
      sources.push(`(?:${pattern.source})`);
      byFlags.set(pattern.flags, sources);
    }
    try {
      unions = [...byFlags].map(([flags, sources]) => new RegExp(sources.join('|'), flags));
    } catch {
      unions = null; // e.g. two rules naming the same group: read rule by rule
    }
  }
  listUnions.set(patterns, unions);
  return unions;
}

/** Exported for tests. */
export function _checkPatterns(segments: string[], patterns: ReadonlyArray<{ pattern: RegExp; label: string; matches?: (segment: string) => boolean }>): { label: string } | null {
  const unions = _listUnions(patterns);
  for (const segment of segments) {
    // Only a segment some rule matches is read rule by rule, in list order, for the label.
    if (unions && !unions.some((union) => union.test(segment))) continue;
    for (const { pattern, label, matches } of patterns) {
      if (pattern.test(segment) && (matches === undefined || matches(segment))) {
        return { label };
      }
    }
  }
  return null;
}

// A token carrying a shell operator is not a plain option: `-euo|tail` ends the command at the pipe.
const isOptionToken = (token: string): boolean =>
  token.length > 1 && token.startsWith('-') && !/[|;&<>()]/.test(token);
/** Tokens of the remainder kept per variant — enough for any rule's subcommand and arguments. */
const OPTION_VARIANT_TAIL = 64;
/**
 * A word right after an option may be that option's value or the next command (`env -i git`,
 * `nice -n5 git`), so it also opens a run, a short one: this many words of options and their
 * values dropped at most (eight options with a value each), this many tokens kept. Short, so a
 * line of options and values stays linear and not quadratic.
 */
const VALUE_WORD_PREFIXES = 16;
const VALUE_WORD_TAIL = 16;
/** A shell assignment (`NAME=value`): where a command would stand, it is not the command. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * A shell word: a closed quoted span is part of the word it sits in (`-C "my dir"` is two words,
 * not three), and `\X` is one character. A quote that never closes does not swallow the rest of
 * the line: it belongs to no word, and the words after it stay words.
 */
const SHELL_WORD = /(?:\\[\s\S]|[^\s"'\\]+|"(?:[^"\\]|\\[\s\S])*"|'[^']*')+/g;

/**
 * The same segment with the options between a command and its subcommand dropped.
 *
 * The rules name a command and its subcommand side by side (`git push`, `kubectl delete`,
 * `python -m http.server`), but most CLIs take global options in between — `git -C dir push`,
 * `kubectl -n ns delete`. Which options take a value differs per tool, so this does not try
 * to know: for every command word followed by options, it yields the segment with each
 * prefix of that option run removed, a word directly after an option counting as a possible
 * value. That word may as well be the next command of a wrapper (`env -i git -C . push`), so it
 * opens a short run of its own. One of those variants puts the real subcommand next to its command; the rules then
 * match it as they match the plain form. No tool is listed here, so a new CLI with global
 * options is covered without a change.
 *
 * Only ever ADDS scan surface: the original segment is still scanned, so nothing that was
 * caught before can stop being caught. A variant never leaves the command without a word after
 * it (`set -e` does not become `set`, `set -e x | head` not `set | head`), and each keeps a
 * bounded tail, so the work stays linear in the command's length. A variant stays on its line
 * and keeps the line's own text: options never continue a command across a line break (only
 * across an escaped one), and joining lines would let a rule read a `>` or a `|` from the next
 * line as part of this command.
 */
export function withoutLeadingOptions(segment: string): string[] {
  const variants: string[] = [];
  for (const line of segment.replace(/\\\n/g, ' ').split('\n')) {
    const tokens = [...line.matchAll(SHELL_WORD)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
    for (let i = 0; i < tokens.length - 1; i++) {
      const word = tokens[i]!.text;
      // A command word: not an option itself. One that may be the value of the option before it
      // gets the short run (`VALUE_WORD_PREFIXES`), unless it is an assignment: there a command
      // after it is not the value of an option and opens its own run.
      if (isOptionToken(word)) continue;
      const mayBeValue = i > 0 && isOptionToken(tokens[i - 1]!.text);
      if (mayBeValue && ASSIGNMENT_WORD.test(word)) continue;
      const end = mayBeValue ? Math.min(tokens.length - 1, i + 1 + VALUE_WORD_PREFIXES) : tokens.length - 1;
      const tail = mayBeValue ? VALUE_WORD_TAIL : OPTION_VARIANT_TAIL;
      for (let k = i + 1; k < end; k++) {
        const inRun = isOptionToken(tokens[k]!.text) || (k > i + 1 && isOptionToken(tokens[k - 1]!.text));
        if (!inRun) break;
        // Nothing would stand in the subcommand's place: `set -e x | head` is not `set | head`.
        if (/^[|;&<>)]/.test(tokens[k + 1]!.text)) continue;
        // In the short run only a word can be the subcommand, so an option in its place yields nothing.
        if (mayBeValue && isOptionToken(tokens[k + 1]!.text)) continue;
        const last = tokens[Math.min(k + tail, tokens.length - 1)]!;
        variants.push(`${word} ${line.slice(tokens[k + 1]!.start, last.end)}`);
      }
    }
  }
  // A repeated option run yields the same reading many times; each is scanned once.
  return [...new Set(variants)];
}

/**
 * The command with every line break removed that may not be one to the shell, for the danger
 * scan, which only gains surface from reading too much as one line. A `\` directly before a
 * line break (after an even run of backslashes, so the `\` is not itself escaped) continues the
 * line, and the shell drops both before it splits words. A lone `\r`
 * and U+2028/U+2029 end a line for a regex (`.` stops there) but are ordinary characters to the
 * shell, so they become a space. A `\` before `\r\n` escapes the `\r`, so that line is not
 * continued, here as in the shell.
 *
 * Quotes are not tracked, on purpose. The shell keeps a continuation inside single quotes, and a
 * reading that tracked them broke on the first apostrophe in a comment or a heredoc body,
 * leaving every later continuation unjoined. Joining inside quotes only adds scan surface:
 * the same text written on one line is read the same way already.
 */
export function joinLineContinuations(cmd: string): string {
  return cmd
    .replace(/(?<!\\)((?:\\\\)*)\\\n/g, '$1')
    .replace(/\r(?!\n)|[\u2028\u2029]/g, ' ');
}

// ── curl arguments read as the shell splits them ──────────────────────────

/** One piece of a shell word: text the shell takes as written, or an expansion it fills in. */
type WordPart =
  | { kind: 'text'; text: string }
  | { kind: 'expansion'; source: string };

/** The words of one simple command, and whether the reading reached the end of the input. */
interface CommandWords { words: WordPart[][]; complete: boolean }

/**
 * The end of a balanced span that opens at `start` (`(`, `{` or `[`), skipping quoted text and
 * escapes inside it; -1 when it never closes.
 */
function balancedEnd(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return -1; i = j; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return -1;
      i = j;
      continue;
    }
    if (c === '`') { const j = s.indexOf('`', i + 1); if (j < 0) return -1; i = j; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** The end of the expansion that starts with the `$` at `i`, or null when that `$` is plain text. */
function expansionEnd(s: string, i: number): number | null {
  const next = s[i + 1];
  if (next === '(') return balancedEnd(s, i + 1, '(', ')');
  if (next === '{') return balancedEnd(s, i + 1, '{', '}');
  if (next === '[') return balancedEnd(s, i + 1, '[', ']');
  if (next === '"') {
    let j = i + 2;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    return j >= s.length ? -1 : j + 1;
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let j = i + 2;
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
    return j;
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return i + 2;
  return null;
}

/** The longest brace list the reader looks for the end of; see `readCommandWords`. */
const BRACE_LIST_MAX = 1024;

/**
 * Split a command into simple commands and their words the way the shell does, as far as a
 * danger check needs: quotes and escapes are resolved, `$…`, `${…}`, `$(…)`, `$((…))`, `$[…]`
 * and backticks are kept whole as one expansion, however many spaces they hold, a comment and
 * a heredoc body are not read as commands, and a redirection's target is no argument. A brace
 * list (`{a,b}`, `{1..3}`) is marked on its word as an expansion of its own.
 *
 * Where it reads differently from bash: a backslash inside double quotes is always dropped,
 * `$'…'` is left to `normalizeCommand`, and a heredoc inside `$(…)` is not known, so a quote in
 * its body can leave the command unread.
 *
 * `complete` is false when a quote or an expansion never closes: the shell would refuse such a
 * command, but a reader that loses its place there must not read the rest as checked.
 */
export function readCommandWords(cmd: string): CommandWords[] {
  const commands: CommandWords[] = [];
  let words: WordPart[][] = [];
  let word: WordPart[] | null = null;
  let dropNextWord = false;
  const heredocs: Array<{ delimiter: string; tabs: boolean }> = [];
  const text = (t: string): void => { (word ??= []).push({ kind: 'text', text: t }); };
  const expansion = (source: string): void => { (word ??= []).push({ kind: 'expansion', source }); };
  const endWord = (): void => {
    if (word === null) return;
    if (dropNextWord) dropNextWord = false;
    else words.push(word);
    word = null;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push({ words, complete: true });
    words = [];
  };
  const incomplete = (): CommandWords[] => {
    endWord();
    commands.push({ words, complete: false });
    return commands;
  };

  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '\n') {
      endCommand();
      i++;
      // A heredoc body is data for the command above it, never a command.
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        while (i < cmd.length) {
          const eol = cmd.indexOf('\n', i);
          const line = cmd.slice(i, eol < 0 ? cmd.length : eol);
          i = eol < 0 ? cmd.length : eol + 1;
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
      continue;
    }
    if (c === '#' && word === null) {
      const eol = cmd.indexOf('\n', i);
      i = eol < 0 ? cmd.length : eol;
      continue;
    }
    // `\` before a line break continues the line: the shell drops both before it splits words.
    if (c === '\\') { if (i + 1 < cmd.length && cmd[i + 1] !== '\n') text(cmd[i + 1]!); i += 2; continue; }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return incomplete();
      text(cmd.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      text('');
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        const d = cmd[j]!;
        if (d === '\\') { if (j + 1 < cmd.length) text(cmd[j + 1]!); j += 2; continue; }
        if (d === '`') {
          const k = cmd.indexOf('`', j + 1);
          if (k < 0) return incomplete();
          expansion(cmd.slice(j, k + 1));
          j = k + 1;
          continue;
        }
        if (d === '$') {
          const end = expansionEnd(cmd, j);
          if (end === -1) return incomplete();
          if (end !== null) { expansion(cmd.slice(j, end)); j = end; continue; }
        }
        text(d);
        j++;
      }
      if (j >= cmd.length) return incomplete();
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = cmd.indexOf('`', i + 1);
      if (j < 0) return incomplete();
      expansion(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const end = expansionEnd(cmd, i);
      if (end === -1) return incomplete();
      if (end !== null) { expansion(cmd.slice(i, end)); i = end; continue; }
      text('$');
      i++;
      continue;
    }
    if (c === '{') {
      // A brace list only on an unquoted word with no space in it: `{-d,a=b}` → `-d a=b`. The
      // search for its end stops at the word's end and at BRACE_LIST_MAX characters, so a run of
      // braces costs a bounded scan each. A word that runs past that bound unclosed is unread.
      let bound = i;
      while (bound < cmd.length && bound - i < BRACE_LIST_MAX && !/\s/.test(cmd[bound]!)) bound++;
      const end = balancedEnd(cmd.slice(i, bound), 0, '{', '}');
      if (end < 0 && bound - i >= BRACE_LIST_MAX) return incomplete();
      const body = end > 0 ? cmd.slice(i + 1, i + end - 1) : '';
      if (end > 0 && !/\s/.test(body) && (body.includes(',') || body.includes('..'))) {
        expansion(cmd.slice(i, i + end));
        i += end;
        continue;
      }
      text('{');
      i++;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && cmd[i + 1] === '>')) {
      // `2>file`: digits written right before the operator name a descriptor, not an argument.
      if (word !== null && /^\d+$/.test(plainText(word) ?? '')) word = null;
      endWord();
      if (cmd[i + 1] === '(') {
        // Process substitution: the shell passes a path in its place, never option text. The
        // word keeps its own text as a stand-in.
        const end = balancedEnd(cmd, i + 1, '(', ')');
        if (end < 0) return incomplete();
        text(cmd.slice(i, end));
        i = end;
        continue;
      }
      if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
        const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(cmd.slice(i));
        if (m) {
          heredocs.push({ delimiter: m[2] ?? m[3] ?? m[4] ?? '', tabs: m[1] === '-' });
          i += m[0].length;
          continue;
        }
      }
      while (i < cmd.length && /[<>&|]/.test(cmd[i]!)) i++;
      // `2>&1`, `>&-`: the target is a descriptor, already consumed; otherwise the next word is.
      if (/[0-9-]/.test(cmd[i] ?? '') && cmd[i - 1] === '&') { while (i < cmd.length && /[0-9-]/.test(cmd[i]!)) i++; continue; }
      dropNextWord = true;
      continue;
    }
    if (c === '|' || c === ';' || c === '&' || c === '(' || c === ')') { endCommand(); i++; continue; }
    text(c);
    i++;
  }
  endCommand();
  return commands;
}

/** curl's short options that take the next word (or the rest of their own word) as a value. */
const CURL_SHORT_WITH_VALUE = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz');
/**
 * curl's long options that take a value. Only a value of an option listed here is skipped; an
 * option that is not listed leaves the next word to be read as an argument. A missing entry can
 * shift which word is read as a value further on; the regex rules still read the written text.
 */
const CURL_LONG_WITH_VALUE = new Set([
  '--abstract-unix-socket', '--alt-svc', '--aws-sigv4', '--cacert', '--capath', '--cert', '--cert-type',
  '--ciphers', '--config', '--connect-timeout', '--connect-to', '--continue-at', '--cookie', '--cookie-jar',
  '--crlfile', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--delegation',
  '--dns-servers', '--doh-url', '--dump-header', '--ech', '--egd-file', '--engine', '--etag-compare', '--etag-save',
  '--expect100-timeout', '--form', '--form-string', '--ftp-account', '--ftp-alternative-to-user', '--ftp-method',
  '--ftp-port', '--ftp-ssl-ccc-mode', '--happy-eyeballs-timeout-ms', '--haproxy-clientip', '--header',
  '--hostpubmd5', '--hostpubsha256', '--hsts', '--interface', '--ip-tos', '--ipfs-gateway', '--json',
  '--keepalive-cnt', '--keepalive-time', '--key', '--key-type', '--krb', '--libcurl', '--limit-rate',
  '--local-port', '--login-options', '--mail-auth', '--mail-from', '--mail-rcpt', '--max-filesize',
  '--max-redirs', '--max-time', '--netrc-file', '--noproxy', '--oauth2-bearer', '--output', '--output-dir',
  '--pass', '--pinnedpubkey', '--preproxy', '--proto', '--proto-default', '--proto-redir', '--proxy',
  '--proxy-cacert', '--proxy-capath', '--proxy-cert', '--proxy-cert-type', '--proxy-ciphers', '--proxy-crlfile',
  '--proxy-header', '--proxy-key', '--proxy-key-type', '--proxy-pass', '--proxy-pinnedpubkey',
  '--proxy-service-name', '--proxy-tls13-ciphers', '--proxy-tlsauthtype', '--proxy-tlspassword',
  '--proxy-tlsuser', '--proxy-user', '--proxy1.0', '--pubkey', '--quote', '--random-file', '--range',
  '--rate', '--referer', '--request', '--request-target', '--resolve', '--retry', '--retry-delay',
  '--retry-max-time', '--sasl-authzid', '--service-name', '--socks4', '--socks4a', '--socks5',
  '--socks5-gssapi-service', '--socks5-hostname', '--speed-limit', '--speed-time', '--stderr',
  '--telnet-option', '--tftp-blksize', '--time-cond', '--tls-max', '--tls13-ciphers', '--tlsauthtype',
  '--tlspassword', '--tlsuser', '--trace', '--trace-ascii', '--trace-config', '--unix-socket',
  '--upload-file', '--url', '--url-query', '--user', '--user-agent', '--variable', '--write-out',
]);

const CURL_UNREADABLE = 'HTTP request with an option the guard cannot read (shell expansion)';

/** The text of a word the shell takes as written, or null when an expansion is part of it. */
function plainText(word: WordPart[]): string | null {
  let out = '';
  for (const part of word) {
    if (part.kind === 'expansion') return null;
    out += part.text;
  }
  return out;
}

/**
 * Can this expansion, standing where an argument starts, put an option there that the command
 * text does not show? A command substitution can; so can `${…}` with an operator whose text
 * starts a word with `-` (`${X:--d}`), a locale string (`$"-d"`), a brace list, a positional
 * parameter once `set` appears, an indirection (`${!x}` names `x` without a `$`, which counts as
 * setting it), and a variable the command itself sets, unless every setting is a plain value that
 * does not start with `-`. A variable the command never names comes from the environment the
 * engine builds for every call (each runs in a fresh shell), which the command does not control,
 * unless the command reads shell text from elsewhere (`.`, `source`, `eval`).
 */
function expansionCanPlaceOption(source: string, ctx: CurlReading): boolean {
  if (source.startsWith('$(') || source.startsWith('`') || source.startsWith('{')) return true;
  if (source.startsWith('$"')) return /^\$"\s*-/.test(source);
  if (source.startsWith('$[')) return false;
  const inner = source.startsWith('${') ? source.slice(2, -1) : source.slice(1);
  const name = /^[!#]?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(inner);
  if (!name) return true;
  const rest = inner.slice(name[0].length);
  if (rest !== '' && !/^\[[^\]]*\]$/.test(rest)) {
    // An operator: its default, alternative or replacement text is what may come out.
    if (/[$`]/.test(rest)) return true;
    if (/(^|[:=+?/#%^,\s-])-/.test(rest.replace(/^\[[^\]]*\]/, '').replace(/^:?[-=+?]/, ' ').replace(/^\/\/?/, ' '))) return true;
  }
  const id = name[1]!;
  // Each name is looked up once per command: a command that repeats one expansion thousands of
  // times must not scan itself once per repetition.
  const key = /^[A-Za-z_]/.test(id) ? id : ' positional';
  let known = ctx.known.get(key);
  if (known === undefined) {
    known = key === ' positional' ? /\bset\b/.test(ctx.cmd) : variableSetByCommand(id, ctx);
    ctx.known.set(key, known);
  }
  return known;
}

/**
 * One reading of a command: what is known about each name, and how much more of the command
 * the name lookups may read. Each lookup scans the whole command and reads the value of every
 * assignment to the name, so a crafted command with many names or many assignments would cost
 * the square of its length. The budget bounds these lookups, not the rest of the reading. Past
 * it a name counts as set by the command, which asks.
 */
interface CurlReading { cmd: string; known: Map<string, boolean>; budget: number }

/**
 * A command that reads shell text from elsewhere (`.`, `source`, `eval`, `set -a`) can set any
 * variable without naming it. `[ \t]*`, not `\s*`: a newline is itself where a command starts, and
 * `\s*` would read every newline run again from each newline in it.
 */
const READS_SHELL_TEXT = /(?:^|[;&|(`\n]|\$\()[ \t]*(?:source|\.|eval|set\s+-[a-z]*a)(?=\s)/;

const CURL_READ_BUDGET_FACTOR = 32;
const CURL_READ_BUDGET_MIN = 4_000_000;

/**
 * Does the command set `id` itself? Any mention of the name other than as `$id` / `${id}` counts
 * (`read id`, `for id in`, `printf -v id`, `export id`), except an assignment `id=value` whose
 * value is plain text that does not start with `-`.
 */
function variableSetByCommand(id: string, ctx: CurlReading): boolean {
  const { cmd } = ctx;
  if (READS_SHELL_TEXT.test(cmd)) return true;
  ctx.budget -= cmd.length;
  if (ctx.budget < 0) return true;
  const mention = new RegExp(String.raw`(^|[^$\w{])${id}\b`, 'g');
  for (const m of cmd.matchAll(mention)) {
    const at = m.index + m[1]!.length + id.length;
    if (cmd[at] !== '=') return true;
    const rest = cmd.slice(at + 1, at + 1 + 4096);
    ctx.budget -= rest.length;
    if (ctx.budget < 0) return true;
    if (rest === '' || /^[\s;&|)]/.test(rest)) continue;
    const value = readCommandWords(rest)[0]?.words[0];
    const plain = value ? plainText(value) : null;
    if (plain === null || plain.startsWith('-')) return true;
  }
  return false;
}

/** The text before a word's first expansion, and whether it has one. */
function leadingText(word: WordPart[]): { lead: string; expanded: boolean } {
  let lead = '';
  for (const part of word) {
    if (part.kind === 'expansion') return { lead, expanded: true };
    lead += part.text;
  }
  return { lead, expanded: false };
}

const SAFE_METHOD = /^(?:GET|HEAD|OPTIONS)$/;

/**
 * The curl option a word holds, read the way curl would: a label when it sends data or changes
 * the method, or when an expansion inside it supplies option text; `value-next` when it takes
 * the next word as its value; null otherwise.
 */
function curlOptionVerdict(word: WordPart[], next: WordPart[] | undefined): { label: string } | 'value-next' | null {
  const { lead, expanded } = leadingText(word);
  if (!lead.startsWith('-')) return null;
  if (lead === '-') return expanded ? { label: CURL_UNREADABLE } : null;
  if (lead.startsWith('--')) {
    const eq = lead.indexOf('=');
    if (eq < 0 && expanded) return { label: CURL_UNREADABLE };
    const name = eq < 0 ? lead : lead.slice(0, eq);
    if (/^--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|upload-file|json|config)$/.test(name)) return { label: 'HTTP data submission via curl' };
    if (name === '--request') {
      const method = eq >= 0 ? (expanded ? null : lead.slice(eq + 1)) : (next ? plainText(next) : '');
      if (method === null || !SAFE_METHOD.test(method)) return { label: 'HTTP mutation via curl' };
      return eq < 0 ? 'value-next' : null;
    }
    return eq < 0 && CURL_LONG_WITH_VALUE.has(name) ? 'value-next' : null;
  }
  const letters = lead.slice(1);
  for (let k = 0; k < letters.length; k++) {
    const letter = letters[k]!;
    if ('dFTK'.includes(letter)) return { label: 'HTTP data submission via curl' };
    const attached = k + 1 < letters.length || expanded;
    if (letter === 'X') {
      const method = attached ? (expanded ? null : letters.slice(k + 1)) : (next ? plainText(next) : '');
      if (method === null || !SAFE_METHOD.test(method)) return { label: 'HTTP mutation via curl' };
      return attached ? null : 'value-next';
    }
    if (CURL_SHORT_WITH_VALUE.has(letter)) return attached ? null : 'value-next';
  }
  // The letters ran out before an expansion: the expansion supplies more options.
  return expanded ? { label: CURL_UNREADABLE } : null;
}

/**
 * A curl invocation whose arguments, read as the shell splits them, carry an option that sends
 * data or changes the method, or an option the command text does not show because an expansion
 * puts it there. Read alongside the regex rules, never instead of them: they still read the
 * written text, so this only adds to what is asked about.
 */
export function curlOptionFromWords(rawCmd: string): { label: string } | null {
  const cmd = normalizeCommand(rawCmd);
  const ctx: CurlReading = { cmd, known: new Map(), budget: Math.max(CURL_READ_BUDGET_MIN, CURL_READ_BUDGET_FACTOR * cmd.length) };
  for (const { words, complete } of readCommandWords(cmd)) {
    for (let w = 0; w < words.length; w++) {
      const name = plainText(words[w]!);
      if (name === null || !/(?:^|\/)curl$/i.test(name)) continue;
      let valueNext = false;
      let a = w + 1;
      for (; a < words.length; a++) {
        const word = words[a]!;
        if (valueNext) { valueNext = false; continue; }
        if (plainText(word) === '--') break;
        const verdict = curlOptionVerdict(word, words[a + 1]);
        if (verdict === 'value-next') { valueNext = true; continue; }
        if (verdict) return verdict;
        // Leading expansions: what they can put there, and what an empty one moves to the front.
        let p = 0;
        while (p < word.length && (word[p]!.kind === 'expansion' || (word[p] as { text: string }).text === '')) {
          const part = word[p]!;
          if (part.kind === 'expansion' && expansionCanPlaceOption(part.source, ctx)) return { label: CURL_UNREADABLE };
          p++;
        }
        const after = word[p];
        if (p > 0 && after?.kind === 'text' && after.text.startsWith('-')) return { label: CURL_UNREADABLE };
      }
      // The words up to where this curl's arguments ended were read; go on after them, so each
      // word is read once. After a `--` the words are read again as possible commands.
      w = a;
    }
    if (!complete && /\bcurl\b/i.test(cmd)) return { label: CURL_UNREADABLE };
  }
  return null;
}

// Build the per-chunk scan surface: the normalized form, the quote-removed
// form the shell actually executes (`r''m -rf /` → `rm -rf /`), and both split
// into segments so cross- and intra-segment patterns are all covered. With
// `withVariants`, it is the same surface read with the options before each
// subcommand dropped instead (see withoutLeadingOptions). A command whose lines
// the shell joins is read a second time with them joined (joinLineContinuations):
// a rule that reads one line (`.` stops at a line break) and every segment (split
// at each break) would otherwise see the options of the next line without their
// command. The written form is still read, so this only adds surface.
function _bashScanSegments(chunk: string, withVariants: boolean): string[] {
  const joined = joinLineContinuations(chunk);
  const surface = _bashScanSurface(chunk, withVariants);
  return joined === chunk ? surface : [...surface, ..._bashScanSurface(joined, withVariants)];
}

function _bashScanSurface(chunk: string, withVariants: boolean): string[] {
  const normalized = normalizeCommand(chunk);
  const stripped = stripShellQuotes(normalized);
  const segments = splitCommandSegments(normalized);
  // Only re-split the stripped form when stripping changed something (no extra
  // work for the common unquoted command).
  const strippedSegments = stripped !== normalized ? splitCommandSegments(stripped) : [];
  const all = [...segments, ...strippedSegments];
  if (!withVariants) return [normalized, stripped, ...all];
  // The whole chunk too: a segment ends at every line break, an escaped one included.
  const wholes = stripped !== normalized ? [normalized, stripped] : [normalized];
  // Each text once: a chunk without a separator is its own only segment.
  const texts = [...new Set([...wholes, ...all])];
  optionTextsRead += texts.length;
  return texts.flatMap(withoutLeadingOptions);
}

/** How many texts the scan has read with options dropped, the costly reading. */
let optionTextsRead = 0;
/** Exported for tests: counted, not timed. */
export function _optionTextsRead(): number {
  return optionTextsRead;
}

// Overlapping scan windows. Several danger patterns backtrack (multiple `.*`),
// so a single full-length pass is O(n²) on crafted input — hence the window
// bound. But the previous head(10K)+tail(2K) sampling left the MIDDLE of a long
// command unscanned while the executor ran it in full, so an `rm -rf /` at
// offset ~15K evaded the guard entirely. Scan the WHOLE command in bounded
// overlapping windows instead (mirrors output-guard's checkWriteContent). The
// overlap exceeds any realistic dangerous one-liner, so a command straddling a
// window boundary is still caught intact in an adjacent window.
const BASH_SCAN_WINDOW = MAX_CMD_CHECK_LEN;
const BASH_SCAN_OVERLAP = 2_000;

/** The scan surface of one window of a command, by its start and whether options are dropped. */
type BashSurfaces = (start: number, withVariants: boolean) => string[];

/**
 * The surfaces of one command, each built once when first read: every list reads the same
 * windows of the same command, and building a surface with options dropped costs more than
 * reading it.
 */
function bashSurfaces(rawCmd: string): BashSurfaces {
  const built = new Map<string, string[]>();
  return (start, withVariants) => {
    const key = `${start}:${withVariants}`;
    let surface = built.get(key);
    if (!surface) {
      surface = _bashScanSegments(rawCmd.length <= BASH_SCAN_WINDOW ? rawCmd : rawCmd.slice(start, start + BASH_SCAN_WINDOW), withVariants);
      built.set(key, surface);
    }
    return surface;
  };
}

function _scanBashDanger(
  rawCmd: string,
  patterns: ReadonlyArray<{ pattern: RegExp; label: string; matches?: (segment: string) => boolean }>,
  surfaces: BashSurfaces = bashSurfaces(rawCmd),
): { label: string } | null {
  // The command as written, in every window, before any reading with options dropped: a
  // variant only adds surface, so it must not put its label in front of a plain hit.
  for (const withVariants of [false, true]) {
    if (rawCmd.length <= BASH_SCAN_WINDOW) {
      const hit = _checkPatterns(surfaces(0, withVariants), patterns);
      if (hit) return hit;
      continue;
    }
    for (let start = 0; start < rawCmd.length; start += BASH_SCAN_WINDOW - BASH_SCAN_OVERLAP) {
      const hit = _checkPatterns(surfaces(start, withVariants), patterns);
      if (hit) return hit;
    }
  }
  return null;
}

/** Text the agent wrote, interpolated into a danger prompt (see {@link agentText}). */
interface AgentText { readonly agentText: string }
/** The system's own text, interpolated into a danger prompt (see {@link system}). */
interface SystemText { readonly systemText: string }

/**
 * Mark text the agent wrote (the first line of a bash command, a path) for a danger prompt. The
 * person is shown it as a value, on one line (a line break in a path would start a line of its
 * own in the dialog), with `\` and `"` escaped (a `"` in it would close the quotes the prompt puts
 * around it). A path is shown whole; its end is what names the file. The audit gets the text as
 * the agent wrote it.
 */
function agentText(text: string): AgentText {
  return { agentText: text };
}

/** Mark the system's own text for a danger prompt: a tool name, a label from a fixed list, what a tool's own check returns. */
function system(text: string): SystemText {
  return { systemText: text };
}

/** `\` and `"` escaped, so the quotes around a value are the prompt's own. */
function quoted(text: string): string {
  return text.replace(/[\\"]/g, (c) => `\\${c}`);
}

/** A danger as `_detectDanger` returns it: the prompt the person is asked with, the warning, and
 *  whether it is a hard block (see {@link hardBlock}). */
interface Danger { prompt: PromptText; warning: string; hardBlock?: true }

/**
 * Mark a danger as a hard block: an unattended run may never do this, and nobody approves it
 * later from a queue (`DangerSignal.hardBlock`). Set where the rule decides, never read off the
 * text: `[BLOCKED` also marks the actions that ask for an OK (mail, a destructive tool, HTTP
 * DELETE), and those stay askable.
 */
function hardBlock(danger: Danger): Danger {
  return { ...danger, hardBlock: true };
}

/**
 * Mark an unattended `[BLOCKED` as one that asks for an OK: a person may approve it, from a queue
 * too. It changes nothing at run time; it says the rule was classified. Every `[BLOCKED` return is
 * either {@link hardBlock} or this, and a test holds that, so a new rule cannot fall into the
 * askable class by being left unmarked.
 */
function askable(danger: Danger): Danger {
  return danger;
}

/**
 * The danger prompts' template. Every interpolation says who wrote it, by type: {@link agentText}
 * becomes a value in `prompt`, {@link system} frame. A bare interpolation does not compile, so
 * each one is marked by hand; marking the agent's text with `system` is not caught here. `warning` is the same text with the
 * agent's part as it was written, for the audit and the `[BLOCKED` checks.
 */
function framed(strings: TemplateStringsArray, ...values: ReadonlyArray<AgentText | SystemText>): Danger {
  const prompt = pv(strings, ...values.map((v) => ('agentText' in v
    ? promptValue(quoted(singleLine(v.agentText)))
    : { [PROMPT_TEXT_BRAND]: true as const, segments: promptSegments(v.systemText) })));
  let warning = strings[0] ?? '';
  values.forEach((v, i) => { warning += ('agentText' in v ? v.agentText : v.systemText) + (strings[i + 1] ?? ''); });
  return { prompt, warning };
}

/** How a rule below reads an input field as a file path: the field's name and its value. Every
 *  rule that judges a path reads it through this, so `pathFieldsRead` can name those fields. */
type AsPath = (field: string, value: string) => string;
const asIs: AsPath = (_field, value) => value;
/** Relative, inside any project, matching no sensitive pattern: a path no rule objects to. */
const PATH_STAND_IN = 'lynox-path-stand-in';

/**
 * The input fields of this call that the checks below read as a file path, found by running
 * them: each path a rule reads is recorded and handed a harmless stand-in, so no path ends a
 * rule early and hides a field read after it. A rule added later that reads a path is in the
 * answer without being named here.
 */
export function pathFieldsRead(toolName: string, input: unknown, autonomy?: AutonomyLevel, entry?: ToolEntry): string[] {
  const fields = new Set<string>();
  _detectDanger(toolName, input, autonomy, entry, null, (field) => { fields.add(field); return PATH_STAND_IN; });
  return [...fields];
}

function _detectDanger(toolName: string, input: unknown, autonomy?: AutonomyLevel, entry?: ToolEntry, parentProvider?: ProviderConfigSnapshot | null, asPath: AsPath = asIs): Danger | null {
  if (toolName === 'bash' && input && typeof input === 'object' && 'command' in input) {
    const rawCmd = String((input as { command: unknown }).command);

    // Short preview for user display (first line, max 80 chars)
    const firstLine = rawCmd.split('\n')[0]!;
    const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;

    // One pass per class, strictest first, each over the whole command: in a chain, the
    // strictest rule any segment matches decides, wherever that segment stands.
    const surfaces = bashSurfaces(rawCmd);
    if (autonomy === 'autonomous') {
      const hit = _scanBashDanger(rawCmd, CRITICAL_BASH, surfaces);
      if (hit) {
        return hardBlock(framed`⚠ ${system(toolName)}: ${system(hit.label)} — "${agentText(preview)}" [BLOCKED — this action needs to be run manually for safety]`);
      }
      const ask = _scanBashDanger(rawCmd, SENDS_OR_KEEPS_BASH, surfaces) ?? _scanBashDanger(rawCmd, UNATTENDED_ASK_BASH, surfaces) ?? curlOptionFromWords(rawCmd);
      if (ask) {
        return framed`⚠ ${system(toolName)}: ${system(ask.label)} — "${agentText(preview)}"`;
      }
      return null;
    }

    // In a chat everything an unattended run blocks is asked about too: a rule that stops a run
    // no one watches must not pass silently where someone could have been asked. Lists in turn,
    // not merged: a merged list would let a rule on an earlier segment take the label of a
    // stricter rule on a later one.
    const hit = _scanBashDanger(rawCmd, CRITICAL_BASH, surfaces) ?? _scanBashDanger(rawCmd, DANGEROUS_AFTER_CRITICAL_BASH, surfaces) ?? _scanBashDanger(rawCmd, SENDS_OR_KEEPS_BASH, surfaces) ?? curlOptionFromWords(rawCmd);
    if (hit) {
      return framed`⚠ ${system(toolName)}: ${system(hit.label)} — "${agentText(preview)}"`;
    }
  }

  if (toolName === 'read_file' && input && typeof input === 'object' && 'path' in input) {
    const rawPath = resolve(asPath('path', String((input as { path: unknown }).path)));
    const filePath = resolveRealPath(rawPath);
    for (const pattern of SENSITIVE_PATHS) {
      // Check both raw (pre-symlink) and resolved path — /etc/ → /private/etc/ on macOS
      if (pattern.test(rawPath) || pattern.test(filePath)) {
        if (autonomy === 'autonomous') {
          return hardBlock(framed`⚠ ${system(toolName)}: read sensitive path — "${agentText(filePath)}" [BLOCKED — this path contains system or security files]`);
        }
        return framed`⚠ ${system(toolName)}: read sensitive path — "${agentText(filePath)}" — this path contains system or security files`;
      }
    }
  }

  if (toolName === 'write_file' && input && typeof input === 'object' && 'path' in input) {
    const filePath = resolveRealPath(asPath('path', String((input as { path: unknown }).path)));
    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.test(filePath)) {
        if (autonomy === 'autonomous') {
          return hardBlock(framed`⚠ ${system(toolName)}: write to sensitive path — "${agentText(filePath)}" [BLOCKED — this path contains system or security files]`);
        }
        return framed`⚠ ${system(toolName)}: write to sensitive path — "${agentText(filePath)}" — this path contains system or security files`;
      }
    }
    // Overwriting an existing file with empty content destroys it (rm bypass)
    const content = (input as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim() === '') {
      if (autonomy === 'autonomous') {
        return hardBlock(framed`⚠ ${system(toolName)}: overwrite with empty content — "${agentText(filePath)}" [BLOCKED]`);
      }
      return framed`⚠ ${system(toolName)}: overwrite file with empty content — "${agentText(filePath)}"`;
    }
    // In autonomous mode without workspace, restrict writes to project directory
    if (autonomy === 'autonomous' && !isWorkspaceActive()) {
      const cwd = resolveRealPath(process.cwd());
      if (!isPathWithin(filePath, cwd)) {
        return hardBlock(framed`⚠ ${system(toolName)}: write outside project directory — "${agentText(filePath)}" [BLOCKED — I can only write files within the current project]`);
      }
    }
  }

  if (toolName === 'batch_files' && input && typeof input === 'object') {
    const obj = input as { directory?: unknown; operation?: unknown; destination?: unknown };
    const dirRaw = typeof obj.directory === 'string' ? resolve(asPath('directory', obj.directory)) : '';
    const dirPath = dirRaw ? resolveRealPath(dirRaw) : '';

    if (dirPath) {
      for (const pattern of [...SENSITIVE_PATHS, LYNOX_DIR]) {
        if (pattern.test(dirRaw) || pattern.test(dirPath)) {
          if (autonomy === 'autonomous') {
            return hardBlock(framed`⚠ ${system(toolName)}: operate in sensitive directory — "${agentText(dirPath)}" [BLOCKED]`);
          }
          return framed`⚠ ${system(toolName)}: operate in sensitive directory — "${agentText(dirPath)}"`;
        }
      }
    }

    if (obj.operation === 'move' && typeof obj.destination === 'string') {
      const destRaw = resolve(asPath('destination', obj.destination));
      const destPath = resolveRealPath(destRaw);
      for (const pattern of [...SENSITIVE_PATHS, LYNOX_DIR]) {
        if (pattern.test(destRaw) || pattern.test(destPath)) {
          if (autonomy === 'autonomous') {
            return hardBlock(framed`⚠ ${system(toolName)}: move into sensitive path — "${agentText(destPath)}" [BLOCKED]`);
          }
          return framed`⚠ ${system(toolName)}: move files into sensitive path — "${agentText(destPath)}"`;
        }
      }

      const cwd = resolveRealPath(process.cwd());
      if (!isPathWithin(destPath, cwd)) {
        if (autonomy === 'autonomous') {
          return hardBlock(framed`⚠ ${system(toolName)}: move destination outside project — "${agentText(destPath)}" [BLOCKED]`);
        }
        return framed`⚠ ${system(toolName)}: move destination outside project — "${agentText(destPath)}"`;
      }
    }
  }

  // Mail (provider-agnostic IMAP/SMTP) write tools — block in autonomous mode.
  // In interactive mode, the ToolEntry.requiresConfirmation flag causes the
  // agent to skip this generic warning (the tool shows its own email preview).
  const MAIL_WRITE_TOOLS = new Set(['mail_send', 'mail_reply', 'mail_connect']);
  if (MAIL_WRITE_TOOLS.has(toolName)) {
    if (autonomy === 'autonomous') {
      return askable(framed`⚠ ${system(toolName)} [BLOCKED — connecting/sending mail needs your OK]`);
    }
    return toolName === 'mail_connect' ? framed`⚠ ${system(toolName)} — connects a mailbox` : framed`⚠ ${system(toolName)} — sends external mail`;
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
    const detail = check ? check(input, { autonomy, parentProvider }) : '';
    if (detail !== null) {
      // A WarningPayload carries its OWN fully-formed GO message (spawn-agent
      // deep-tier consent: tier + cost + provider). Render it verbatim — the
      // generic "modifies external data" label is the wrong framing for a
      // cost-consent gate. Plain-string checks (the action-label suffix used by
      // google_drive etc.) keep their existing wrapped form below. A payload
      // returned in autonomous mode is also rendered verbatim; in practice the
      // spawn check returns null in autonomous (the handler clamps instead), so
      // this branch is reached only interactively.
      if (typeof detail !== 'string') {
        return framed`${system(detail.message)}`;
      }
      const suffix = detail ? `: ${detail}` : '';
      if (autonomy === 'autonomous') {
        const blockReason = mode === 'data'
          ? '[BLOCKED — destructive data operation needs your OK]'
          : '[BLOCKED — I need your OK before doing this]';
        return askable(framed`⚠ ${system(toolName)}${system(suffix)} ${system(blockReason)}`);
      }
      const label = mode === 'data' ? 'destroys stored data' : 'modifies external data';
      return framed`⚠ ${system(toolName)}${system(suffix)} — ${system(label)}`;
    }
  }

  // http_request write methods — block DELETE in autonomous mode
  if (toolName === 'http_request' && input && typeof input === 'object') {
    // The EFFECTIVE method (`core/outbound-write.ts`): a POST with an override DELETE, or a GET
    // with `?_method=DELETE` (or a `_method` field in its body), is held to what a server that
    // honours the override does. An override that is not a method is refused by the tool
    // itself; here it counts as a write.
    const req = input as { method?: unknown; headers?: unknown; url?: unknown; body?: unknown };
    const headers = req.headers !== null && typeof req.headers === 'object'
      ? Object.fromEntries(Object.entries(req.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {};
    const method = effectiveWriteMethod(String(req.method ?? 'GET'), headers, String(req.url ?? ''), typeof req.body === 'string' ? req.body : undefined) ?? 'OVERRIDE';
    if (method === 'DELETE') {
      if (autonomy === 'autonomous') {
        return askable(framed`⚠ ${system(toolName)}: HTTP DELETE [BLOCKED — destructive operation]`);
      }
    }
    // Block write methods in autonomous mode — can send emails, create invoices, modify records.
    // No [BLOCKED] marker, so a person can allow it and a capability contract can grant it.
    //
    // The READS are enumerated here, not the writes, for the reason `undoClassFor` in
    // `tools/builtin/http.ts` spells out: a list of writes leaves a verb nobody listed
    // unwarned, and this branch was the last place that still needed the schema enum to
    // make that unreachable. DELETE never arrives here in autonomous mode — the branch
    // above returns for it.
    if (!['GET', 'HEAD'].includes(method) && autonomy === 'autonomous') {
      return framed`⚠ ${system(toolName)}: HTTP ${system(method)} — write operation, needs your OK`;
    }
  }

  // spawn_agent: scan task + context for injection patterns in autonomous mode
  if (toolName === 'spawn_agent' && autonomy === 'autonomous' && input && typeof input === 'object' && 'agents' in input) {
    const agentSpecs = (input as { agents?: Array<{ task?: string; context?: string }> }).agents;
    for (const spec of agentSpecs ?? []) {
      const combined = [spec.task, spec.context].filter(Boolean).join('\n');
      const injection = detectInjectionAttempt(combined);
      if (injection.detected) {
        return framed`⚠ ${system(toolName)}: spawn task contains suspicious patterns (${system(injection.patterns.join(', '))}). Review needed.`;
      }
    }
  }

  return null;
}
