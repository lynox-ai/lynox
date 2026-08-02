import { assertHostPolicy, type HostPolicyContext } from '../../core/network-guard.js';

/**
 * Bring `bash` under the configured `network_policy`.
 *
 * The gap this closes (found 2026-08-02 in a real thread): `network_policy`
 * gates `http_request`, `api_setup` and `web_research` — every agent HTTP
 * surface EXCEPT the shell. In one thread the agent's `http_request` to
 * `http://localhost:3000/api/voice/info` was correctly refused ("points to an
 * internal network") and it then made 39 successful fetches with `bash` +
 * `curl`/`wget` in the same conversation, unpoliced. `deny-all` is documented as
 * "air-gapped isolation"; a shell that can still reach the network makes that
 * promise false.
 *
 * ## What this is NOT
 *
 * It is NOT a sandbox and must never be described as one. You cannot reliably
 * stop egress from a shell by reading the command string — `python3 -c
 * "urllib..."`, `node -e`, `/dev/tcp`, a base64'd script, or a URL assembled
 * from variables all walk past it. Real enforcement is a network namespace, and
 * that is a different piece of work.
 *
 * What it does stop is the case actually observed: an agent that takes the easy
 * path. The GLM run reached for `curl`, and when that was refused reached for
 * `wget` — fifteen times with different flags. It was not evading a guard; there
 * was no guard. A confused or prompt-injected agent is the threat model here,
 * not a determined attacker with shell access, and against that a refusal that
 * names the right tool is worth more than nothing.
 *
 * ## Why `allow-all` is left completely alone
 *
 * `allow-all` is the default for every self-hoster, and under it this function
 * returns before touching anything. Routing bash through `assertHostPolicy`
 * unconditionally would ALSO inherit its private-IP check and break
 * `curl localhost:3000` in a dev shell — a real regression for a promise
 * `allow-all` never made. The asymmetry that remains under the default
 * (`http_request` refuses localhost, `bash` does not) is deliberate:
 * `http_request` fetches a URL the model chose and is the confused-deputy
 * surface, while a shell that cannot reach localhost is barely a shell.
 */

/**
 * Flags that turn off TLS certificate verification.
 *
 * `needsCurl` exists because `-k` is not a TLS flag in general — it is a TLS
 * flag *to curl*. `du -k`, `df -k`, `sort -k 2`, `tar -k` and `ls -k` are all
 * ordinary commands, and since the TLS check runs under EVERY policy, an
 * unscoped `-k` pattern would refuse them on a default instance. (It did: the
 * first version of this file shipped exactly that and a delta round on the fix
 * caught it. Kept as a named field rather than folded into the regex so the
 * next flag added has to answer the same question.)
 *
 * The others are unambiguous — `--no-check-certificate` is wget's,
 * `--insecure` is scoped to curl for the same reason as `-k` even though it is
 * rarer elsewhere, and the two env vars name their own product.
 */
const TLS_BYPASS_FLAGS: ReadonlyArray<{ re: RegExp; flag: string; needsCurl?: true }> = [
  { re: /(^|\s)--no-check-certificate(\s|=|$)/, flag: '--no-check-certificate' }, // wget
  { re: /(^|\s)--insecure(\s|$)/, flag: '--insecure', needsCurl: true },
  { re: /(^|\s)-k(\s|$)/, flag: '-k', needsCurl: true },
  { re: /(^|\s)--no-verify-peer(\s|$)/, flag: '--no-verify-peer' },
  { re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0/, flag: 'NODE_TLS_REJECT_UNAUTHORIZED=0' },
  { re: /(^|\s)GIT_SSL_NO_VERIFY\s*=/, flag: 'GIT_SSL_NO_VERIFY' },
];

/** True iff `curl` appears in command position (same anchoring as the client list). */
const CURL_AT_COMMAND_POSITION = /(?:^|[|;&]|\$\(|`|\bsudo\s+|\benv\s+)\s*(?:\w+=\S+\s+)*curl\b/;

/**
 * Common network clients, for the `deny-all` catch-all below. Word-boundary
 * matched at a command position (start, after a pipe/semicolon/&&, or after
 * `sudo`/`env`) so a filename like `my-curl-notes.txt` does not trip it.
 */
const NETWORK_CLIENTS = [
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp',
  'rsync', 'ftp', 'lynx', 'links', 'aria2c', 'httpie', 'http', 'https',
];

const CLIENT_AT_COMMAND_POSITION = new RegExp(
  String.raw`(?:^|[|;&]|\$\(|\`|\bsudo\s+|\benv\s+)\s*(?:\w+=\S+\s+)*(${NETWORK_CLIENTS.join('|')})\b`,
);

/**
 * Every `http(s)://…` literal in the command. Stops at shell metacharacters and
 * quotes so `"https://x/y" | head` yields the URL and not the pipeline.
 * Trailing punctuation a shell would not treat as part of the URL is trimmed.
 */
export function extractUrls(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/https?:\/\/[^\s'"`;|&<>()\\]+/gi)) {
    const raw = (m[0] ?? '').replace(/[.,]+$/, '');
    if (raw.length === 0) continue;
    try {
      new URL(raw);
      out.push(raw);
    } catch {
      // Not a parseable URL (a variable-interpolated fragment, say). Nothing to
      // check — the deny-all catch-all below is what covers those.
    }
  }
  return out;
}

/** True iff the command invokes a known network client in command position. */
export function mentionsNetworkClient(command: string): boolean {
  return CLIENT_AT_COMMAND_POSITION.test(command);
}

/**
 * Throw when `command` may not run under the current egress policy.
 *
 * Order matters: the TLS check runs FIRST and under EVERY policy including
 * `allow-all`. That is a deliberate exception to "the default is untouched" and
 * the reasoning is that it is a different kind of rule — `allow-all` is a
 * statement about which hosts are reachable, not permission to disable
 * certificate verification on the way there. The observed run turned TLS
 * checking off ten-plus times as a workaround for 404s that had nothing to do
 * with TLS, which is exactly the shape of an LLM pattern-matching its way out of
 * an error. A human who genuinely needs it gets a message saying so.
 */
export function assertBashEgressAllowed(
  command: string,
  ctx: HostPolicyContext | undefined,
): void {
  for (const { re, flag, needsCurl } of TLS_BYPASS_FLAGS) {
    if (needsCurl && !CURL_AT_COMMAND_POSITION.test(command)) continue;
    if (re.test(command)) {
      throw new Error(
        `Blocked: "${flag}" disables TLS certificate verification. This is refused on every `
        + `network policy, including allow-all. If the host has a certificate problem, fix the `
        + `certificate or add the host to an API profile — do not turn verification off.`,
      );
    }
  }

  const policy = ctx?.networkPolicy;
  // The default. Deliberately untouched — see the module header.
  if (policy === undefined || policy === 'allow-all') return;

  // Literal URLs face the same gate `http_request` faces. 'full-control' is the
  // correct surface: a shell command is arbitrary-target and credential-capable,
  // which is precisely what that surface means.
  for (const url of extractUrls(command)) {
    assertHostPolicy(url, 'full-control', ctx);
  }

  // `deny-all` promises no network at all, so it cannot depend on finding a
  // literal URL — a bare host (`curl example.com`), a variable, or a URL on
  // stdin would all slip past the loop above. Refuse the client outright.
  if (policy === 'deny-all' && mentionsNetworkClient(command)) {
    throw new Error(
      'Blocked: network access denied (air-gapped isolation). This command invokes a network '
      + 'client and the instance egress policy is deny-all.',
    );
  }
}
