import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildCaptureReport } from './capture-telemetry-report.js';
import { scanBoundedJsonl, appendBoundedJsonl } from './bounded-jsonl-log.js';
import { CAPTURE_TELEMETRY_LOG_FILE, type CaptureTelemetryEntry } from './capture-telemetry.js';

/**
 * Real disk, real files — the sink's whole contract is a rotation + parse story, and a
 * mocked fs would test the mock. `memory/fb_realworld_harness.md`: the substrate IS the
 * thing under test here.
 */
let dir: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lynox-capture-report-'));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = dir;
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  await rm(dir, { recursive: true, force: true });
});

/** Write raw lines to a sink generation, bypassing the append path. */
async function seed(lines: string[], generation: '' | '.1' = ''): Promise<void> {
  await writeFile(path.join(dir, CAPTURE_TELEMETRY_LOG_FILE + generation), lines.join('\n') + '\n', 'utf8');
}

function entry(e: Partial<CaptureTelemetryEntry> & Pick<CaptureTelemetryEntry, 'event'>): string {
  return JSON.stringify({ ts: 1000, thread: 't1', model: 'ministral-14b-2512', untrusted: false, ...e });
}

/** Collect a scan into an array — convenience for the assertions below, never in prod code. */
async function collect(): Promise<{ entries: CaptureTelemetryEntry[]; scan: Awaited<ReturnType<typeof scanBoundedJsonl>> }> {
  const entries: CaptureTelemetryEntry[] = [];
  const scan = await scanBoundedJsonl<CaptureTelemetryEntry>(CAPTURE_TELEMETRY_LOG_FILE, e => { entries.push(e); });
  return { entries, scan };
}

describe('scanBoundedJsonl', () => {
  it('returns an empty scan for a sink that was never written (not a throw)', async () => {
    const { entries, scan } = await collect();
    expect(entries).toEqual([]);
    expect(scan.generationsRead).toBe(0);
    expect(scan.entriesSeen).toBe(0);
  });

  it('reads BOTH retained generations, rotated-out one first', async () => {
    await seed([entry({ event: 'capture_eligible', ts: 1 })], '.1');
    await seed([entry({ event: 'capture_eligible', ts: 2 })]);
    const { entries, scan } = await collect();
    expect(scan.generationsRead).toBe(2);
    // Order matters: a reader that only globs the live file silently loses the older
    // half of the retained window and reports a rate over the wrong span.
    expect(entries.map(e => e.ts)).toEqual([1, 2]);
  });

  it('COUNTS unparsable lines instead of silently shrinking the window', async () => {
    await seed([entry({ event: 'capture_eligible' }), '{not json', entry({ event: 'remember_invoked' })]);
    const { entries, scan } = await collect();
    expect(entries).toHaveLength(2);
    expect(scan.entriesSeen).toBe(2);
    expect(scan.unparsableLines).toBe(1);
  });

  it('round-trips what appendBoundedJsonl wrote', async () => {
    await appendBoundedJsonl(CAPTURE_TELEMETRY_LOG_FILE, { ts: 7, event: 'capture_eligible' });
    const { entries } = await collect();
    expect(entries).toEqual([{ ts: 7, event: 'capture_eligible' }]);
  });

  it('reads a CRLF-written sink without tearing the model attribution', async () => {
    // Characterisation, not a guard for `crlfDelay`: readline already splits \r\n at this
    // size, and removing that option does NOT fail this test (verified by mutation). The
    // option earns its place only for a \r and \n landing in different 64 KiB chunks,
    // which a fixture this small cannot produce. What this DOES pin is the consequence
    // that would matter — a stray \r riding into `model` and splitting the per-model
    // table into ghost rows.
    await writeFile(
      path.join(dir, CAPTURE_TELEMETRY_LOG_FILE),
      entry({ event: 'capture_eligible', model: 'sonnet' }) + '\r\n' + entry({ event: 'remember_invoked', model: 'sonnet' }) + '\r\n',
      'utf8',
    );
    const { entries, scan } = await collect();
    expect(scan.unparsableLines).toBe(0);
    expect(entries.map(e => e.model)).toEqual(['sonnet', 'sonnet']);
  });

  it('skips a blank line mid-file instead of booking it as damage', async () => {
    // A trailing newline never reaches the visitor (readline drops it), so only an
    // INTERIOR blank line exercises the guard — and without it every such line would
    // inflate `unparsableLines`, i.e. the report would claim damage it did not have.
    await seed([entry({ event: 'capture_eligible' }), '', entry({ event: 'remember_invoked' })]);
    const { entries, scan } = await collect();
    expect(entries).toHaveLength(2);
    expect(scan.unparsableLines).toBe(0);
  });

  it('propagates a throwing visitor rather than reporting a silently short scan', async () => {
    await seed([entry({ event: 'capture_eligible' }), entry({ event: 'capture_eligible' })]);
    // A swallowed visitor error would return a scan whose counts look complete while
    // the caller's aggregation stopped halfway — a wrong number with no symptom, which
    // is the exact failure this whole module exists to remove.
    await expect(scanBoundedJsonl(CAPTURE_TELEMETRY_LOG_FILE, () => { throw new Error('visitor blew up'); }))
      .rejects.toThrow('visitor blew up');
  });
});

