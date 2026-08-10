import { assertHostPolicy, type HostPolicyContext } from '../../core/network-guard.js';

/**
 * Bring `bash` under the configured `network_policy`.
 *
 * The gap this closes (found 2026-08-02 in a real thread): `network_policy`
 * gates `http_request`, `api_setup` and `web_research` — every agent HTTP
 * surface EXCEPT the shell. In that thread the agent's `http_request` to
 * `http://localhost:3000/api/voice/info` was correctly refused ("points to an
 * internal network") and the same agent then made 39 successful fetches with
 * `bash` + `curl`/`wget` in the same conversation, unpoliced. `deny-all` is
 * documented as "air-gapped isolation"; a shell that still reaches the network
 * makes that promise false.
 *
 * ## What this is NOT
 *
 * It is NOT a sandbox and must never be described as one. You cannot reliably
 * stop egress from a shell by reading the command string — `python3 -c
 * "urllib..."`, `node -e`, `/dev/tcp`, a base64'd script, or a URL assembled
 * from variables all walk past it. Real enforcement is a network namespace, and
 * that is a different piece of work.
 *
 * What it does stop is the case actually observed: an agent taking the easy
 * path. The observed run reached for `curl`, and when that 404'd reached for
 * `wget` — fifteen times with different flags. It was not evading a guard;
 * there was no guard. A confused or prompt-injected agent is the threat model,
 * not a determined attacker who already has shell access.
 *
 * ## Why this parses instead of pattern-matching
 *
 * A first version (core#1122) matched flags and URLs with regexes over the raw
 * command line and was withdrawn: an adversarial review found six holes, and
 * they were not six bugs but one. `curl -k` was refused while `curl -sk` was
 * not; `curl … | sort -k 2` was refused although the `-k` belonged to `sort`;
 * `timeout 5 curl` and `/usr/bin/curl` walked past `deny-all`; and
 * `curl https://api.github.com\.evil.example.com/x` read as `api.github.com`
 * because URL extraction stopped at the backslash the shell was about to
 * remove. Every one of them is the same root cause: flags and hosts were read
 * off a string that had not been split into commands or unescaped.
 *
 * So this file does the small amount of parsing that removes the whole class:
 * split into simple commands, resolve each command's own head binary, attribute
 * flags only to the command that owns them, and resolve shell quoting BEFORE
 * looking at a URL. It is a deliberately minimal shell reader, not a shell.
 */

/**
 * A single lexed word, as the invoked binary would receive it.
 *
 * `firstQuotedAt` is the index of the first character that came out of quotes
 * or a backslash escape (`Infinity` when the word is entirely bare). Only an
 * assignment needs it: `NODE_TLS_REJECT_UNAUTHORIZED=0` is an assignment,
 * `"NODE_TLS_REJECT_UNAUTHORIZED=0"` as a single quoted word is an argument
 * (the string a `grep` is searching FOR), and the two must not be confused —
 * the withdrawn version blocked the search and missed the assignment.
 */
interface Word {
  text: string;
  firstQuotedAt: number;
}

/** One simple command: the words between two control operators. */
interface SimpleCommand {
  words: Word[];
}

/** Splits one command into simple commands. Also `;`, `&&`, `||`, newline. */
const SEGMENT_BREAK = new Set(['|', '&', ';', '\n', '(', ')', '{', '}']);

/** Redirections break a word but not the command. */
const WORD_BREAK = new Set(['<', '>', ' ', '\t', '\r']);

/**
 * Lex a command line into simple commands, resolving quotes and escapes.
 *
 * Command substitutions (`$(…)` and backticks) are lexed as their own simple
 * commands and appended, so `echo $(curl https://evil.example)` is seen. Their
 * text is removed from the enclosing word because its value is unknowable here.
 */
