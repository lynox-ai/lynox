/**
 * Golden-query relevance tests against a live SearXNG instance.
 *
 * Skips unless LYNOX_TEST_SEARXNG_URL is set. To run:
 *
 *   docker run -d --rm -p 18080:8080 \
 *     -v $(pwd)/searxng/settings.yml:/etc/searxng/settings.yml:ro \
 *     searxng/searxng:latest
 *   LYNOX_TEST_SEARXNG_URL=http://localhost:18080 \
 *     npx vitest run tests/online/searxng-relevance.test.ts
 *
 * Regression tests for the 2026-04-24 retrieval-quality bug where
 * `topic: "it"` → `categories=it` narrowed queries to dev-index engines
 * and returned either zero or MDN/Docker-Hub-polluted results.
 *
 * Network dependencies (DuckDuckGo, Google, Bing) flake from fresh Docker
 * IPs, so each test tolerates transient zero-result responses and skips
 * its assertion in that case. When results DO come back, relevance is
 * strictly asserted.
 */
import { describe, it, expect } from 'vitest';
import { SearXNGProvider } from '../../src/integrations/search/search-provider.js';

const searxngUrl = process.env['LYNOX_TEST_SEARXNG_URL'];

describe.skipIf(!searxngUrl)('SearXNG relevance (golden queries)', () => {
  // Lazy init so that `describe.skipIf` can skip cleanly without the
  // provider constructor running with an empty URL when the env var is
  // unset (SearXNGProvider validates its URL eagerly).
  const getProvider = (): SearXNGProvider => new SearXNGProvider(searxngUrl as string);

  it('Python lib query returns authoritative sources when engines respond', async () => {
    const results = await getProvider().search('pytrends Google Trends unofficial API rate limits');
    if (results.length === 0) return; // transient; covered by other tests
    const domains = results.map(r => new URL(r.url).hostname).join(' ');
    expect(domains).toMatch(/pypi\.org|github\.com|dev\.to/);
  }, 15_000);

  it('API pricing query returns vendor or comparison sites when engines respond', async () => {
    const results = await getProvider().search('SerpApi Google Trends API pricing free tier');
    if (results.length === 0) return;
    const domains = results.map(r => new URL(r.url).hostname).join(' ');
    expect(domains).toMatch(/serpapi\.com|trendsmcp|costbench|similar\.ai/);
  }, 15_000);

  it('topic "it" returns general web hits (not empty from dev-index filter)', async () => {
    // Pre-fix behaviour: topic 'it' set categories=it, which produced 0
    // results against the lynox config (IT engines: github/npm/pypi/
    // stackoverflow — no general web indices). Post-fix: topic 'it' is
    // a no-op, so results should match the no-topic baseline.
    const p = getProvider();
    const baseline = await p.search('pytrends Google Trends unofficial API rate limits');
    const withIt = await p.search(
      'pytrends Google Trends unofficial API rate limits',
      { topic: 'it' },
    );
    if (baseline.length === 0) return; // transient upstream
    expect(withIt.length).toBeGreaterThan(0);
  }, 30_000);

  it('topic "news" round-trips without error', async () => {
    const results = await getProvider().search('Swiss economy outlook', { topic: 'news' });
    expect(Array.isArray(results)).toBe(true);
  }, 15_000);
});