describe('buildCaptureReport', () => {
  it('reports an EMPTY window as unmeasurable (null), not as a fire-rate of zero', async () => {
    const r = await buildCaptureReport();
    // The distinction the row exists for: "capture is dead" (0) and "capture was never
    // measurable" (null) are different findings, and conflating them is how the original
    // anecdote survived. A 0 here would assert a measurement that did not happen.
    expect(r.fireRate).toBeNull();
    expect(r.totalEvents).toBe(0);
    expect(r.windowStart).toBeNull();
  });

  it('derives the headline fire-rate from the two ends of the ratio', async () => {
    await seed([
      ...Array.from({ length: 4 }, () => entry({ event: 'capture_eligible' })),
      entry({ event: 'remember_invoked', outcome: 'active' }),
    ]);
    const r = await buildCaptureReport();
    expect(r.fireRate).toBeCloseTo(0.25);
    expect(r.events.capture_eligible).toBe(4);
    expect(r.events.remember_invoked).toBe(1);
    expect(r.outcomes).toEqual({ active: 1 });
  });

  it('splits the fire-rate PER MODEL — the split the sink calls "the whole point"', async () => {
    // The QUIET model is seeded FIRST on purpose: with the busy one first, insertion order
    // already matches the intended order and dropping the sort entirely would still pass.
    await seed([
      entry({ event: 'capture_eligible', model: 'ministral-14b-2512' }),
      entry({ event: 'capture_eligible', model: 'sonnet' }),
      entry({ event: 'capture_eligible', model: 'sonnet' }),
      entry({ event: 'remember_invoked', model: 'sonnet', outcome: 'active' }),
    ]);
    const r = await buildCaptureReport();
    const sonnet = r.byModel.find(m => m.model === 'sonnet');
    const ministral = r.byModel.find(m => m.model === 'ministral-14b-2512');
    expect(sonnet).toMatchObject({ eligible: 2, remembered: 1, fireRate: 0.5 });
    // A model that never captured must read 0, not null: it HAS a denominator.
    expect(ministral).toMatchObject({ eligible: 1, remembered: 0, fireRate: 0 });
    // Busiest first, so the model carrying the fleet leads the table.
    expect(r.byModel[0]!.model).toBe('sonnet');
  });

  it('derives confirm + ignore rates off the propose denominator', async () => {
    await seed([
      entry({ event: 'propose_shown' }), entry({ event: 'propose_shown' }),
      entry({ event: 'propose_shown' }), entry({ event: 'propose_shown' }),
      entry({ event: 'propose_confirmed' }),
      entry({ event: 'propose_ignored', dismissed: true }),
    ]);
    const r = await buildCaptureReport();
    expect(r.confirmRate).toBeCloseTo(0.25);
    expect(r.ignoreRate).toBeCloseTo(0.25);
  });

  it('DECLARES its blind spots: events it could not attribute, and damaged lines', async () => {
    // The two "without" counters are deliberately driven by SEPARATE entries — one entry
    // missing both fields lets an implementation that swaps them pass.
    await seed([
      entry({ event: 'capture_eligible', model: undefined }),
      entry({ event: 'capture_eligible', thread: undefined }),
      entry({ event: 'capture_eligible', thread: undefined }),
      '{{ broken',
    ]);
    const r = await buildCaptureReport();
    expect(r.blindness.eventsWithoutModel).toBe(1);
    expect(r.blindness.eventsWithoutThread).toBe(2);
    expect(r.blindness.unparsableLines).toBe(1);
    // The unattributed event still counts in the headline — it just cannot join a per-model
    // row. Dropping it from `capture_eligible` would inflate the fire-rate instead.
    expect(r.events.capture_eligible).toBe(3);
    expect(r.byModel).toHaveLength(1);
  });

  it('flags a TRUNCATED window so totals are read as a floor, not a census', async () => {
    await seed([entry({ event: 'capture_eligible', ts: 1 })], '.1');
    await seed([entry({ event: 'capture_eligible', ts: 2 })]);
    const r = await buildCaptureReport();
    expect(r.blindness.windowTruncated).toBe(true);
    expect(r.windowStart).toBe(1);
    expect(r.windowEnd).toBe(2);
  });

  it('does NOT flag truncation on a single-generation window', async () => {
    // The pair matters: asserting only the `true` case lets a constant `true` pass, which
    // would tell every operator their window is short when it is complete.
    await seed([entry({ event: 'capture_eligible', ts: 1 })]);
    const r = await buildCaptureReport();
    expect(r.blindness.windowTruncated).toBe(false);
  });

  it('reports an unreadable generation as blindness instead of failing the request', async () => {
    // The report sits on an HTTP route. A sink it cannot open (permissions, a directory in
    // the way, a rotation mid-scan) must degrade to "I could not read this", never to a 500
    // — while still refusing to present the surviving numbers as a complete window.
    await mkdir(path.join(dir, CAPTURE_TELEMETRY_LOG_FILE));
    const r = await buildCaptureReport();
    expect(r.blindness.unreadableGenerations).toBe(1);
    expect(r.fireRate).toBeNull();
  });

  it('caps the per-model table and says how many rows it dropped', async () => {
    // 60 distinct models > the 50-row cap. `model` reaches the sink from user-settable
    // config, so an uncapped table is a response-size hole, and a silently short one would
    // read as "these are all the models".
    await seed(Array.from({ length: 60 }, (_, i) => entry({ event: 'capture_eligible', model: `m${String(i).padStart(3, '0')}` })));
    const r = await buildCaptureReport();
    expect(r.byModel).toHaveLength(50);
    expect(r.blindness.modelsOmitted).toBe(10);
  });

  describe('a poisoned sink (the file is NOT on the permission-guard protected list)', () => {
    it('rejects a non-string model instead of crashing on it', async () => {
      // `{length: n}` satisfies the length CHECK but not `.slice` — the endpoint answered
      // 500, and because a throw clears the response cache, it answered 500 uncached for
      // every subsequent request.
      await seed([
        JSON.stringify({ ts: 1, event: 'capture_eligible', model: { length: 999 }, untrusted: false }),
        entry({ event: 'capture_eligible', model: 'sonnet' }),
      ]);
      const r = await buildCaptureReport();
      expect(r.byModel).toEqual([{ model: 'sonnet', eligible: 1, remembered: 0, fireRate: 0 }]);
      // The record still COUNTS — its event is valid, only the attribution is unusable.
      // Booking it as malformed would understate the denominator; the right bucket is
      // "an event I could not attribute to a model".
      expect(r.events.capture_eligible).toBe(2);
      expect(r.blindness.eventsWithoutModel).toBe(1);
      expect(r.blindness.malformedRecords).toBe(0);
    });

    it('cannot have the model length cap defeated by an array', async () => {
      // An array's `.length` is its element count, so a 2-element array of huge strings
      // reads as "length 2" and skipped the 128-char clamp entirely — 10 MB of response
      // was produced this way.
      await seed([JSON.stringify({ ts: 1, event: 'capture_eligible', model: ['X'.repeat(500), 'i'], untrusted: false })]);
      const r = await buildCaptureReport();
      expect(r.byModel).toEqual([]);
      // The bound is on the ATTACKER-controlled part, so it has to be stated relative to
      // the fixed part rather than as a bare constant. An empty report is the whole schema
      // with zeros in it, and that grows every time a counter is added — this assertion
      // went red on a 4-field addition for two characters, which is the assertion catching
      // schema growth, not poison. Measuring the DELTA keeps it pinned on the 500-char
      // payload: it must not survive anywhere in the output.
      // The baseline is the SAME fixture with a clean model, not an empty sink: an empty
      // report does not trip `BLIND_NOTE`, so most of a flat headroom would have been spent
      // on that fixed string rather than on the payload. Same shape, one field poisoned.
      await seed([JSON.stringify({ ts: 1, event: 'capture_eligible', model: 'clean-model', untrusted: false })]);
      const cleanBaseline = JSON.stringify(await buildCaptureReport()).length;
      await seed([JSON.stringify({ ts: 1, event: 'capture_eligible', model: ['X'.repeat(500), 'i'], untrusted: false })]);
      const poisoned = JSON.stringify(await buildCaptureReport());
      expect(poisoned.length - cleanBaseline).toBeLessThan(100);
      expect(poisoned).not.toContain('X'.repeat(50));
    });

    it('clamps an over-long STRING model rather than dropping it', async () => {
      // The legitimate case must survive the guard that kills the hostile one: a long but
      // real model id is truncated, not discarded, or a config typo erases a whole row.
      await seed([entry({ event: 'capture_eligible', model: 'm'.repeat(400) })]);
      const r = await buildCaptureReport();
      expect(r.byModel[0]!.model).toHaveLength(128);
      expect(r.blindness.malformedRecords).toBe(0);
    });

    it('does not let a non-finite timestamp fake an empty window', async () => {
      // `1e999` parses to Infinity, which serializes to null — and this module's own
      // interface documents a null window as "the sink is empty", while the counts say
      // otherwise. A report contradicting itself is worse than one reporting nothing.
      // Written RAW, not via JSON.stringify: stringify emits Infinity as `null`, so the
      // hostile value never reaches the parser and the test proves nothing. Only a
      // hand-written `1e999` in the file reproduces it.
      await seed([
        '{"ts":1e999,"event":"capture_eligible","model":"m","untrusted":false}',
        entry({ event: 'capture_eligible', ts: 5, model: 'm' }),
      ]);
      const r = await buildCaptureReport();
      expect(r.windowEnd).toBe(5);
      expect(Number.isFinite(r.windowEnd)).toBe(true);
      expect(r.blindness.malformedRecords).toBe(0); // the record is usable, only its ts is not
    });

    it('counts a wholly malformed record as blindness rather than as an event', async () => {
      await seed([
        JSON.stringify({ ts: 1, event: 'capture_eligible', model: 'm', untrusted: false }),
        JSON.stringify(['not', 'an', 'object']),
        JSON.stringify({ ts: 2, event: 12345, model: 'm' }),
        JSON.stringify(null),
      ]);
      const r = await buildCaptureReport();
      expect(r.totalEvents).toBe(1);
      expect(r.blindness.malformedRecords).toBe(3);
    });
  });

  it('does not let an out-of-enum outcome or a prototype key corrupt the counts', async () => {
    await seed([
      JSON.stringify({ ts: 1, event: 'toString', model: 'sonnet', untrusted: false }),
      JSON.stringify({ ts: 2, event: 'remember_invoked', model: 'sonnet', untrusted: false, outcome: 'constructor' }),
      entry({ event: 'capture_eligible', ts: 3 }),
    ]);
    const r = await buildCaptureReport();
    // `'toString' in events` is TRUE on a plain object — the prototype chain, not the data.
    // Incrementing that key yields NaN, which serializes to null and poisons the report.
    expect(JSON.stringify(r.events)).not.toContain('toString');
    expect(r.totalEvents).toBe(2);
    // An unknown outcome must not become a key either.
    expect(r.outcomes).toEqual({});
    expect(Object.values(r.events).every(v => Number.isInteger(v))).toBe(true);
  });

  it('reports the true window bounds even when timestamps are not in file order', async () => {
    // The sink is append-only, so file order is USUALLY chronological — which is exactly
    // why "first line = window start" survives every ordered fixture and then misreports
    // the one window that matters. Concurrent fire-and-forget writers serialize on the
    // append chain, not on `Date.now()`, so a later line CAN carry an earlier stamp.
    await seed([
      entry({ event: 'capture_eligible', ts: 5000 }),
      entry({ event: 'capture_eligible', ts: 1000 }),
      entry({ event: 'capture_eligible', ts: 9000 }),
      entry({ event: 'capture_eligible', ts: 3000 }),
    ]);
    const r = await buildCaptureReport();
    expect(r.windowStart).toBe(1000);
    expect(r.windowEnd).toBe(9000);
  });

  it('does not let an unknown event type dilute the rates', async () => {
    await seed([
      entry({ event: 'capture_eligible' }),
      JSON.stringify({ ts: 2, event: 'some_future_event', model: 'sonnet', untrusted: false }),
      entry({ event: 'remember_invoked', outcome: 'active' }),
    ]);
    const r = await buildCaptureReport();
    // 1/1, not 1/2 — an event this build does not know is not a capture-eligible turn.
    expect(r.fireRate).toBe(1);
    expect(r.totalEvents).toBe(2);
  });

  it('counts untrusted-ingesting eligible turns (the routing half of the funnel)', async () => {
    await seed([
      entry({ event: 'capture_eligible', untrusted: true }),
      entry({ event: 'capture_eligible', untrusted: false }),
      // untrusted on a NON-eligible event must not leak into the eligible tally
      entry({ event: 'propose_shown', untrusted: true }),
    ]);
    const r = await buildCaptureReport();
    expect(r.untrustedEligible).toBe(1);
  });

  it('emits NO entry-id, thread-id or fact text — the report aggregates, it does not echo', async () => {
    await seed([entry({ event: 'propose_confirmed', entryId: 'ke_secret_handle', thread: 'thread_abc' })]);
    const serialized = JSON.stringify(await buildCaptureReport());
    expect(serialized).not.toContain('ke_secret_handle');
    expect(serialized).not.toContain('thread_abc');
  });
});

