import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBoundedJsonl } from './bounded-jsonl-log.js';

/**
 * DEF-0011 — the shared size-rotation that bounds the opt-in telemetry sinks
 * (`retrieval-shadow.jsonl` / `memory-write.jsonl` / `context-cost.jsonl`) before
 * `retrieval_shadow_log` is enabled fleet-wide on customer data.
 */
describe('bounded-jsonl-log — retention + best-effort', () => {
  const FILE = 'test-sink.jsonl';
  let dir: string;
  let prevDataDir: string | undefined;
  let prevMaxBytes: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lynox-bjl-'));
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    prevMaxBytes = process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'];
    process.env['LYNOX_DATA_DIR'] = dir;
    delete process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'];
  });
  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    if (prevMaxBytes === undefined) delete process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'];
    else process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = prevMaxBytes;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** Read all retained records (live file + one rotated `.1`), newest generation last. */
  async function readAll(): Promise<Array<{ seq: number }>> {
    const out: Array<{ seq: number }> = [];
    for (const name of [`${FILE}.1`, FILE]) {
      const body = await readFile(join(dir, name), 'utf8').catch(() => '');
      for (const line of body.split('\n')) {
        if (line.trim().length > 0) out.push(JSON.parse(line) as { seq: number });
      }
    }
    return out;
  }

  it('appends a parseable JSON line to the data dir', async () => {
    await appendBoundedJsonl(FILE, { seq: 1, hello: 'world' });
    const body = await readFile(join(dir, FILE), 'utf8');
    expect(JSON.parse(body.trim())).toEqual({ seq: 1, hello: 'world' });
  });

  it('does NOT rotate below the cap — many small lines stay in one file', async () => {
    for (let i = 0; i < 50; i++) await appendBoundedJsonl(FILE, { seq: i });
    const rotated = await stat(join(dir, `${FILE}.1`)).then(() => true).catch(() => false);
    expect(rotated).toBe(false);
    expect(await readAll()).toHaveLength(50);
  });

  it('rotates to `.1` at the cap and loses NOTHING across one generation', async () => {
    process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = String(64 * 1024); // the floor
    const pad = 'x'.repeat(8 * 1024); // ~8 KiB/line → ~8 lines fill one 64 KiB generation
    for (let i = 0; i < 12; i++) await appendBoundedJsonl(FILE, { seq: i, pad });
    const rotated = await stat(join(dir, `${FILE}.1`)).then(() => true).catch(() => false);
    expect(rotated).toBe(true); // the cap was crossed
    const all = await readAll();
    // One rotation → live + `.1` together still hold every one of the 12 records.
    expect(all.map(r => r.seq).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('keeps only one rotated generation — the oldest records are dropped past the ceiling', async () => {
    process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = String(64 * 1024);
    const pad = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 30; i++) await appendBoundedJsonl(FILE, { seq: i, pad }); // ≥ 2 rotations
    const all = await readAll();
    const seqs = all.map(r => r.seq);
    // Bounded: on disk ≤ 2× cap, so far fewer than 30 records survive.
    expect(all.length).toBeLessThan(30);
    // The survivors are the NEWEST — the last record is present, the first is gone.
    expect(seqs).toContain(29);
    expect(seqs).not.toContain(0);
    // Exactly a contiguous newest suffix [min..29] — no gaps, no interleaving, no dupes.
    const min = Math.min(...seqs);
    expect(seqs).toEqual(Array.from({ length: 29 - min + 1 }, (_v, i) => min + i));
  });

  it('best-effort: never throws when the data dir is a FILE (ENOTDIR)', async () => {
    const notADir = join(dir, 'not-a-dir');
    await writeFile(notADir, 'x');
    process.env['LYNOX_DATA_DIR'] = notADir;
    await expect(appendBoundedJsonl(FILE, { seq: 1 })).resolves.toBeUndefined();
  });

  it('a sub-floor cap override is ignored (falls back to default → no thrash-rotation)', async () => {
    process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = '1024'; // below the 64 KiB floor
    for (let i = 0; i < 20; i++) await appendBoundedJsonl(FILE, { seq: i });
    const rotated = await stat(join(dir, `${FILE}.1`)).then(() => true).catch(() => false);
    expect(rotated).toBe(false); // default cap (32 MiB) applied, not 1 KiB
    expect(await readAll()).toHaveLength(20);
  });

  it('serialized per file — concurrent writers never tear a line', async () => {
    await Promise.all(Array.from({ length: 100 }, (_v, i) => appendBoundedJsonl(FILE, { seq: i })));
    const all = await readAll();
    expect(all).toHaveLength(100);
    expect(new Set(all.map(r => r.seq)).size).toBe(100); // every line intact + parseable
  });

  it('concurrent writers RACING a rotation stay bounded + every line intact', async () => {
    // Low cap so the burst crosses the cap mid-flight — this exercises the interleave
    // (stat → rename → append) the per-file chain exists to serialize.
    process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = String(64 * 1024);
    const pad = 'x'.repeat(4 * 1024);
    await Promise.all(Array.from({ length: 60 }, (_v, i) => appendBoundedJsonl(FILE, { seq: i, pad })));
    const all = await readAll();
    // Bounded (rotations dropped older generations) and NOTHING is torn: every survivor
    // parses, no dupes, and the survivors are a contiguous newest suffix ending at 59.
    expect(all.length).toBeLessThan(60);
    const seqs = all.map(r => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no dupes / torn re-reads
    expect(Math.max(...seqs)).toBe(59);
    const min = Math.min(...seqs);
    expect(seqs).toEqual(Array.from({ length: 59 - min + 1 }, (_v, i) => min + i));
  });

  it('default cap is MiB-scale — a MiB→KiB regression would rotate here, it must not', async () => {
    // No env override → the compiled DEFAULT_MAX_BYTES applies. ~1 MiB of data must NOT
    // rotate; it would if the default were mistyped to a KiB-scale value.
    const pad = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 128; i++) await appendBoundedJsonl(FILE, { seq: i, pad }); // ~1 MiB
    const rotated = await stat(join(dir, `${FILE}.1`)).then(() => true).catch(() => false);
    expect(rotated).toBe(false);
  });

  it('a non-numeric cap override falls back to the default', async () => {
    process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = 'not-a-number';
    for (let i = 0; i < 20; i++) await appendBoundedJsonl(FILE, { seq: i });
    const rotated = await stat(join(dir, `${FILE}.1`)).then(() => true).catch(() => false);
    expect(rotated).toBe(false);
    expect(await readAll()).toHaveLength(20);
  });

  it('best-effort: a rotation whose rename fails never throws and keeps the live file', async () => {
    process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'] = String(64 * 1024);
    // Block the rotation target: rename(FILE, FILE.1) fails when `.1` is a non-empty dir.
    await mkdir(join(dir, `${FILE}.1`), { recursive: true });
    await writeFile(join(dir, `${FILE}.1`, 'occupied'), 'x');
    const pad = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 12; i++) {
      await expect(appendBoundedJsonl(FILE, { seq: i, pad })).resolves.toBeUndefined();
    }
    // Rotation could not happen, so the live file simply kept growing (still bounded by
    // the cap on every FUTURE successful rotate) — the data was never lost or thrown away.
    const live = await readFile(join(dir, FILE), 'utf8');
    expect(live.trim().split('\n').length).toBe(12);
  });
});
