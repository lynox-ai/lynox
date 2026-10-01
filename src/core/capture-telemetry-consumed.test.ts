/**
 * Every field this sink WRITES must be read by the report — enforced by behaviour, not by grep.
 *
 * WHY THIS EXISTS, and the count is the argument: the "written, validated, consumed by nothing"
 * defect has occurred FOUR times in this one sink — `facts`, `source`, `capture_ran`'s presence
 * in `ALL_EVENTS`, and `cause` on the numerator. Three of those were caught by a reviewer, and
 * each time the fix was accompanied by a comment warning against exactly that defect. The fifth
 * was going to happen too: a rule that has been restated four times and broken four times is not
 * a rule, it is a wish. So it becomes a mechanism.
 *
 * HOW, and it is deliberately not a source scan. A grep for a field name proves a string exists,
 * not that the value reaches an output — the sink's own history includes a field that was read
 * by the validator and dropped before any aggregate, which every string check would have passed.
 * Instead each field is PERTURBED: build the report twice from otherwise identical sinks that
 * differ in exactly one field, and require the two reports to differ. If changing a value cannot
 * change any number, nothing consumes it.
 *
 * A field that legitimately has no consumer goes in `DECLARED_UNCONSUMED` with a reason. That
 * list is the point of the guard: it makes "nobody reads this" a written decision instead of an
 * accident, and adding a field silently is what stops being possible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPTURE_TELEMETRY_LOG_FILE, type CaptureTelemetryEntry } from './capture-telemetry.js';
import { buildCaptureReport } from './capture-telemetry-report.js';

let dir: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cap-consumed-'));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = dir;
});
afterEach(async () => {
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  await rm(dir, { recursive: true, force: true });
});

/**
 * Fields with no reader, each with the reason it is acceptable. Adding a name here is a
 * decision someone has to write down; leaving one out makes the test fail.
 */
const DECLARED_UNCONSUMED: Readonly<Record<string, string>> = {
  // The onboarding funnel (PRD-ONBOARDING §7) rides this sink but is read by the onboarding
  // analysis, not by the capture report. They are listed together because they arrived together
  // and share one consumer that lives outside this file.
  entryId: 'propose_* payload; read by the onboarding funnel analysis, not the capture report',
  dismissed: 'propose_ignored payload; same consumer as entryId',
  captureSource: 'propose_* payload; same consumer as entryId',
  subjectKind: 'propose_* payload; same consumer as entryId',
  confidence: 'propose_* payload; same consumer as entryId',
  primary: 'propose_* payload; same consumer as entryId',
  step: 'onboarding_* funnel index; same consumer as entryId',
};

/**
 * One probe per (FIELD, EVENT) pair that a writer actually sets — not per field.
 *
 * The first cut probed each field once, on whichever event was convenient, and MISSED the very
 * defect it was written for: dropping `cause`'s consumption on `remember_invoked` left it green,
 * because the `cause` probe rode `capture_eligible`. A field can be consumed on one event and
 * dropped on another, and that is exactly the shape that has now occurred four times. The unit
 * of the defect is the pair, so the unit of the guard is the pair.
 */
const PROBES: ReadonlyArray<readonly [string, string, unknown, unknown]> = [
  ['ts', 'capture_eligible', 1000, 999_000],
  ['event', 'capture_eligible', 'capture_eligible', 'remember_invoked'],
  ['thread', 'capture_eligible', 't1', undefined],
  ['model', 'capture_eligible', 'model-a', 'model-b'],
  ['untrusted', 'capture_eligible', false, true],
  ['outcome', 'remember_invoked', 'active', 'pending_review'],
  ['facts', 'capture_ran', 0, 3],
  ['proposed', 'capture_ran', 1, 9],
  ['source', 'remember_invoked', 'model', 'capture'],
  ['runId', 'capture_eligible', 'r1', undefined],
  ['runId', 'remember_invoked', 'r1', undefined],
  ['runId', 'capture_suppressed', 'r1', undefined],
  // The pair the first version could not see. All three writers of `cause` get their own row.
  ['cause', 'capture_eligible', 'none', 'conversation'],
  ['cause', 'remember_invoked', 'none', 'conversation'],
  ['cause', 'capture_ran', 'none', 'conversation'],
  ['reason', 'capture_suppressed', 'no_memory', 'internal_run'],
  // Per-fact routing. Only the recovery pass writes it, so the probe has to carry
  // `source: 'capture'` to reach the branch at all (see REACH) — without it the line is
  // counted as a tool write, the routing breakdown stays all-zero for both values, and the
  // probe reports consumption that is really its own blindness.
  ['routing', 'remember_invoked', 'fact_user_stated', 'fact_external'],
];

/**
 * Extra fields a probe needs to REACH its branch. `proposed` is only read on the produced path
 * (`facts` present and non-zero); `capture_suppressed` needs a reason before its run id is
 * collected. Without these the probe lands short of the code it tests and reports a defect that
 * is really a blind probe — which is what the first run of this file did.
 */