describe('populations — the two ends of fireRate, counted separately', () => {
  /**
   * One fixture, built so that every wrong ASSIGNMENT produces a different number than
   * every other. It deliberately separates the two things a naive implementation
   * conflates:
   *  - run `r-both` ends TWO eligible turns AND fires TWO remember events, so "distinct
   *    runs" and "event count" differ on BOTH sides. The second remember is what makes
   *    `overlapRuns` load-bearing: with only one, mutating `overlapRuns++` into
   *    `overlapRuns += count` is equivalent and survives the whole file (measured);
   *  - run `r-elig` is denominator-only, `r-rem` is numerator-only, so swapping the two
   *    sets moves `rememberOutsideEligible` from 3 to 1;
   *  - `r-rem` carries THREE remember events, so the outside-count is a count of EVENTS
   *    and not of runs (a run-count would say 1);
   *  - one remember line carries no run at all, so it must land in `eventsWithoutRun` and
   *    in neither population.
   */
  async function seedPopulations(): Promise<void> {
    await seed([
      entry({ event: 'capture_eligible', runId: 'r-both' }),
      entry({ event: 'remember_invoked', runId: 'r-both', outcome: 'active' }),
      entry({ event: 'remember_invoked', runId: 'r-both', outcome: 'active' }),
      entry({ event: 'capture_eligible', runId: 'r-both' }),
      entry({ event: 'capture_eligible', runId: 'r-elig' }),
      entry({ event: 'remember_invoked', runId: 'r-rem', outcome: 'active' }),
      entry({ event: 'remember_invoked', runId: 'r-rem', outcome: 'pending_review' }),
      entry({ event: 'remember_invoked', runId: 'r-rem', outcome: 'active' }),
      entry({ event: 'remember_invoked', outcome: 'active' }),
    ]);
  }

  it('counts distinct RUNS per population, not events', async () => {
    await seedPopulations();
    const { populations } = await buildCaptureReport();
    // 4 eligible events across 2 runs, 6 remember events across 2 runs + 1 unattributed.
    expect(populations.eligibleRuns).toBe(2);
    expect(populations.rememberRuns).toBe(2);
  });

  it('reports the overlap — the only runs the quotient is actually about', async () => {
    await seedPopulations();
    const { populations } = await buildCaptureReport();
    expect(populations.overlapRuns).toBe(1);
  });

  it('counts numerator EVENTS the denominator cannot account for', async () => {
    await seedPopulations();
    const { populations } = await buildCaptureReport();
    // `r-rem` fired three times and never ended an eligible turn: 3 events, not 1 run.
    expect(populations.rememberOutsideEligible).toBe(3);
  });

  it('parks an event with no run id instead of joining it to nothing', async () => {
    await seedPopulations();
    const { populations } = await buildCaptureReport();
    expect(populations.eventsWithoutRun).toBe(1);
    // It must not have invented a run: 2 remember runs, not 3.
    expect(populations.rememberRuns).toBe(2);
  });

  it('carries the caveat IN THE RESPONSE whenever the populations differ', async () => {
    await seedPopulations();
    const { populations } = await buildCaptureReport();
    expect(populations.gapNote).toBe(
      'numerator and denominator do not cover the same runs; this report measures THAT, not why',
    );
  });

  it('says nothing when every remember run also ended an eligible turn', async () => {
    await seed([
      entry({ event: 'capture_eligible', runId: 'r-1' }),
      entry({ event: 'remember_invoked', runId: 'r-1', outcome: 'active' }),
    ]);
    const { populations } = await buildCaptureReport();
    expect(populations).toMatchObject({
      eligibleRuns: 1, rememberRuns: 1, overlapRuns: 1, rememberOutsideEligible: 0, gapNote: null,
    });
  });

  it('flags a numerator population over an EMPTY denominator', async () => {
    // A numerator population over an EMPTY denominator: every remember run is outside, so
    // `rememberOutsideEligible` carries it and no separate clause is needed. This is NOT
    // the shape of the real 910-to-0 sink — that one predates `runId` entirely and lands
    // in the blind-window case below, which is a different failure with a different note.
    await seed([
      entry({ event: 'remember_invoked', runId: 'r-1', outcome: 'active' }),
      entry({ event: 'remember_invoked', runId: 'r-1', outcome: 'active' }),
    ]);
    const { populations, fireRate } = await buildCaptureReport();
    expect(populations).toMatchObject({ eligibleRuns: 0, rememberRuns: 1, overlapRuns: 0 });
    expect(populations.gapNote).not.toBeNull();
    // The headline itself stays null (nothing to divide by) — the split is what carries
    // the story that the numerator was nevertheless busy.
    expect(fireRate).toBeNull();
  });

  it('ignores funnel events — they belong to neither end of the quotient', async () => {
    await seed([
      entry({ event: 'propose_shown', runId: 'r-x' }),
      entry({ event: 'propose_confirmed', runId: 'r-x' }),
      entry({ event: 'onboarding_started', runId: 'r-x' }),
    ]);
    const { populations } = await buildCaptureReport();
    expect(populations).toMatchObject({
      eligibleRuns: 0, rememberRuns: 0, overlapRuns: 0, eventsWithoutRun: 0, gapNote: null,
    });
  });

  it('treats a non-string run id as no run at all', async () => {
    await seed([
      JSON.stringify({ ts: 1000, event: 'remember_invoked', outcome: 'active', runId: 42 }),
      JSON.stringify({ ts: 1000, event: 'capture_eligible', runId: '' }),
    ]);
    const { populations } = await buildCaptureReport();
    expect(populations).toMatchObject({ eligibleRuns: 0, rememberRuns: 0, eventsWithoutRun: 2 });
  });
  it('says "could not look" when NO event carries a run — the 910-to-0 sink itself', async () => {
    // The window this whole split exists for predates `runId`, so every count is zero and
    // `gapNote` is null. Without `blindNote` that output is byte-identical to a healthy
    // instance, and the one sink we built this for would have been the one to stay silent.
    await seed([
      entry({ event: 'capture_eligible' }),
      entry({ event: 'remember_invoked', outcome: 'active' }),
      entry({ event: 'remember_invoked', outcome: 'active' }),
    ]);
    const { populations } = await buildCaptureReport();
    expect(populations).toMatchObject({
      eligibleRuns: 0, rememberRuns: 0, overlapRuns: 0, rememberOutsideEligible: 0,
      eventsWithoutRun: 3, gapNote: null,
    });
    expect(populations.blindNote).toBe(
      'some events could not be joined to a run; the split above covers only part of the window',
    );
  });

  it('stays silent on BOTH notes only when the window is fully joinable and agrees', async () => {
    await seed([
      entry({ event: 'capture_eligible', runId: 'r-1' }),
      entry({ event: 'remember_invoked', runId: 'r-1', outcome: 'active' }),
    ]);
    const { populations } = await buildCaptureReport();
    expect(populations.gapNote).toBeNull();
    expect(populations.blindNote).toBeNull();
  });

  it('clamps an oversized run key instead of retaining it for the whole scan', async () => {
    const huge = 'r'.repeat(500);
    await seed([
      entry({ event: 'capture_eligible', runId: huge }),
      entry({ event: 'remember_invoked', runId: huge.slice(0, 128), outcome: 'active' }),
    ]);
    const { populations } = await buildCaptureReport();
    // Both sides clamp to the same 128 chars, so they still join — the clamp bounds the
    // key without inventing or destroying an overlap.
    expect(populations).toMatchObject({ eligibleRuns: 1, rememberRuns: 1, overlapRuns: 1 });
  });

  it('stops tracking runs at the cap and says so instead of growing without bound', async () => {
    await seed([
      entry({ event: 'capture_eligible', runId: 'r-1' }),
      entry({ event: 'capture_eligible', runId: 'r-2' }),
      entry({ event: 'remember_invoked', runId: 'r-3', outcome: 'active' }),
      entry({ event: 'capture_eligible', runId: 'r-1' }),
    ]);
    const { populations } = await buildCaptureReport({ maxTrackedEntries: 2 });
    // r-1 and r-2 fit; r-3 is over the cap. The repeat of r-1 is already tracked and must
    // NOT count as an overflow — a cap that punished repeat events would report a window
    // as truncated the moment a busy run came back.
    expect(populations).toMatchObject({ eligibleRuns: 2, rememberRuns: 0, eventsOverRunCap: 1 });
    expect(populations.blindNote).not.toBeNull();
  });

  it('counts an ELIGIBLE run over the cap too, and bounds on tracked ENTRIES not runs', async () => {
    // Two things at once, because they share one arithmetic. `r-1` occupies a slot in
    // BOTH collections, so with a cap of 2 the third line overflows even though only two
    // distinct runs exist — the cap bounds tracked entries, which is what bounds memory.
    // And the overflowing line is a `capture_eligible`: without this case, deleting the
    // overflow counter from the eligible branch left the suite green and produced
    // `eventsOverRunCap: 0` with `blindNote: null` — a dropped window reported as a clean
    // one, which is the exact silence this split exists to break.
    await seed([
      entry({ event: 'capture_eligible', runId: 'r-1' }),
      entry({ event: 'remember_invoked', runId: 'r-1', outcome: 'active' }),
      entry({ event: 'capture_eligible', runId: 'r-2' }),
    ]);
    const { populations } = await buildCaptureReport({ maxTrackedEntries: 2 });
    expect(populations).toMatchObject({
      eligibleRuns: 1, rememberRuns: 1, overlapRuns: 1, eventsOverRunCap: 1,
    });
    expect(populations.blindNote).not.toBeNull();
  });
});

