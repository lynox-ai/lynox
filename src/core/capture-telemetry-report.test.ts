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