export function lexCommand(command: string): SimpleCommand[] {
  const segments: SimpleCommand[] = [];
  const deferred: string[] = [];
  let words: Word[] = [];
  let buf = '';
  let firstQuotedAt = Infinity;
  let open = false;

  const markQuoted = (): void => {
    if (firstQuotedAt === Infinity) firstQuotedAt = buf.length;
  };
  const endWord = (): void => {
    if (open) words.push({ text: buf, firstQuotedAt });
    buf = '';
    firstQuotedAt = Infinity;
    open = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) segments.push({ words });
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';

    if (c === '\\') {
      const next = command[i + 1];
      if (next === undefined) { open = true; buf += '\\'; continue; }
      if (next === '\n') { i++; continue; } // line continuation
      // The shell removes the backslash and passes the bare character. This is
      // the host-smuggling case: `api.github.com\.evil.example` reaches curl as
      // `api.github.com.evil.example`, and only the resolved form may be parsed.
      open = true;
      markQuoted();
      buf += next;
      i++;
      continue;
    }

    if (c === "'") {
      open = true;
      markQuoted();
      i++;
      while (i < command.length && command[i] !== "'") { buf += command[i]; i++; }
      continue;
    }

    if (c === '"') {
      open = true;
      markQuoted();
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\') {
          const n = command[i + 1];
          // Inside double quotes a backslash escapes only these; before any
          // other character it stays literal. That asymmetry is load-bearing:
          // "…\.evil…" keeps its backslash and therefore parses differently
          // from the bare form.
          if (n === '$' || n === '`' || n === '"' || n === '\\') { buf += n; i += 2; continue; }
          if (n === '\n') { i += 2; continue; }
          buf += '\\'; i++; continue;
        }
        buf += command[i]; i++;
      }
      continue;
    }

    if (c === '`') {
      const end = command.indexOf('`', i + 1);
      const inner = end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      deferred.push(inner);
      i = end === -1 ? command.length : end;
      continue;
    }

    if (c === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')') depth--;
      }
      deferred.push(command.slice(i + 2, depth === 0 ? j - 1 : command.length));
      i = j - 1;
      continue;
    }

    if (SEGMENT_BREAK.has(c)) { endSegment(); continue; }
    if (WORD_BREAK.has(c)) { endWord(); continue; }

    open = true;
    buf += c;
  }
  endSegment();

  for (const inner of deferred) segments.push(...lexCommand(inner));
  return segments;
}

/** `NAME=value` in assignment position — the `=` must sit in the bare prefix. */
function assignmentName(word: Word): string | null {
  const eq = word.text.indexOf('=');
  if (eq <= 0 || eq >= word.firstQuotedAt) return null;
  const name = word.text.slice(0, eq);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

/**
 * Wrappers that stand in front of the real command. `deny-all` was walked past
 * by every one of these in the withdrawn version.
 */
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'setsid',
  'stdbuf', 'nice', 'ionice', 'time', 'xargs', 'proxychains', 'proxychains4',
]);

/** Wrappers that consume one non-flag operand of their own before the command. */
const WRAPPERS_WITH_OPERAND = new Set(['timeout']);

/** Shell keywords that may precede a command inside a compound statement. */
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'in']);

/**
 * Per-wrapper flags whose VALUE is the next word (`sudo -u root curl …`,
 * `nice -n 10 curl …`). This has to be per-wrapper rather than one shared set:
 * `-n` takes a value for `nice` and takes none for `sudo`, so a shared set
 * swallows the real command after one of them.
 */