describe('rememberBySource — mechanism vs. model compliance', () => {
  /**
   * The field exists so a lifted `fireRate` can be attributed. Carrying it through the
   * validator is NOT enough: a field nothing reports is inert, and the mutation that
   * drops it at the boundary survived every test in the capture suite until this block
   * existed. The three counts are deliberately DISTINCT so a swapped assignment shows.
   */
  it('splits remember_invoked three ways and folds nothing', async () => {
    await seed([
      entry({ event: 'remember_invoked', outcome: 'active', source: 'capture' }),
      entry({ event: 'remember_invoked', outcome: 'active', source: 'capture' }),
      entry({ event: 'remember_invoked', outcome: 'active', source: 'capture' }),
      entry({ event: 'remember_invoked', outcome: 'active', source: 'model' }),
      entry({ event: 'remember_invoked', outcome: 'active', source: 'model' }),
      // No `source` — a line from before the field existed.
      entry({ event: 'remember_invoked', outcome: 'active' }),
      // Not a remember event: must not be counted at all.
      entry({ event: 'propose_shown', source: 'capture' }),
    ]);
    const report = await buildCaptureReport();
    expect(report.rememberBySource).toEqual({ capture: 3, model: 2, unknown: 1 });
    // The sum is the headline numerator — if the split drifts from it, one of the two
    // is wrong and the report would show a rate it cannot attribute.
    const s = report.rememberBySource;
    expect(s.capture + s.model + s.unknown).toBe(report.events.remember_invoked);
  });

  it('an out-of-enum source counts as unknown rather than being invented', async () => {
    await seed([
      entry({ event: 'remember_invoked', outcome: 'active', source: 'telepathy' as unknown as 'model' }),
    ]);
    const report = await buildCaptureReport();
    expect(report.rememberBySource).toEqual({ capture: 0, model: 0, unknown: 1 });
  });
});