const REACH: Readonly<Record<string, Record<string, unknown>>> = {
  'proposed|capture_ran': { facts: 2 },
  'runId|capture_suppressed': { reason: 'no_memory' },
  'cause|capture_ran': { facts: 1 },
  'routing|remember_invoked': { source: 'capture', outcome: 'active' },
};

/**
 * Some consumers only move with a SECOND line. A suppressed run id is read through
 * `suppressedRunsAlsoRemembering`, which by definition needs a `remember_invoked` on the same
 * run — with one line the count is zero whatever the id says, and the probe reports a defect
 * that is really its own blindness.
 */
const COMPANION: Readonly<Record<string, Record<string, unknown>>> = {
  'runId|capture_suppressed': { ts: 1001, event: 'remember_invoked', thread: 't1', model: 'model-a', untrusted: false, outcome: 'active', runId: 'r1' },
};

async function reportWith(field: string, event: string, value: unknown): Promise<string> {
  const base: Record<string, unknown> = {
    ts: 1000, event, thread: 't1', model: 'model-a', untrusted: false, runId: 'r1',
  };
  Object.assign(base, REACH[`${field}|${event}`] ?? {});
  base[field] = value;
  if (value === undefined) delete base[field];
  const companion = COMPANION[`${field}|${event}`];
  const lines = companion ? [JSON.stringify(base), JSON.stringify(companion)] : [JSON.stringify(base)];
  await writeFile(path.join(dir, CAPTURE_TELEMETRY_LOG_FILE), lines.join('\n') + '\n', 'utf8');
  return JSON.stringify(await buildCaptureReport());
}

describe('capture telemetry — every written field reaches the report', () => {
  for (const [field, event, a, b] of PROBES) {
    it(`\`${field}\` on \`${event}\` changes the report when it changes`, async () => {
      const left = await reportWith(field, event, a);
      const right = await reportWith(field, event, b);
      expect(left, `nothing in the report reads \`${field}\` on \`${event}\` — written, validated, dropped`)
        .not.toBe(right);
    });
  }

  it('every CaptureRouting value reaches the report — a new one cannot be dropped', () => {
    // The sibling of the field guard below, for the ENUM. `routing` is enumerated in five
    // places (the type, KNOWN_ROUTINGS, three accumulator objects, the emitted list), and
    // adding a value while missing one of them drops it into no bucket at all — counted
    // nowhere, reported as absent, indistinguishable from "never happened".
    //
    // Behavioural, not a source scan: each value is WRITTEN to a sink and the report must
    // come back carrying it. A grep would pass on a value that is listed and then filtered
    // out downstream, which is the exact shape of the defect it would be guarding against.
    const src = readFileSync(path.join(__dirname, 'capture-telemetry.ts'), 'utf8');
    const decl = src.slice(src.indexOf('export type CaptureRouting'));
    const values = [...decl.slice(0, decl.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(values.length, 'the type was not parsed — the guard would pass vacuously').toBeGreaterThan(3);
    return (async () => {
      for (const v of values) {
        const line = { ts: 1000, event: 'remember_invoked', thread: 't1', model: 'm',
          untrusted: true, runId: 'r1', source: 'capture', outcome: 'active', routing: v };
        await writeFile(path.join(dir, CAPTURE_TELEMETRY_LOG_FILE), JSON.stringify(line) + '\n', 'utf8');
        const report = await buildCaptureReport() as unknown as { routing?: Array<{ rule: string; facts: number }> };
        const row = report.routing?.find((r) => r.rule === v);
        expect(row, `routing value \`${v}\` reaches no row in the report`).toBeDefined();
        expect(row!.facts, `routing value \`${v}\` is listed but counts nothing`).toBe(1);
      }
    })();
  });

  it('the probe list covers every declared field — a new field cannot slip in unprobed', () => {
    // The half that makes the tests above complete rather than merely present. Without it,
    // adding a field and forgetting to probe it passes silently, which is the exact failure
    // mode this file exists for. Read from the SOURCE because the interface is erased at
    // runtime; the shape is pinned, not the prose.
    const src = readFileSync(path.join(__dirname, 'capture-telemetry.ts'), 'utf8');
    const iface = src.slice(src.indexOf('export interface CaptureTelemetryEntry'));
    const body = iface.slice(0, iface.indexOf('\n}'));
    const declared = [...body.matchAll(/^\s{2}readonly (\w+)\??:/gm)].map((m) => m[1]!);
    expect(declared.length, 'the interface was not parsed — the guard would pass vacuously').toBeGreaterThan(10);
    const probed = new Set(PROBES.map(([f]) => f));
    const unhandled = declared.filter((f) => !probed.has(f) && !(f in DECLARED_UNCONSUMED));
    expect(unhandled, 'field(s) neither probed nor declared unconsumed — add a probe or a reason')
      .toEqual([]);
  });
});
