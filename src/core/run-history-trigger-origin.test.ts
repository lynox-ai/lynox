import { describe, it, expect } from 'vitest';
import { RunHistory } from './run-history.js';

/**
 * Run attribution (arc:model-selector P1, DEF-0097): `insertRun` persists
 * `trigger_origin` (v48). A WorkerLoop turn carries its trigger source; a user
 * chat turn passes nothing → NULL = "unattributed / legacy". Verified against the
 * REAL migration path.
 */
describe('RunHistory trigger_origin (P1 run attribution)', () => {
  it('persists a supplied trigger_origin and leaves a user turn NULL', () => {
    const rh = new RunHistory(':memory:');
    const db = rh.getDb();

    const cronId = rh.insertRun({ taskText: 'nightly', modelTier: 'fast', modelId: 'claude-haiku-4-5-20251001', triggerOrigin: 'cron' });
    const watchId = rh.insertRun({ taskText: 'watch', modelTier: 'fast', modelId: 'claude-haiku-4-5-20251001', triggerOrigin: 'watch' });
    const userId = rh.insertRun({ taskText: 'hello', modelTier: 'balanced', modelId: 'claude-sonnet-4-6' });

    const originOf = (id: string) =>
      (db.prepare('SELECT trigger_origin FROM runs WHERE id = ?').get(id) as { trigger_origin: string | null }).trigger_origin;

    expect(originOf(cronId)).toBe('cron');
    expect(originOf(watchId)).toBe('watch');
    expect(originOf(userId)).toBeNull();

    rh.close();
  });
});