describe('capture_ran — the pass announcing that it executed', () => {
  it('is COUNTED, so an empty run is visible in the report and not just in the sink', async () => {
    // Dropping `capture_ran` from ALL_EVENTS left every other test green: the line lands
    // in the file, the validator accepts it, and the report silently omits it. A sink
    // entry nobody aggregates answers no question — which is the same defect the event
    // was added to fix, one layer up.
    await seed([
      entry({ event: 'capture_ran' }),
      entry({ event: 'capture_ran' }),
      entry({ event: 'capture_eligible' }),
    ]);
    const report = await buildCaptureReport();
    expect(report.events['capture_ran']).toBe(2);
    // And it must be a FULL record: a report that omits an event key entirely reads as
    // "this never happened" rather than "this build does not know the key".
    expect(Object.keys(report.events)).toContain('capture_ran');
  });

  it('breaks the passes into the four states the event exists to separate', async () => {
    // The previous version of this test seeded ONLY the dead window and asserted zeros —
    // which follow from EVENT_ZEROES alone, so deleting the entire emit left it green. It
    // described a two-window comparison it never performed. This one seeds all four states
    // at once, with DISTINCT counts so a swapped bucket shows.
    await seed([
      entry({ event: 'capture_eligible' }),
      entry({ event: 'capture_ran' }),                    // facts absent → the pass failed
      entry({ event: 'capture_ran', facts: 0 }),          // completed, nothing found
      entry({ event: 'capture_ran', facts: 0 }),
      entry({ event: 'capture_ran', facts: 3 }),          // completed, proposed 3
      entry({ event: 'capture_ran', facts: 2 }),
    ]);
    const r = await buildCaptureReport();
    expect(r.capturePasses).toEqual({ failed: 1, empty: 2, produced: 2, factsProposed: 5 });
    // …and the one integer that used to be the only answer still agrees with the parts.
    const p = r.capturePasses;
    expect(p.failed + p.empty + p.produced).toBe(r.events['capture_ran']);
  });

  it('a dead mechanism and a working one that finds nothing are DIFFERENT reports', async () => {
    // Stated as the two windows, and actually compared — the distinction is the feature.
    await seed([entry({ event: 'capture_eligible' }), entry({ event: 'capture_eligible' })]);
    const dead = await buildCaptureReport();
    expect(dead.capturePasses).toEqual({ failed: 0, empty: 0, produced: 0, factsProposed: 0 });

    await seed([
      entry({ event: 'capture_eligible' }), entry({ event: 'capture_ran', facts: 0 }),
      entry({ event: 'capture_eligible' }), entry({ event: 'capture_ran', facts: 0 }),
    ]);
    const quiet = await buildCaptureReport();
    expect(quiet.capturePasses.empty).toBe(2);
    expect(quiet.capturePasses, 'a working-but-quiet pass reads as a dead one').not.toEqual(dead.capturePasses);
  });

  it('refuses a nonsense fact count instead of inventing a bucket for it', async () => {
    await seed([
      entry({ event: 'capture_ran', facts: -1 as unknown as number }),
      entry({ event: 'capture_ran', facts: 'drei' as unknown as number }),
    ]);
    const r = await buildCaptureReport();
    // Both fall back to `null`, i.e. "did not complete" — the conservative read. A negative
    // is stopped by `>= 0`, a string by `typeof`; neither touches the finiteness clause,
    // which is why the overflow case below is a SEPARATE test and not a third seed here.
    expect(r.capturePasses.factsProposed).toBe(0);
    expect(r.capturePasses.failed).toBe(2);
  });

  it('does not let an overflowing count turn the total into null', async () => {
    // Written RAW, not via `entry()`: `JSON.stringify` emits Infinity as `null`, so a
    // hostile value can never reach the parser through the helper and the test would prove
    // nothing. The same technique is used for `ts` above, for the same reason — and this
    // field was added WITHOUT the clamp its neighbours carry, so two 1e308 lines summed to
    // Infinity and serialised back as `null`: "the sink is empty" while the counts say
    // otherwise. That exact defect is one of the three this module's docblock lists.
    await seed([
      '{"event":"capture_ran","ts":1,"untrusted":false,"facts":1e999,"proposed":1e999}',
      '{"event":"capture_ran","ts":2,"untrusted":false,"facts":1e308,"proposed":1e308}',
      '{"event":"capture_ran","ts":3,"untrusted":false,"facts":1e308,"proposed":1e308}',
    ]);
    const r = await buildCaptureReport();
    expect(Number.isFinite(r.capturePasses.factsProposed)).toBe(true);
    expect(JSON.parse(JSON.stringify(r)).capturePasses.factsProposed).not.toBeNull();
    // The 1e999 line is unusable and reads as "did not complete"; the two 1e308 lines are
    // clamped rather than dropped, because a huge count is still evidence of a pass.
    expect(r.capturePasses.failed).toBe(1);
    expect(r.capturePasses.produced).toBe(2);
  });

  it('measures what the CEILING costs, not merely what got written', async () => {
    // `facts` is post-ceiling by construction — the cap is applied inside the parser. A
    // report built on it alone cannot tell a turn that offered nine facts from one that
    // offered four, which is precisely how the legacy corpus lost its own distribution to
    // its schema. `proposed` is the pre-ceiling count; the gap is the cost.
    await seed([
      entry({ event: 'capture_ran', facts: 4, proposed: 9 }),
      entry({ event: 'capture_ran', facts: 2, proposed: 2 }),
    ]);
    const r = await buildCaptureReport();
    expect(r.capturePasses.factsProposed).toBe(11);
    expect(r.capturePasses.produced).toBe(2);
  });

  it('falls back to the capped count on a line written before `proposed` existed', async () => {
    await seed(['{"event":"capture_ran","ts":1,"untrusted":false,"facts":3}']);
    const r = await buildCaptureReport();
    // Not zero, and not dropped: an older line still carries a real lower bound.
    expect(r.capturePasses.factsProposed).toBe(3);
  });
});

