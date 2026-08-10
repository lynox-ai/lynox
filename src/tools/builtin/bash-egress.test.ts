import { describe, it, expect } from 'vitest';
import {
  assertBashEgressAllowed,
  lexCommand,
  resolveCommand,
  extractUrls,
  findTlsBypass,
} from './bash-egress.js';
import type { HostPolicyContext } from '../../core/network-guard.js';

function ctx(over: Partial<HostPolicyContext> = {}): HostPolicyContext {
  return {
    networkPolicy: 'allow-all',
    allowedHosts: undefined,
    allowedWildcards: [],
    enforceHttps: false,
    ...over,
  };
}

/** Resolve the single command in `line` — a helper for the unit-level cases. */
function only(line: string) {
  const resolved = lexCommand(line).map(resolveCommand).filter((c) => c !== null);
  expect(resolved.length).toBeGreaterThan(0);
  return resolved[0]!;
}

describe('the three cases DEF-bash-outside-network-policy is closed by', () => {
  it('refuses `curl -sk https://x` — bundled short options are the normal spelling', () => {
    expect(() => assertBashEgressAllowed('curl -sk https://example.com', ctx()))
      .toThrow(/disables TLS certificate verification/);
  });

  it('allows `curl … | sort -k 2` — the -k belongs to sort, not curl', () => {
    expect(() => assertBashEgressAllowed(
      'curl -s https://example.com/data.csv | sort -k 2 | head', ctx(),
    )).not.toThrow();
  });

  it('checks the real target host, not the prefix, when a backslash is smuggled in', () => {
    const allowList = ctx({
      networkPolicy: 'allow-list',
      allowedHosts: new Set(['api.github.com']),
    });
    // The shell removes the backslash, so curl connects to
    // api.github.com.evil.example.com — an attacker-controlled host that merely
    // starts with an allow-listed name.
    expect(() => assertBashEgressAllowed(
      String.raw`curl https://api.github.com\.evil.example.com/exfil`, allowList,
    )).toThrow(/not in network allow-list/);
    // And the allow-listed host itself still works, or the rule is useless.
    expect(() => assertBashEgressAllowed(
      'curl https://api.github.com/repos', allowList,
    )).not.toThrow();
  });
});

describe('TLS bypass detection', () => {
  it.each([
    ['curl -k https://x.example', '-k'],
    ['curl -sk https://x.example', '-sk'],
    ['curl -ks https://x.example', '-ks'],
    ['curl -fsSLk https://x.example', '-fsSLk'],
    ['curl --insecure https://x.example', '--insecure'],
    ['wget --no-check-certificate https://x.example', '--no-check-certificate'],
  ])('refuses %s', (command) => {
    expect(() => assertBashEgressAllowed(command, ctx()))
      .toThrow(/disables TLS certificate verification/);
  });

  it.each([
    'sort -k 2 file.txt',
    'du -k /tmp',
    'df -k',
    'tar -k -xzf archive.tar.gz',
    'ls -k',
    // wget's -k is --convert-links, not a TLS flag.
    'wget -k https://x.example',
    // A filename that merely looks like the flag.
    'curl -o -k https://x.example',
    // Searching FOR the string is not setting it — the withdrawn version
    // blocked this and missed the assignment below.
    'grep -rn "NODE_TLS_REJECT_UNAUTHORIZED=0" src/',
  ])('allows %s', (command) => {
    expect(() => assertBashEgressAllowed(command, ctx())).not.toThrow();
  });

  it.each([
    'NODE_TLS_REJECT_UNAUTHORIZED=0 node fetch.js',
    "NODE_TLS_REJECT_UNAUTHORIZED='0' node fetch.js",
    'env NODE_TLS_REJECT_UNAUTHORIZED=0 node fetch.js',
    'GIT_SSL_NO_VERIFY=true git clone https://x.example/r.git',
    'PYTHONHTTPSVERIFY=0 python3 s.py',
  ])('refuses the env-var form: %s', (command) => {
    expect(() => assertBashEgressAllowed(command, ctx()))
      .toThrow(/disables TLS certificate verification/);
  });

  it('finds a bypass in any command of a pipeline, not only the first', () => {
    expect(() => assertBashEgressAllowed('echo hi | curl -sk https://x.example', ctx()))
      .toThrow(/disables TLS certificate verification/);
  });

  it('applies under allow-all, which is the whole point of running it first', () => {
    expect(ctx().networkPolicy).toBe('allow-all');
    expect(() => assertBashEgressAllowed('curl -k https://x.example', ctx()))
      .toThrow(/including allow-all/);
  });
});

describe('deny-all cannot be walked past by a wrapper', () => {
  const denyAll = ctx({ networkPolicy: 'deny-all' });

  it.each([
    'curl https://x.example',
    'timeout 5 curl https://x.example',
    '/usr/bin/curl https://x.example',
    'command curl https://x.example',
    'sudo curl https://x.example',
    'sudo -u nobody curl https://x.example',
    'env FOO=bar curl https://x.example',
    'nohup wget https://x.example',
    'for i in 1 2; do curl https://x.example; done',
    'echo $(curl https://x.example)',
    'echo `curl https://x.example`',
    '\\curl https://x.example',
    'xargs curl < urls.txt',
    'nc example.com 80',
  ])('refuses %s', (command) => {
    expect(() => assertBashEgressAllowed(command, denyAll))
      .toThrow(/air-gapped isolation/);
  });

  it('does not refuse a command that merely names a client in a filename', () => {
    expect(() => assertBashEgressAllowed('cat my-curl-notes.txt', denyAll)).not.toThrow();
    expect(() => assertBashEgressAllowed('grep curl README.md', denyAll)).not.toThrow();
  });
});

