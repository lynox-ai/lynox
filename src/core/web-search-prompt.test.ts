import { describe, it, expect } from 'vitest';
import { webSearchPromptCase } from './web-search-prompt.js';
import { applyEnforceHttps, applyNetworkPolicy, createToolContext } from './tool-context.js';
import type { ToolContext } from './tool-context.js';
import {
  NO_WEB_SEARCH_PROMPT_SUFFIX,
  WEB_SEARCH_FALLBACK_PROMPT_SUFFIX,
  policyBlocksSearchPromptSuffix,
  webSearchFallbackSearxngRefusedPromptSuffix,
} from './prompts.js';

const ctx = (setup: (c: ToolContext) => void): ToolContext => {
  const c = createToolContext({});
  setup(c);
  return c;
};

describe('which web-search suffix a session gets', () => {
  const allowAll = ctx(() => {});
  const denyAll = ctx((c) => applyNetworkPolicy(c, 'deny-all', []));
  const listWithout = ctx((c) => applyNetworkPolicy(c, 'allow-list', ['searxng']));
  const listWith = ctx((c) => applyNetworkPolicy(c, 'allow-list', ['html.duckduckgo.com']));
  const https = ctx((c) => applyEnforceHttps(c, true));
  const guarded = ctx((c) => applyNetworkPolicy(c, 'guarded', []));

  it.each([
    ['SearXNG used', 'configured', null, denyAll, null],
    ['no web_research', 'none', null, allowAll, { kind: 'none' }],
    ['fallback, nothing refused', 'fallback', null, allowAll, { kind: 'fallback' }],
    ['fallback refused by deny-all, with no SearXNG', 'fallback', null, denyAll, { kind: 'policy-blocks-search' }],
    ['fallback refused by deny-all, SearXNG refused too', 'fallback', { code: 'policy-deny' }, denyAll, { kind: 'policy-blocks-search' }],
    ['fallback not on the allow-list', 'fallback', { code: 'policy-allowlist' }, listWithout, { kind: 'policy-blocks-search' }],
    ['SearXNG not on the allow-list, fallback is', 'fallback', { code: 'policy-allowlist' }, listWith, { kind: 'fallback-searxng-refused', rule: 'policy-allowlist' }],
    ['SearXNG over http under enforce_https, fallback is https', 'fallback', { code: 'policy-https' }, https, { kind: 'fallback-searxng-refused', rule: 'policy-https' }],
    ['SearXNG refused for its URL, not by policy', 'fallback', { code: 'private-ip' }, allowAll, { kind: 'fallback' }],
    ['fallback under guarded (search is discovery, open)', 'fallback', null, guarded, { kind: 'fallback' }],
  ] as const)('%s', (_name, status, boot, c, expected) => {
    expect(webSearchPromptCase(status, boot, c)).toEqual(expected);
  });

  it('follows a policy changed on the context after boot', () => {
    const c = ctx(() => {});
    expect(webSearchPromptCase('fallback', null, c)).toEqual({ kind: 'fallback' });
    applyNetworkPolicy(c, 'deny-all', []);
    expect(webSearchPromptCase('fallback', null, c)).toEqual({ kind: 'policy-blocks-search' });
  });
});

describe('the suffix when the network settings block every search', () => {
  it.each([
    [false, '; only the owner of this instance can change them'],
    [true, '; on this hosted instance lynox sets them, and the owner of this instance can ask lynox support about it at support@lynox.ai'],
  ] as const)('names the cause as its own rule, and who can change it (hosted: %s)', (provisioned, who) => {
    const text = policyBlocksSearchPromptSuffix(provisioned);
    expect(text).toContain('## Web search is blocked by the network settings of this instance');
    expect(text).toContain(`- **Name the cause.** Whenever you cannot look something up on the web, say so with this reason, in the user's language:\n  > "Web search is blocked by the network settings of this instance${who}."\n  Then offer to answer from what you already know, and say that this may be out of date.`);
    expect(text).toContain('- Do not suggest SearXNG, `docker compose` or `SEARXNG_URL`: they do not change this setting.');
    // Only the "do not suggest" rule names them: no way out through SearXNG.
    expect(text.split('docker compose').length - 1).toBe(1);
    expect(text).not.toMatch(/—|–/);
  });
});

describe('the fallback suffix when the boot refused SearXNG by a rule', () => {
  it.each([
    ['policy-https', 'they allow only https, and the SearXNG address uses http'],
    ['policy-allowlist', 'the SearXNG host is not on the network allow-list'],
    ['policy', 'they do not allow the SearXNG address'],
  ] as const)('%s names the rule, not SearXNG setup', (code, rule) => {
    for (const provisioned of [false, true]) {
      const text = webSearchFallbackSearxngRefusedPromptSuffix(code, provisioned);
      expect(text).toContain(`- SearXNG is set up for this instance, but its network settings do not allow it: ${rule}, so searches run on the fallback. If the user asks why results are few or how search could be better, tell them this, and `);
      expect(text).toContain('. Do not suggest `docker compose` or `SEARXNG_URL`.\n');
      // The old way out is gone: SEARXNG_URL and docker are named only in the "do not suggest" rule.
      expect(text).not.toContain('docker compose up');
      expect(text.split('SEARXNG_URL').length - 1).toBe(1);
      // The rest of the fallback suffix stays.
      expect(text).toContain('## Web search is running on a fallback provider (best-effort)');
      expect(text).toContain('**try one reformulation**');
    }
  });

  it('points a hosted owner at support, a self-hosted one at the setting', () => {
    expect(webSearchFallbackSearxngRefusedPromptSuffix('policy-allowlist', false)).toContain('tell them this, and that the owner of this instance can allow SearXNG in the network settings; the integrations page shows where that setting is. Do not suggest');
    const hosted = webSearchFallbackSearxngRefusedPromptSuffix('policy-allowlist', true);
    expect(hosted).toContain('tell them this, and that on this hosted instance lynox sets these settings; the owner of this instance can ask lynox support about it at support@lynox.ai. Do not suggest');
    expect(hosted).not.toContain('integrations page');
  });

  it('leaves the plain suffixes as they were', () => {
    expect(WEB_SEARCH_FALLBACK_PROMPT_SUFFIX).toContain('suggest enabling SearXNG (`docker compose up`, or set `SEARXNG_URL`)');
    expect(NO_WEB_SEARCH_PROMPT_SUFFIX).toContain('## Web search is NOT configured on this instance');
  });
});