describe('capture_suppressed — the turns where NOTHING ran', () => {
  it('breaks the hook\'s early exits into the causes the report used to call unmeasured', async () => {
    // Distinct counts per bucket on purpose: equal ones would survive a swapped bucket.
    await seed([
      entry({ event: 'capture_eligible' }),
      entry({ event: 'capture_suppressed', reason: 'no_memory' }),
      entry({ event: 'capture_suppressed', reason: 'no_memory' }),
      entry({ event: 'capture_suppressed', reason: 'no_memory' }),
      entry({ event: 'capture_suppressed', reason: 'extraction_off' }),
      entry({ event: 'capture_suppressed', reason: 'extraction_off' }),
      entry({ event: 'capture_suppressed', reason: 'internal_run' }),
    ]);
    const r = await buildCaptureReport();
    expect(r.suppressed).toEqual({ no_memory: 3, extraction_off: 2, internal_run: 1, fallback_off: 0, unknown: 0 });
    // The parts must agree with the one integer, or one of the two is lying.
    const s = r.suppressed;
    expect(s.no_memory + s.extraction_off + s.internal_run + s.fallback_off + s.unknown).toBe(r.events['capture_suppressed']);
  });

  it('is in ALL_EVENTS — an event nobody aggregates answers nothing', async () => {
    // The mutation that motivates this: dropping the key from ALL_EVENTS leaves the line in
    // the sink, the validator accepting it, and the report silently omitting it. That exact
    // survivor was found one layer down on `capture_ran`.
    await seed([entry({ event: 'capture_suppressed', reason: 'internal_run' })]);
    const r = await buildCaptureReport();
    expect(Object.keys(r.events)).toContain('capture_suppressed');
    expect(r.events['capture_suppressed']).toBe(1);
  });

  it('keeps an unrecognised reason as UNKNOWN rather than dropping the line', async () => {
    // A newer writer against an older reader must read as "cannot tell", never as
    // "did not happen" — the same rule `source` already follows.
    await seed([
      entry({ event: 'capture_suppressed', reason: 'a_future_cause' as never }),
      entry({ event: 'capture_suppressed' }),
    ]);
    const r = await buildCaptureReport();
    expect(r.suppressed.unknown).toBe(2);
    expect(r.events['capture_suppressed']).toBe(2);
  });

  it('does NOT feed the denominator — fireRate is untouched by suppressed turns', async () => {
    // The property the whole change rests on: widening `capture_eligible` mid-window would
    // corrupt the before/after comparison this telemetry exists to serve.
    await seed([
      entry({ event: 'capture_eligible' }),
      entry({ event: 'capture_eligible' }),
      entry({ event: 'remember_invoked', outcome: 'active' }),
    ]);
    const without = await buildCaptureReport();
    await seed([
      entry({ event: 'capture_eligible' }),
      entry({ event: 'capture_eligible' }),
      entry({ event: 'remember_invoked', outcome: 'active' }),
      entry({ event: 'capture_suppressed', reason: 'no_memory' }),
      entry({ event: 'capture_suppressed', reason: 'internal_run' }),
    ]);
    const with_ = await buildCaptureReport();
    expect(with_.fireRate).toBe(without.fireRate);
    expect(with_.events['capture_eligible']).toBe(without.events['capture_eligible']);
  });

  it('a reason on a NON-suppressed event is ignored, not counted', async () => {
    // Otherwise a stray field on an unrelated line inflates the breakdown, and the number
    // that is supposed to explain a gap becomes another source of one.
    await seed([entry({ event: 'capture_eligible', reason: 'no_memory' })]);
    const r = await buildCaptureReport();
    expect(r.suppressed).toEqual({ no_memory: 0, extraction_off: 0, internal_run: 0, fallback_off: 0, unknown: 0 });
  });
});