const WRAPPER_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user'])],
  ['doas', new Set(['-u', '-C'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u'])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['xargs', new Set(['-n', '-P', '-I', '-d', '-s', '-L', '-a', '-E', '-e', '--max-args', '--max-procs', '--replace', '--delimiter'])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
  ['setsid', new Set([])],
  ['nohup', new Set([])],
  ['command', new Set([])],
  ['builtin', new Set([])],
  ['exec', new Set(['-a'])],
  ['proxychains', new Set(['-f'])],
  ['proxychains4', new Set(['-f'])],
]);

/** `/usr/bin/curl`, `\curl`, `"curl"` all name the same binary. */
function basename(text: string): string {
  const noEscape = text.replace(/\\/g, '');
  const slash = noEscape.lastIndexOf('/');
  return slash === -1 ? noEscape : noEscape.slice(slash + 1);
}

interface ResolvedCommand {
  /** The real head binary, wrappers and assignments peeled off. */
  head: string;
  /** Arguments belonging to THIS command — never a neighbour's. */
  args: Word[];
  /** Assignments in this command's own environment prefix. */
  assignments: Word[];
}

/**
 * Peel assignments, keywords and wrappers off a simple command to find the
 * binary that actually runs, and keep only its own arguments.
 */
export function resolveCommand(cmd: SimpleCommand): ResolvedCommand | null {
  const assignments: Word[] = [];
  let i = 0;

  for (;;) {
    const word = cmd.words[i];
    if (word === undefined) break;

    if (assignmentName(word) !== null) { assignments.push(word); i++; continue; }

    const head = basename(word.text);
    if (KEYWORDS.has(head)) { i++; continue; }

    if (WRAPPERS.has(head) || WRAPPERS_WITH_OPERAND.has(head)) {
      const valueFlags = WRAPPER_VALUE_FLAGS.get(head) ?? new Set<string>();
      i++;
      // The wrapper's own flags, plus a value where the flag takes one.
      while (i < cmd.words.length) {
        const flag = cmd.words[i];
        if (flag === undefined || !flag.text.startsWith('-')) break;
        i++;
        if (valueFlags.has(flag.text)) i++;
      }
      // `env FOO=bar curl …` — assignments between the wrapper and the command.
      while (i < cmd.words.length) {
        const maybe = cmd.words[i];
        if (maybe === undefined || assignmentName(maybe) === null) break;
        assignments.push(maybe);
        i++;
      }
      // `timeout 5 curl …` — one operand of its own.
      if (WRAPPERS_WITH_OPERAND.has(head)) {
        const operand = cmd.words[i];
        if (operand !== undefined && /^[\d.]+[smhd]?$/.test(operand.text)) i++;
      }
      continue;
    }

    return { head, args: cmd.words.slice(i + 1), assignments };
  }

  // Nothing but assignments (`FOO=bar`) — still carries an environment.
  return assignments.length > 0 ? { head: '', args: [], assignments } : null;
}

/**
 * Options whose VALUE is the next word. Without this, `curl -o -k` would read
 * `-k` as a flag when it is a filename.
 */
const CURL_VALUE_OPTIONS = new Set([
  '-o', '-d', '-H', '-X', '-u', '-A', '-e', '-b', '-c', '-F', '-T', '-x',
  '-w', '-m', '-K', '-E', '-Y', '-y', '-C', '-D', '-U', '-t', '-z', '-Z',
  '--output', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '--header', '--request', '--user', '--user-agent', '--referer', '--cookie',
  '--cookie-jar', '--form', '--upload-file', '--proxy', '--write-out',
  '--max-time', '--config', '--cert', '--key', '--url', '--connect-timeout',
  '--retry', '--range', '--resolve', '--interface',
]);

/** Network clients `deny-all` refuses outright. */
const NETWORK_CLIENTS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp',
  'rsync', 'ftp', 'lynx', 'links', 'links2', 'w3m', 'aria2c', 'httpie', 'http',
  'https', 'xh', 'wget2', 'socat',
]);

/**
 * Env assignments that switch TLS verification off, by variable name.
 * `GIT_SSL_NO_VERIFY` counts on any non-empty value; the others on a falsy one.
 */
const TLS_BYPASS_ENV: ReadonlyArray<{ name: string; disablesWhen: (v: string) => boolean }> = [
  { name: 'NODE_TLS_REJECT_UNAUTHORIZED', disablesWhen: (v) => v === '0' },
  { name: 'PYTHONHTTPSVERIFY', disablesWhen: (v) => v === '0' },
  { name: 'GIT_SSL_NO_VERIFY', disablesWhen: (v) => v !== '' && v !== '0' && v.toLowerCase() !== 'false' },
  { name: 'CURL_INSECURE', disablesWhen: (v) => v !== '' && v !== '0' },
];

/**
 * Does this command turn off TLS certificate verification?
 *
 * Flags are read only against the binary that owns them, which is the whole
 * reason this is not a regex. `-k` is a TLS flag TO CURL and nothing else:
 * `sort -k 2`, `du -k`, `tar -k` and `wget -k` (`--convert-links`) are ordinary
 * and must pass. Bundled short options are the normal way people write it, so
 * `-sk`, `-ks` and `-fsSLk` all count.
 */
