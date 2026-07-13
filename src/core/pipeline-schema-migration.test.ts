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

  it('returns null for a blob already at the current version (no rewrite)', () => {
    const current = JSON.stringify({ id: 'wf1', schema_version: CURRENT_PIPELINE_SCHEMA_VERSION });
    expect(migratePipelineBlob(current)).toBeNull();
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
});
