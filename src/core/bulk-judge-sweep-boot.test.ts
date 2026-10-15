import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_JUDGED_RETENTION_MS } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT-WIRING proof for the judged runs' retention (PRD bulk-loop §3.1): a started judged
 * run nobody approved is deleted 30 days after its start, because its before-images went to a
 * model. The unit tests call the sweep themselves; only a real boot shows that the engine runs
 * it — and that it does so with `bulk_runs_enabled` off, for a run started before the flag went
 * off. One boot, flag off: the case the wiring is for.
 */
describe('Engine boot — the judged runs\' retention sweep', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let prevDataDir: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('deletes a judged run past its retention at boot with the flag off, and keeps one inside it', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-judge-sweep-boot-'));
    dirs.push(dir);

    // What a process with the flag on left behind: a judged run started 30 days ago, and a newer
    // one whose start replaced it — one started run per instance. The replaced one still holds
    // before-images a model saw, so it is deleted on its own start's clock.
    const seedDb = new EngineDb(join(dir, 'engine.db'));
    const seed = new BulkLedger(seedDb);
    const rule = normalizeJudgeRule({ rule: 'Write a short title.', schema: { title: { type: 'string', maxLength: 40 } } });
    const startedRun = (startedAt: number, supersedes?: string): string => {
      const id = seed.recordDryRun({
        createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'data_store', scope: 'products', targetCollection: 'products',
        targets: [{ key: 'A', before: { absent: false, value: { sku: 'A', title: 'old' } }, after: judgeTemplate(rule) }],
        judge: rule,
      }).id;
      const out = seed.resumePreview(id, startedAt, { judgeRuleHash: seed.getJudgeRuleForOwner(id)!.hash, costCapUsd: 1, supersedes });
      if (!out.ok) throw new Error('fixture: not started');
      return id;
    };
    const stale = startedRun(Date.now() - BULK_JUDGED_RETENTION_MS - 60_000);
    const fresh = startedRun(Date.now() - 60_000, stale);
    const ids = (db: EngineDb): string[] =>
      (db.getDb().prepare('SELECT id FROM bulk_runs ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids(seedDb).sort(), 'fixture guard').toEqual([stale, fresh].sort());
    seedDb.close();

    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    expect(engine.getUserConfig().bulk_runs_enabled, 'the flag is off for this boot').not.toBe(true);
    await engine.init();
    await engine.shutdown();
    engines.length = 0;

    const after = new EngineDb(join(dir, 'engine.db'));
    try {
      expect(ids(after)).toEqual([fresh]);
    } finally {
      after.close();
    }
  });
});