describe('capture_suppressed — the JOIN that makes its runId worth carrying', () => {
  it('names the runs that are in the numerator and not the denominator', async () => {
    // The gap's SHAPE, not just its size: a run that was suppressed and still wrote a
    // `remember_invoked` is exactly the isolated-memory child the `no_memory` counter is
    // about. Without this the emitted `runId` was inert — read by the validator, used by
    // nothing, which this file warns about twice for other fields.
    await seed([
      entry({ event: 'capture_suppressed', reason: 'no_memory', runId: 'r1' }),
      entry({ event: 'remember_invoked', outcome: 'active', runId: 'r1' }),
      entry({ event: 'capture_suppressed', reason: 'no_memory', runId: 'r2' }),
      entry({ event: 'remember_invoked', outcome: 'active', runId: 'r3' }),
      entry({ event: 'capture_eligible', runId: 'r3' }),
    ]);
    const r = await buildCaptureReport();
    // r1 only: suppressed AND remembered. r2 suppressed but never remembered; r3 remembered
    // but was eligible, so it is not a gap at all.
    expect(r.populations.suppressedRunsAlsoRemembering).toBe(1);
  });

  it('is zero when no suppressed run ever remembered — not merely absent', async () => {
    await seed([
      entry({ event: 'capture_suppressed', reason: 'internal_run', runId: 'r9' }),
      entry({ event: 'capture_eligible', runId: 'r8' }),
      entry({ event: 'remember_invoked', outcome: 'active', runId: 'r8' }),
    ]);
    const r = await buildCaptureReport();
    expect(r.populations.suppressedRunsAlsoRemembering).toBe(0);
    // …and the sibling numbers still read as before, so the join did not disturb them.
    expect(r.populations.overlapRuns).toBe(1);
    expect(r.populations.rememberOutsideEligible).toBe(0);
  });

  it('counts fallback_off, the reason that IS in the denominator', async () => {
    // The partition readers must not lose: three reasons fire INSTEAD of `capture_eligible`,
    // `fallback_off` fires after it. Seeded together so a report cannot merge them.
    await seed([
      entry({ event: 'capture_eligible', runId: 'r1' }),
      entry({ event: 'capture_suppressed', reason: 'fallback_off', runId: 'r1' }),
      entry({ event: 'capture_suppressed', reason: 'no_memory', runId: 'r2' }),
    ]);
    const r = await buildCaptureReport();
    expect(r.suppressed.fallback_off).toBe(1);
    expect(r.suppressed.no_memory).toBe(1);
    expect(r.events['capture_eligible']).toBe(1);
  });

  it('a thread-less suppressed line is NOT counted as lost attribution', async () => {
    // The writer omits `thread` on purpose, so counting it as blindness would make that
    // counter grow with suppression volume and stop meaning "attribution was lost".
    await seed([
      entry({ event: 'capture_suppressed', reason: 'no_memory', thread: undefined }),
      entry({ event: 'capture_eligible', thread: undefined }),
    ]);
    const r = await buildCaptureReport();
    expect(r.blindness.eventsWithoutThread).toBe(1);
  });
});
