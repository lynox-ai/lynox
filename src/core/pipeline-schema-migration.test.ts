import { describe, it, expect } from 'vitest';
import { migratePipelineBlob, CURRENT_PIPELINE_SCHEMA_VERSION } from './pipeline-schema-migration.js';

describe('pipeline-schema-migration (Move 1 — content-model versioning)', () => {
  it('CURRENT version is a positive integer', () => {
    expect(Number.isInteger(CURRENT_PIPELINE_SCHEMA_VERSION)).toBe(true);
    expect(CURRENT_PIPELINE_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('stamps a legacy blob (no schema_version) to the current version without changing other content', () => {
    const legacy = JSON.stringify({ id: 'wf1', name: 'Weekly', goal: 'g', steps: [{ id: 's1', task: 't' }] });
    const out = migratePipelineBlob(legacy);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    expect(parsed['id']).toBe('wf1');
    expect(parsed['name']).toBe('Weekly');
    expect(parsed['goal']).toBe('g');
    expect(parsed['steps']).toEqual([{ id: 's1', task: 't' }]);
  });

  it('v0→v1 backfill: first-run-confirms a legacy self-built template (F1 regression guard)', () => {
    // A pre-versioning template predates the import feature → self-built. The
    // v2.7.0 consent gate would otherwise retroactively refuse it at /run + cron.
    const legacyTemplate = JSON.stringify({ id: 'wf1', name: 'Weekly', template: true, steps: [{ id: 's1', task: 't' }] });
    const parsed = JSON.parse(migratePipelineBlob(legacyTemplate)!) as Record<string, unknown>;
    expect(parsed['confirmedAt']).toBeTruthy();
    expect(parsed['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
  });

  it('v0→v1 backfill: does NOT overwrite an existing confirmedAt', () => {
    const already = JSON.stringify({ id: 'wf1', template: true, confirmedAt: '2026-01-01T00:00:00.000Z', steps: [] });
    const parsed = JSON.parse(migratePipelineBlob(already)!) as Record<string, unknown>;
    expect(parsed['confirmedAt']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('v0→v1 backfill: leaves a non-template (plan_task) blob unconfirmed', () => {
    // template:false is not library-runnable → no consent gate applies, no stamp.
    const nonTemplate = JSON.stringify({ id: 'wf1', template: false, steps: [] });
    const parsed = JSON.parse(migratePipelineBlob(nonTemplate)!) as Record<string, unknown>;
    expect(parsed['confirmedAt']).toBeUndefined();
  });

  it('returns null for a blob already at the current version (no rewrite)', () => {
    const current = JSON.stringify({ id: 'wf1', schema_version: CURRENT_PIPELINE_SCHEMA_VERSION });
    expect(migratePipelineBlob(current)).toBeNull();
  });

  it('an already-versioned (imported) template is NOT retro-confirmed by the v0→v1 backfill', () => {
    // An imported blob is stamped at CURRENT on persist, so it never enters the
    // v0→v1 step and stays unconfirmed by design — the backfill is v0-only.
    const importedAtV1 = JSON.stringify({ id: 'wf-imp', template: true, schema_version: CURRENT_PIPELINE_SCHEMA_VERSION, steps: [] });
    expect(migratePipelineBlob(importedAtV1)).toBeNull(); // no rewrite → confirmedAt never added
  });

  it('is idempotent — feeding the migrated output back returns null', () => {
    const once = migratePipelineBlob(JSON.stringify({ id: 'wf1', name: 'W' }));
    expect(once).not.toBeNull();
    expect(migratePipelineBlob(once!)).toBeNull();
  });

  it('is forward-only — a blob NEWER than known is never downgraded', () => {
    const future = JSON.stringify({ id: 'wf1', schema_version: CURRENT_PIPELINE_SCHEMA_VERSION + 5, x: 1 });
    expect(migratePipelineBlob(future)).toBeNull();
  });

  it('leaves a malformed / non-object blob untouched (returns null, never throws)', () => {
    expect(migratePipelineBlob('not json {')).toBeNull();
    expect(migratePipelineBlob('42')).toBeNull();
    expect(migratePipelineBlob('null')).toBeNull();
    expect(migratePipelineBlob('[1,2,3]')).toBeNull();
    expect(migratePipelineBlob('"a string"')).toBeNull();
  });

  it('treats a non-numeric schema_version as v0 (legacy) and stamps forward', () => {
    const out = migratePipelineBlob(JSON.stringify({ id: 'wf1', schema_version: 'bogus' }));
    expect(out).not.toBeNull();
    expect((JSON.parse(out!) as Record<string, unknown>)['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
  });

  it('clamps a fractional or negative schema_version to v0 and stamps forward (no overshoot, no boot-hang)', () => {
    // A huge NEGATIVE would, without the clamp, drive the `v + 1` loop ~1e15 times.
    for (const bad of [0.5, -1, -1e15]) {
      const out = migratePipelineBlob(JSON.stringify({ id: 'wf1', schema_version: bad }));
      expect(out).not.toBeNull();
      expect((JSON.parse(out!) as Record<string, unknown>)['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    }
  });

  it('leaves a blob claiming a version FAR newer than known untouched (forward-only, no downgrade, no loop)', () => {
    expect(migratePipelineBlob(JSON.stringify({ id: 'wf1', schema_version: CURRENT_PIPELINE_SCHEMA_VERSION + 1e6 }))).toBeNull();
  });

  it('treats a null schema_version as v0 (JSON has no NaN/Infinity literal — both serialize to null)', () => {
    const out = migratePipelineBlob('{"id":"wf1","schema_version":null}');
    expect(out).not.toBeNull();
    expect((JSON.parse(out!) as Record<string, unknown>)['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
  });

  it('v1→v2 drops the legacy executionMode tombstone (first real content transform)', () => {
    const out = migratePipelineBlob(JSON.stringify({ id: 'wf1', name: 'W', executionMode: 'tracked', schema_version: 1 }));
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    expect('executionMode' in parsed).toBe(false);
    expect(parsed['name']).toBe('W'); // other content preserved
  });

  it('migrates a v0 legacy blob straight through to v2, dropping executionMode en route (identity then transform)', () => {
    const out = migratePipelineBlob(JSON.stringify({ id: 'wf1', name: 'W', executionMode: 'orchestrated' }));
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    expect('executionMode' in parsed).toBe(false);
  });
});
