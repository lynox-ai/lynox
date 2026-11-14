import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSearxng, getSearxngHealthy, getSearxngCheckProblem, saveSearxng, setSearxngUrl, removeSearxng } from './search.svelte.js';
import { getSearxngProblem, loadSecretStatuses } from './secrets.svelte.js';

// The settings check tells a URL the engine sends no search to (a private IP written as
// a number) apart from one that is not reachable; before, both read "Unreachable — check URL".
describe('the SearXNG check', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (status: number, body: unknown): void => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
  };

  it('names a refused private IP', async () => {
    answer(400, { error: 'SearXNG URL … names the IP address 127.0.0.1 …', code: 'searxng-private-ip' });
    await checkSearxng('http://127.0.0.1:18080');
    expect(getSearxngHealthy()).toBe(false);
    expect(getSearxngCheckProblem()).toBe('private-ip');
  });

  it('keeps another refusal as unreachable', async () => {
    answer(400, { error: 'Blocked: cloud metadata endpoint' });
    await checkSearxng('http://169.254.169.254');
    expect(getSearxngHealthy()).toBe(false);
    expect(getSearxngCheckProblem()).toBeNull();
  });

  it('clears the mark on the next check', async () => {
    answer(400, { code: 'searxng-private-ip' });
    await checkSearxng('http://10.0.0.5');
    answer(200, { healthy: true });
    await checkSearxng('http://localhost:8888');
    expect(getSearxngHealthy()).toBe(true);
    expect(getSearxngCheckProblem()).toBeNull();
  });

  // The mark is about the URL that was checked: an edit, a save or a removal leaves it behind.
  it.each([
    ['an edit', async () => { setSearxngUrl('http://localhost:8888'); }],
    ['a save', async () => { answer(200, {}); await saveSearxng(); }],
    ['a removal', async () => { answer(200, {}); await removeSearxng(); }],
  ] as const)('clears the mark on %s', async (_what, act) => {
    // The form holds a URL to save; the check of it is refused.
    setSearxngUrl('http://127.0.0.1:18080');
    answer(400, { code: 'searxng-private-ip' });
    await checkSearxng('http://127.0.0.1:18080');
    expect(getSearxngCheckProblem()).toBe('private-ip');
    await act();
    expect(getSearxngCheckProblem()).toBeNull();
  });
});

describe('the stored URL the engine does not use', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([['private-ip', 'private-ip'], ['metadata', 'metadata'], [null, null]] as const)('reads problem %s', async (problem, want) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configured: { search: problem === null, api_key: true, searxng: true }, searxng_url: 'http://x', searxng_problem: problem }), { status: 200 })));
    await loadSecretStatuses();
    expect(getSearxngProblem()).toBe(want);
  });
});
