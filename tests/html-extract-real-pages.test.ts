import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHtmlText } from '../src/core/html-extract.js';

/**
 * Performance claims about the HTML extractor, measured against pages it will
 * actually be pointed at.
 *
 * ## Why this file exists
 *
 * The commit that added same-site link collection states the hostile anchor cases
 * "all stay within 1.5x of the prose baseline". Nothing checked that, so nobody
 * noticed it was false: a synthetic 563 KB of unterminated anchors costs ~3.3 s of
 * synchronous CPU, roughly 34x the prose baseline per KB, because the anchor walk
 * is quadratic.
 *
 * But the synthetic number was misleading in the OTHER direction too, and that
 * mattered more. Measured on real captured pages, the same extractor runs in
 * MILLISECONDS — 5.1 ms for 767 KB of Wikipedia with 2149 anchors. Real pages
 * close their anchors; the quadratic term needs input that does not occur by
 * accident. A rollout was nearly held on the synthetic figure.
 *
 * So both halves get pinned here, because either one alone misleads:
 *   - real pages stay fast, which is the claim the product actually depends on
 *   - the pathological case stays BOUNDED, which is the risk that remains
 *
 * The fixtures are real responses, gzipped (~230 KB total). A synthetic generator
 * would reproduce the exact mistake this file exists to prevent — it would encode
 * what someone THINKS a page looks like.
 *
 * ## On the thresholds
 *
 * They are deliberately loose (~20x observed) because CI machines are noisy and a
 * flaky perf test gets deleted, which would be worse than no test. They are not
 * there to catch a 30% regression; they are there to catch the shape changing —
 * linear-ish becoming quadratic, milliseconds becoming seconds.
 */

const FIXTURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'html-pages');

function loadPage(file: string): string {
  return gunzipSync(readFileSync(join(FIXTURE_DIR, file))).toString('utf8');
}

function timeExtract(html: string): number {
  const t0 = process.hrtime.bigint();
  extractHtmlText(html, { baseUrl: 'https://example.com/docs/page' });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('html extraction on real pages', () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html.gz'));

  it('has fixtures to measure against at all', () => {
    // Guard the guard: an empty fixture dir would make every assertion below
    // vacuous, and the suite would report a confident pass on nothing.
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)('extracts %s in milliseconds, not seconds', (file) => {
    const html = loadPage(file);
    expect(html.length).toBeGreaterThan(100_000); // a real page, not a stub
    // Observed 3.6–5.1 ms across these three. 250 ms is ~50x headroom for a slow
    // shared runner and still three orders of magnitude below the quadratic case.
    expect(timeExtract(html)).toBeLessThan(250);
  });

  it('carries the anchor density the link feature was built for', () => {
    // If the fixtures ever lost their links, the timings above would stay green
    // while measuring nothing about the anchor walk — the failure mode that made
    // the original claim wrong.
    const total = files.reduce((n, f) => n + (loadPage(f).match(/<a\s/gi) ?? []).length, 0);
    expect(total).toBeGreaterThan(1000);
  });
});

describe('html extraction under a hostile page', () => {
  // Not a real capture on purpose: this shape does not occur by accident, which
  // is exactly why it is the attack and not the baseline.
  const hostile = (n: number) => `<html><body>${'<a href=/x>label'.repeat(n)}</body></html>`;

  it('stays bounded on unterminated anchors', () => {
    // ~140 KB. Observed ~265 ms; 4 s catches "it became seconds" without failing
    // on a busy runner.
    expect(timeExtract(hostile(9000))).toBeLessThan(4000);
  });

  // A scaling assertion used to sit here, comparing 36k against 72k anchors to
  // show the cost went flat. It is gone, and BOTH reasons are worth writing down.
  //
  // It was too expensive: two runs of several seconds each, on every CI run, and
  // it blew the 10 s test timeout on a shared runner.
  //
  // And its premise was WRONG, which is the part that matters here. It claimed
  // the flattening came from "the size cap". There is no input-side cap:
  // `DEFAULT_HTML_EXTRACT_MAX_CHARS` (24 000) truncates the EMITTED TEXT at the
  // end (`html-extract.ts:587`), while `collectLinks` runs over the whole cleaned
  // input before that (`:547`). The plateau came from the link walk stopping at
  // `MAX_EXTRACT_LINKS`, not from any bound on what it reads.
  //
  // So the honest position is the opposite of reassuring: the anchor walk is
  // quadratic in INPUT size with no input-side bound, and a page crafted to
  // produce no links keeps it walking. That is a register item to fix, not a
  // property to pin — and a test asserting a comforting ratio would have made it
  // look handled. This file exists because a performance claim shipped without
  // anything able to falsify it; shipping a second one here would be the joke
  // writing itself.
});