export function findTlsBypass(cmd: ResolvedCommand): string | null {
  for (const word of cmd.assignments) {
    const name = assignmentName(word);
    if (name === null) continue;
    const value = word.text.slice(name.length + 1);
    for (const env of TLS_BYPASS_ENV) {
      if (env.name === name && env.disablesWhen(value)) return `${name}=${value}`;
    }
  }

  if (cmd.head === 'curl') {
    for (let i = 0; i < cmd.args.length; i++) {
      const arg = cmd.args[i];
      if (arg === undefined) continue;
      const text = arg.text;
      if (CURL_VALUE_OPTIONS.has(text)) { i++; continue; }
      if (text === '--insecure') return '--insecure';
      if (text.startsWith('--')) continue;
      // Bundled or single short options: -k, -sk, -ks, -fsSLk.
      if (/^-[A-Za-z0-9#]+$/.test(text) && text.includes('k')) return text;
    }
    return null;
  }

  if (cmd.head === 'wget' || cmd.head === 'wget2') {
    for (const arg of cmd.args) {
      if (arg.text === '--no-check-certificate') return '--no-check-certificate';
    }
    return null;
  }

  return null;
}

/**
 * URLs this command would fetch, resolved exactly as the binary receives them.
 *
 * A URL is only trusted after the shell's quoting is gone: the raw text
 * `https://api.github.com\.evil.example.com/x` parses to host `api.github.com`
 * (WHATWG reads the backslash as a path separator) while the bytes curl
 * actually gets are `https://api.github.com.evil.example.com/x`. Parsing the
 * raw form is what made that an exfiltration channel.
 */
export function extractUrls(cmd: ResolvedCommand): string[] {
  const out: string[] = [];
  for (const word of cmd.args) {
    for (const match of word.text.matchAll(/https?:\/\/[^\s'"`;|&<>]+/gi)) {
      const raw = (match[0] ?? '').replace(/[.,)\]}]+$/, '');
      if (raw.length === 0) continue;
      try {
        new URL(raw);
        out.push(raw);
      } catch {
        // Not parseable (a `$VAR` fragment, say). The deny-all client check and
        // the ambiguity check below are what cover those.
      }
    }
  }
  return out;
}

/**
 * A backslash inside the authority is read differently by different clients —
 * WHATWG ends the host at it, curl does not accept it — so the guard and the
 * binary can disagree about the destination. Refuse rather than pick a side.
 */
function hasAmbiguousAuthority(url: string): boolean {
  const afterScheme = url.slice(url.indexOf('://') + 3);
  const authority = afterScheme.split(/[/?#]/)[0] ?? '';
  return authority.includes('\\');
}

/**
 * Throw when `command` may not run under the current egress policy.
 *
 * The TLS check runs FIRST and under EVERY policy including `allow-all`. That
 * is a deliberate exception to "the default is untouched", because it is a
 * different kind of rule: `allow-all` says which hosts are reachable, not that
 * certificate verification may be switched off on the way there. The observed
 * run disabled it ten-plus times to work around 404s that had nothing to do
 * with TLS — an LLM pattern-matching its way out of an error. This is also
 * exactly where the withdrawn version hurt self-hosters, by refusing
 * `sort -k 2` on the default policy; the parser is what makes the rule safe to
 * apply that widely, so the two changes belong together.
 *
 * Everything else leaves `allow-all` completely alone. Routing bash through
 * `assertHostPolicy` unconditionally would also inherit its private-IP check
 * and break `curl localhost:3000` in a dev shell — a regression against a
 * promise `allow-all` never made.
 */
export function assertBashEgressAllowed(
  command: string,
  ctx: HostPolicyContext | undefined,
): void {
  const commands = lexCommand(command)
    .map(resolveCommand)
    .filter((c): c is ResolvedCommand => c !== null);

  for (const cmd of commands) {
    const bypass = findTlsBypass(cmd);
    if (bypass !== null) {
      throw new Error(
        `Blocked: "${bypass}" disables TLS certificate verification. This is refused under every `
        + `network policy, including allow-all. If the host has a certificate problem, fix the `
        + `certificate or add the host to an API profile — do not turn verification off.`,
      );
    }
  }

  const policy = ctx?.networkPolicy;
  if (policy === undefined || policy === 'allow-all') return;

  for (const cmd of commands) {
    // `deny-all` promises no network at all, so it cannot wait to find a
    // literal URL — a bare host (`curl example.com`), a variable, or a URL on
    // stdin would all slip past. Refuse the client itself.
    if (policy === 'deny-all' && NETWORK_CLIENTS.has(cmd.head)) {
      throw new Error(
        'Blocked: network access denied (air-gapped isolation). This command invokes a network '
        + 'client and the instance egress policy is deny-all.',
      );
    }

    for (const url of extractUrls(cmd)) {
      if (hasAmbiguousAuthority(url)) {
        throw new Error(
          `Blocked: the target host in "${url}" is ambiguous — a backslash in the host is read `
          + 'differently by different clients. Write the URL without it.',
        );
      }
      // The same gate `http_request` faces. 'full-control' is the correct
      // surface: a shell command is arbitrary-target and credential-capable,
      // which is precisely what that surface means.
      assertHostPolicy(url, 'full-control', ctx);
    }
  }
}