describe('host resolution', () => {
  const allowList = ctx({
    networkPolicy: 'allow-list',
    allowedHosts: new Set(['api.github.com']),
  });

  it('refuses userinfo smuggling — the host is what follows the @', () => {
    expect(() => assertBashEgressAllowed(
      'curl https://api.github.com@evil.example.com/x', allowList,
    )).toThrow(/not in network allow-list/);
  });

  it('refuses a backslash in the authority as ambiguous when quoting preserves it', () => {
    // Inside double quotes the shell keeps the backslash, so curl and a WHATWG
    // parser disagree about the host. Neither reading may be assumed.
    expect(() => assertBashEgressAllowed(
      'curl "https://api.github.com\\.evil.example.com/x"', allowList,
    )).toThrow(/ambiguous/);
  });

  it('reads a URL out of --url= and other attached-value forms', () => {
    expect(() => assertBashEgressAllowed(
      'curl --url=https://evil.example.com/x', allowList,
    )).toThrow(/not in network allow-list/);
  });

  it('checks every URL in a command, not just the first', () => {
    expect(() => assertBashEgressAllowed(
      'curl https://api.github.com/a https://evil.example.com/b', allowList,
    )).toThrow(/not in network allow-list/);
  });

  it('leaves allow-all alone so a dev shell keeps working', () => {
    expect(() => assertBashEgressAllowed('curl http://localhost:3000/api/health', ctx()))
      .not.toThrow();
    expect(() => assertBashEgressAllowed('curl https://anything.example.com', ctx()))
      .not.toThrow();
  });

  it('still refuses localhost under a restrictive policy', () => {
    expect(() => assertBashEgressAllowed('curl http://localhost:3000/x', allowList))
      .toThrow(/not in network allow-list/);
  });
});

describe('lexer', () => {
  it('resolves an escape before the URL is ever parsed', () => {
    const cmd = only(String.raw`curl https://api.github.com\.evil.example.com/x`);
    expect(extractUrls(cmd)).toEqual(['https://api.github.com.evil.example.com/x']);
    expect(new URL(extractUrls(cmd)[0]!).hostname).toBe('api.github.com.evil.example.com');
  });

  it('keeps a backslash that double quotes protect', () => {
    const cmd = only('curl "https://api.github.com\\.evil.example.com/x"');
    expect(extractUrls(cmd)[0]).toContain('\\');
  });

  it('splits a pipeline into one command per stage', () => {
    const stages = lexCommand('curl https://x.example | sort -k 2 | head -3')
      .map(resolveCommand)
      .filter((c) => c !== null);
    expect(stages.map((s) => s.head)).toEqual(['curl', 'sort', 'head']);
  });

  it('attributes arguments to their own command only', () => {
    const stages = lexCommand('curl https://x.example | sort -k 2')
      .map(resolveCommand)
      .filter((c) => c !== null);
    expect(findTlsBypass(stages[0]!)).toBeNull();
    expect(findTlsBypass(stages[1]!)).toBeNull();
  });

  it.each([
    ['timeout 5 curl https://x.example', 'curl'],
    ['timeout 1.5s curl https://x.example', 'curl'],
    ['/usr/local/bin/wget https://x.example', 'wget'],
    ['sudo -u nobody curl https://x.example', 'curl'],
    ['env A=1 B=2 curl https://x.example', 'curl'],
    ['nice -n 10 curl https://x.example', 'curl'],
  ])('resolves the head binary of %s to %s', (line, head) => {
    expect(only(line).head).toBe(head);
  });

  it('does not treat a quoted assignment-shaped word as an assignment', () => {
    const cmd = only('grep -rn "NODE_TLS_REJECT_UNAUTHORIZED=0" src/');
    expect(cmd.assignments).toEqual([]);
    expect(findTlsBypass(cmd)).toBeNull();
  });

  it('does not treat a fully quoted first word as an assignment', () => {
    // The `grep "FOO=0" src/` case above is discriminated by POSITION — the
    // word comes after a command. This is the case that needs the quoting rule:
    // in leading position, bash looks for a COMMAND of that name rather than
    // setting a variable, so it must not be read as an assignment.
    const cmd = only('"NODE_TLS_REJECT_UNAUTHORIZED=0" node f.js');
    expect(cmd.assignments).toEqual([]);
    expect(findTlsBypass(cmd)).toBeNull();
    expect(() => assertBashEgressAllowed('"NODE_TLS_REJECT_UNAUTHORIZED=0" node f.js', ctx()))
      .not.toThrow();
  });

  it('treats a quoted VALUE as an assignment — the name is still bare', () => {
    const cmd = only("NODE_TLS_REJECT_UNAUTHORIZED='0' node f.js");
    expect(cmd.assignments).toHaveLength(1);
    expect(findTlsBypass(cmd)).toBe('NODE_TLS_REJECT_UNAUTHORIZED=0');
  });
});

describe('policy plumbing', () => {
  it('does nothing at all when there is no context', () => {
    expect(() => assertBashEgressAllowed('curl https://anything.example.com', undefined))
      .not.toThrow();
  });

  it('refuses an unrecognised policy value rather than allowing it', () => {
    const bogus = ctx({ networkPolicy: 'not-a-policy' as never });
    expect(() => assertBashEgressAllowed('curl https://x.example', bogus)).toThrow(/Blocked:/);
  });

  it('applies the guarded baseline — a provider host passes, a random host does not', () => {
    const guarded = ctx({ networkPolicy: 'guarded' });
    expect(() => assertBashEgressAllowed('curl https://api.anthropic.com/v1', guarded))
      .not.toThrow();
    expect(() => assertBashEgressAllowed('curl https://evil.example.com/x', guarded))
      .toThrow(/guarded egress policy/);
  });
});
