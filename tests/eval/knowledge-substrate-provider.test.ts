// Contract test for the replay provider resolver + the legacy-store line reader.
//
// These two are the pieces of the DK gate harness that can mis-measure WITHOUT
// failing: a wrong provider makes every turn 400 into a deliberate swallow (the
// run reports recall 0.00 as a result), and a wrong line split changes how many
// entries the legacy baseline is credited with. Neither has a symptom.
//
// Every case below names the MUTATION it dies under — a test that only describes
// the current code would pass just as happily on the buggy version it replaced.

import { describe, it, expect } from 'vitest';
import { resolveReplayProvider, pickKey } from './knowledge-substrate-provider.js';
import { linesOf, attributeNewLines } from './knowledge-substrate-baseline.js';
import { ALL_NAMESPACES } from '../../src/types/index.js';
import type { MemoryNamespace } from '../../src/types/index.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const noFile = (p: string): string => { throw new Error(`ENOENT: ${p}`); };
const resolve = (
  env: Parameters<typeof resolveReplayProvider>[0],
  cfg: Record<string, unknown> = {},
  read: (p: string) => string = noFile,
) => resolveReplayProvider(env, cfg, read, HAIKU);

describe('resolveReplayProvider', () => {
  // MUTATION: read only `api_key` (the 2026-07-27 bug). Then this resolves to
  // Mistral, and the assertion on provider/apiKey fails.
  it('finds the Anthropic key under the spelling the CLI actually writes', () => {
    const r = resolve({}, { anthropic_api_key: 'sk-ant-real', mistral_api_key: 'mk' });
    expect(r?.provider).toBeUndefined();
    expect(r?.apiKey).toBe('sk-ant-real');
  });

  // MUTATION: drop the `api_key` fallback → older configs stop resolving and
  // silently fall through to Mistral.
  it('still accepts the legacy `api_key` spelling', () => {
    expect(resolve({}, { api_key: 'sk-ant-legacy' })?.apiKey).toBe('sk-ant-legacy');
  });

  // MUTATION: use `??` on the raw values instead of pickKey → '' wins, an empty
  // model/credential reaches the API and 401s into the swallow.
  it('treats an empty or blank credential as absent, not as a key', () => {
    const r = resolve({}, { anthropic_api_key: '   ', mistral_api_key: 'mk-real' });
    expect(r?.apiKey).toBe('mk-real');
    expect(r?.apiBaseURL).toBe('https://api.mistral.ai/v1');
  });

  // MUTATION: let env lose to config → a deliberate one-off override is ignored.
  it('prefers the environment over the stored config', () => {
    expect(resolve({ ANTHROPIC_API_KEY: 'sk-env' }, { anthropic_api_key: 'sk-cfg' })?.apiKey).toBe('sk-env');
  });

  // MUTATION: return null instead of resolving Mistral → a Mistral-only box
  // self-skips the gate green.
  // Literals, NOT the imported constants: asserting `toBe(MISTRAL_REPLAY_MODEL)`
  // passes for whatever that constant happens to hold, including a `-latest` alias.
  it('falls back to Mistral EU on a Mistral-only box, pinned to a dated snapshot', () => {
    const r = resolve({}, { mistral_api_key: 'mk' });
    expect(r?.model).toBe('mistral-large-2512');
    expect(r?.model).not.toMatch(/-latest$/); // rate-limited alias grinds a long replay into 429s
    expect(r?.openaiModelId).toBe('mistral-large-2512');
  });

  // MUTATION: drop `provider: 'openai'` from the Mistral branch. Verified 2026-07-28:
  // WITHOUT this assertion all 22 other cases still passed, and the caller
  // (`knowledge-substrate-eval.test.ts`) then relabels the result `anthropic` —
  // a Mistral key on the Anthropic wire, which is precisely the 2026-07-27 outage
  // this whole file exists to prevent. The suite had its hole on the one field
  // that carries the historical bug.
  it('names the openai wire on EVERY non-Anthropic branch', () => {
    expect(resolve({}, { mistral_api_key: 'mk' })?.provider).toBe('openai');
    expect(resolve(
      { LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1', LYNOX_KNOWLEDGE_PROXY_KEY: 'k', LYNOX_KNOWLEDGE_MODEL: 'm' },
    )?.provider).toBe('openai');
  });

  // MUTATION: drop the unknown-value check → a typo runs the corpus on the wrong
  // provider and reports the number as if it were the one asked for.
  it('throws on an unrecognised provider instead of silently picking one', () => {
    expect(() => resolve({ LYNOX_KNOWLEDGE_PROVIDER: 'antropic' }, { mistral_api_key: 'mk' })).toThrow(/not a known provider/);
  });

  it('still accepts an explicit mistral selection', () => {
    expect(resolve({ LYNOX_KNOWLEDGE_PROVIDER: 'mistral' }, { mistral_api_key: 'mk' })?.apiKey).toBe('mk');
  });

  // MUTATION: honour the Mistral key even when anthropic is forced → the run
  // silently measures a different provider than the operator asked for.
  it('forcing anthropic never falls through to Mistral', () => {
    expect(resolve({ LYNOX_KNOWLEDGE_PROVIDER: 'anthropic' }, { mistral_api_key: 'mk' })).toBeNull();
  });

  // MUTATION: auto-pick proxy when its env happens to be set → an operator-local
  // endpoint gets used without being asked for.
  it('never auto-picks the proxy — it is explicit opt-in only', () => {
    const r = resolve(
      { LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1', LYNOX_KNOWLEDGE_PROXY_KEY: 'k' },
      { anthropic_api_key: 'sk-ant' },
    );
    expect(r?.apiKey).toBe('sk-ant');
    expect(r?.apiBaseURL).toBeUndefined();
  });

  // MUTATION: bake in a default proxy URL → an operator-local endpoint is
  // hardcoded in a PUBLIC repo (the leak scrubbed on 2026-07-27).
  it('self-skips when the proxy has no URL — no endpoint is baked in', () => {
    expect(resolve({ LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_KEY: 'k' })).toBeNull();
  });

  it('self-skips when the proxy has a URL but no credential', () => {
    expect(resolve({ LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1' })).toBeNull();
  });

  // MUTATION: swallow the read error and return null → a typo'd path self-skips
  // the gate GREEN, which reads as a pass.
  it('THROWS on a set-but-unreadable key file instead of self-skipping green', () => {
    expect(() => resolve({
      LYNOX_KNOWLEDGE_PROVIDER: 'proxy',
      LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1',
      LYNOX_KNOWLEDGE_PROXY_KEY_FILE: '/nope',
    })).toThrow(/unreadable/);
  });

  it('reads the proxy credential from the key file and trims it', () => {
    const r = resolve(
      { LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1', LYNOX_KNOWLEDGE_PROXY_KEY_FILE: '/k', LYNOX_KNOWLEDGE_MODEL: 'pinned-1' },
      {},
      () => '  secret\n',
    );
    expect(r?.apiKey).toBe('secret');
    expect(r?.model).toBe('pinned-1');
  });

  // MUTATION: fall through to `return null` on a blank key file → the gate
  // self-skips GREEN and the HARD routing assertion never runs, so a truncated
  // credential file reads as a pass.
  it('THROWS on an empty key file instead of self-skipping green', () => {
    expect(() => resolve(
      { LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1', LYNOX_KNOWLEDGE_PROXY_KEY_FILE: '/k' },
      {},
      () => '   \n',
    )).toThrow(/empty file/);
  });

  // MUTATION: re-introduce a default proxy model → a public repo states what the
  // operator's local endpoint fronts.
  it('requires an explicit model for the proxy — no default is assumed', () => {
    expect(() => resolve(
      { LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1', LYNOX_KNOWLEDGE_PROXY_KEY: 'k' },
    )).toThrow(/requires LYNOX_KNOWLEDGE_MODEL/);
  });

  // MUTATION: interpolate `${keyFile}` back into the message → the path to the
  // operator's credential lands in every pasted log.
  it('never echoes the key-file PATH in the error', () => {
    const secretPath = '/Users/someone/.private/creds/eval-key';
    try {
      resolve({ LYNOX_KNOWLEDGE_PROVIDER: 'proxy', LYNOX_KNOWLEDGE_PROXY_URL: 'http://h/v1', LYNOX_KNOWLEDGE_PROXY_KEY_FILE: secretPath });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(secretPath);
      expect((err as Error).message).not.toContain('.private');
    }
  });

  // MUTATION: drop the `?? defaultAnthropicModel` → model '' reaches the API.
  it('applies the default model when no override is set', () => {
    expect(resolve({}, { anthropic_api_key: 'sk' })?.model).toBe(HAIKU);
  });

  it('an explicit model override wins on every provider', () => {
    const env = { LYNOX_KNOWLEDGE_MODEL: 'pinned-1' };
    expect(resolve(env, { anthropic_api_key: 'sk' })?.model).toBe('pinned-1');
    expect(resolve(env, { mistral_api_key: 'mk' })?.model).toBe('pinned-1');
  });

  it('resolves to null when nothing at all is configured', () => {
    expect(resolve({}, {})).toBeNull();
  });
});

describe('pickKey', () => {
  it('skips blank candidates and returns the first real one', () => {
    expect(pickKey(undefined, '', '   ', 'real', 'later')).toBe('real');
  });
  it('returns undefined when every candidate is blank', () => {
    expect(pickKey(undefined, '', '  ')).toBeUndefined();
  });
});

describe('linesOf — the legacy-store readback', () => {
  // `Memory.appendScoped` writes ONE line per entry (memory.ts:395), so the split
  // must be on newlines. MUTATION: split on '; ' as well → a consolidated
  // multi-fact entry is counted as several, inflating the baseline's junk-rate
  // denominator against it.
  it('counts one line as one entry', () => {
    expect(linesOf('fact one\nfact two')).toEqual(['fact one', 'fact two']);
  });

  it('does not split a bundled multi-fact entry — the legacy store joins with "; "', () => {
    expect(linesOf('alpha is X; beta is Y')).toEqual(['alpha is X; beta is Y']);
  });

  // MUTATION: drop the bullet strip → '- fact' and 'fact' read as two different
  // entries across turns, so the same line is re-attributed to a later turn.
  it('normalises markdown bullets so a list is not one giant entry', () => {
    expect(linesOf('- alpha\n* beta')).toEqual(['alpha', 'beta']);
  });

  // MUTATION: keep headings → a '## Knowledge' section header is scored as a
  // captured entry, i.e. as junk the model never wrote.
  it('drops markdown headings and blank lines', () => {
    expect(linesOf('## Knowledge\n\nalpha\n   \n### Sub\nbeta')).toEqual(['alpha', 'beta']);
  });

  it('treats an empty or missing namespace as no entries', () => {
    expect(linesOf(null)).toEqual([]);
    expect(linesOf('')).toEqual([]);
    expect(linesOf('\n  \n')).toEqual([]);
  });

  // The date prefix the `status` namespace adds (memory.ts:389) stays on the
  // line: the judge reads the text, and stripping it would diverge from what the
  // agent actually stored.
  it('keeps the status-namespace date prefix', () => {
    expect(linesOf('[2026-07-28] shipped v2')).toEqual(['[2026-07-28] shipped v2']);
  });
});

describe('attributeNewLines — where the baseline numbers are actually made', () => {
  const freshSeen = (): Map<MemoryNamespace, Set<string>> => {
    const m = new Map<MemoryNamespace, Set<string>>();
    for (const ns of ALL_NAMESPACES) m.set(ns, new Set());
    return m;
  };
  const snap = (lines: string[]): Map<MemoryNamespace, string[]> =>
    new Map<MemoryNamespace, string[]>([['knowledge' as MemoryNamespace, lines]]);

  // MUTATION: drop the `seen` check → every turn re-counts the whole store, so a
  // 20-turn thread reports 20x its real writes and the junk-rate denominator explodes.
  it('credits a line to the turn it FIRST appeared in, never again', () => {
    const seen = freshSeen();
    const t0 = attributeNewLines(snap(['alpha']), seen, new Set(), 'T', 0);
    const t1 = attributeNewLines(snap(['alpha', 'beta']), seen, new Set(), 'T', 1);
    expect(t0.map(c => c.text)).toEqual(['alpha']);
    expect(t1.map(c => c.text)).toEqual(['beta']);
    expect(t1[0]?.turnSeq).toBe(1);
  });

  // MUTATION: hardcode `sourceUntrusted: false` → the harness's only HARD security
  // assertion becomes unfailable on this side. That is exactly what the withdrawn
  // first version did.
  it('marks a write the write-path reported as untrusted', () => {
    const [c] = attributeNewLines(snap(['leaked fact']), freshSeen(), new Set(['leaked fact']), 'T', 0);
    expect(c?.sourceUntrusted).toBe(true);
  });

  // MUTATION: mark everything in a turn untrusted (the gold-label approach) → a
  // late-settling extraction from a CLEAN turn is scored as a routing violation.
  it('leaves an unrelated line in the same turn trusted', () => {
    const rows = attributeNewLines(snap(['leaked fact', 'clean fact']), freshSeen(), new Set(['leaked fact']), 'T', 0);
    expect(rows.find(r => r.text === 'clean fact')?.sourceUntrusted).toBe(false);
  });

  // The stored line is not byte-identical to the published content: `appendScoped`
  // masks secrets and the `status` namespace prefixes a date, so exact equality
  // would silently under-count untrusted writes.
  it('matches a stored line against the published content by containment', () => {
    const rows = attributeNewLines(snap(['[2026-07-28] acme owes 500']), freshSeen(), new Set(['acme owes 500']), 'T', 0);
    expect(rows[0]?.sourceUntrusted).toBe(true);
  });

  it('reports the legacy store honestly: no subject link, no review queue', () => {
    const [c] = attributeNewLines(snap(['alpha']), freshSeen(), new Set(), 'T', 0);
    expect(c?.subject).toBeNull();
    expect(c?.status).toBe('active');
    expect(c?.pinned).toBe(false);
  });
});
