import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger } from './bulk-ledger.js';
import type { PlannedTarget } from './bulk-ledger.js';
import { runBulkEffect, workspaceWriter } from './bulk-apply.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import type { IAgent } from '../types/index.js';

/**
 * bulk with isolation reaches workspace files through the context workspace's open directory:
 * a run's key is the file's path relative to the workspace, a link on the way or at the file is
 * never followed, and a run planned before keys were relative still means the same files.
 */

let dir: string;
let ws: string;
let outside: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

const agent = (): IAgent =>
  ({ toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent;

const runIdOf = (result: string): string => {
  const m = /Bulk run ([0-9a-f-]{36})/.exec(result);
  if (!m) throw new Error(`no run id in: ${result}`);
  return m[1]!;
};

async function plan(rows: { target: string; after: string }[]): Promise<string> {
  writeFileSync(join(ws, 'src.json'), JSON.stringify(rows));
  return bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json' }, agent());
}

function approve(runId: string): void {
  const out = ledger.approve(runId, { checksum: ledger.computeChecksum(runId)! });
  if (!out.ok) throw new Error(`approve refused: ${out.reason}`);
}

const apply = (runId: string, intent: 'bulk_apply' | 'bulk_undo' = 'bulk_apply') =>
  runBulkEffect(runId, intent, { ledger, writerFor: () => workspaceWriter() });

/** A run as it was recorded before keys were relative: the confined absolute path. */
function recordAbsolute(targets: PlannedTarget[]): string {
  return ledger.recordDryRun({ createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'workspace', targets }).id;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-anchor-')));
  ws = join(dir, 'workspace');
  outside = join(dir, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bulk keys name the file in the workspace the run was planned in', () => {
  it('plans and applies by the absolute key, and makes new files and directories with the umask\'s mode', async () => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'f.txt'), 'before');
    const runId = runIdOf(await plan([{ target: join(ws, 'sub', 'f.txt'), after: 'after' }, { target: 'new/deep/n.txt', after: 'n' }]));
    expect(ledger.getPreview(runId).map((t) => t.key).sort()).toEqual([join(ws, 'new/deep/n.txt'), join(ws, 'sub/f.txt')]);
    approve(runId);
    const before = process.umask(0o027);
    try {
      expect((await apply(runId)).status).toBe('done');
    } finally {
      process.umask(before);
    }
    expect(readFileSync(join(ws, 'sub', 'f.txt'), 'utf8')).toBe('after');
    expect(statSync(join(ws, 'new', 'deep', 'n.txt')).mode & 0o777).toBe(0o640);
    expect(statSync(join(ws, 'new')).mode & 0o777).toBe(0o750);
  });

  it('applies and undoes a run recorded with absolute keys, reaching the same files', async () => {
    writeFileSync(join(ws, 'old.txt'), 'before');
    const runId = recordAbsolute([
      { key: join(ws, 'old.txt'), before: { absent: false, value: 'before' }, after: 'after' },
      { key: join(ws, 'made.txt'), before: { absent: true }, after: 'made' },
    ]);
    approve(runId);
    expect((await apply(runId)).status).toBe('done');
    expect(readFileSync(join(ws, 'old.txt'), 'utf8')).toBe('after');
    expect(readFileSync(join(ws, 'made.txt'), 'utf8')).toBe('made');
    // The undo copies the absolute keys; they still mean the same files.
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    expect((await apply(undo.status.id, 'bulk_undo')).status).toBe('done');
    expect(readFileSync(join(ws, 'old.txt'), 'utf8')).toBe('before');
    expect(existsSync(join(ws, 'made.txt'))).toBe(false);
  });

  it('refuses an absolute key outside the workspace, and touches nothing there', async () => {
    writeFileSync(join(outside, 'x.txt'), 'before');
    const runId = recordAbsolute([{ key: join(outside, 'x.txt'), before: { absent: false, value: 'before' }, after: 'after' }]);
    approve(runId);
    await apply(runId);
    expect(ledger.getPreview(runId)[0]!.error).toBe('path_changed');
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('before');
  });

  it('refuses a run planned in another workspace, and writes nothing in this one', async () => {
    writeFileSync(join(ws, 'src.json'), JSON.stringify([{ target: 'a.txt', after: 'from the first workspace' }]));
    const runId = runIdOf(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json' }, agent()));
    approve(runId);
    const other = join(dir, 'other');
    mkdirSync(other);
    closeWorkspaceBase();
    setTenantWorkspace(other);
    await apply(runId);
    expect(ledger.getPreview(runId)[0]!.error).toBe('path_changed');
    expect(existsSync(join(other, 'a.txt'))).toBe(false);
  });

  it('applies and undoes a run whose workspace is named another way since the plan', async () => {
    const link = join(dir, 'ws-link');
    symlinkSync(ws, link);
    writeFileSync(join(ws, 'r.txt'), 'before');
    // Planned through the link, applied through the real path…
    closeWorkspaceBase();
    setTenantWorkspace(link);
    const runId = runIdOf(await plan([{ target: 'r.txt', after: 'after' }]));
    expect(ledger.getPreview(runId)[0]!.key).toBe(join(ws, 'r.txt'));
    approve(runId);
    closeWorkspaceBase();
    setTenantWorkspace(ws);
    expect((await apply(runId)).status).toBe('done');
    expect(readFileSync(join(ws, 'r.txt'), 'utf8')).toBe('after');
    // …and undone through the link again.
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    closeWorkspaceBase();
    setTenantWorkspace(link);
    expect((await apply(undo.status.id, 'bulk_undo')).status).toBe('done');
    expect(readFileSync(join(ws, 'r.txt'), 'utf8')).toBe('before');
  });

  it('does not carry setuid or setgid onto the file it writes', async () => {
    writeFileSync(join(ws, 's.sh'), 'before');
    chmodSync(join(ws, 's.sh'), 0o6755);
    const runId = runIdOf(await plan([{ target: 's.sh', after: 'after' }]));
    approve(runId);
    expect((await apply(runId)).status).toBe('done');
    expect(statSync(join(ws, 's.sh')).mode & 0o7777).toBe(0o755);
  });

  it('refuses a key that names no file in the workspace, as path_changed', async () => {
    writeFileSync(join(outside, 'x.txt'), 'before');
    writeFileSync(join(ws, 'x.txt'), 'before');
    // A relative key is refused even where it would resolve into the workspace: run from inside it.
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      for (const key of ['', 'x.txt', './x.txt', '../outside/x.txt', 'a/../../outside/x.txt', `${ws}/../outside/x.txt`, ws, `${ws}/`]) {
        const runId = recordAbsolute([{ key, before: { absent: false, value: 'before' }, after: 'after' }]);
        approve(runId);
        await apply(runId);
        expect(ledger.getPreview(runId)[0]!.error, JSON.stringify(key)).toBe('path_changed');
      }
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('before');
    expect(readFileSync(join(ws, 'x.txt'), 'utf8')).toBe('before');
  });
});

describe('bulk_plan does not follow links', () => {
  it('marks a target behind a link on the way invalid, also a link that stays in the workspace', async () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'f');
    symlinkSync(join(ws, 'real'), join(ws, 'inner'));
    symlinkSync(outside, join(ws, 'outer'));
    writeFileSync(join(outside, 'f.txt'), 'outside');
    const out = await plan([{ target: 'inner/f.txt', after: 'x' }, { target: 'outer/f.txt', after: 'x' }, { target: 'outer/new.txt', after: 'x' }]);
    expect(out).toContain('invalid 3 (path_outside_workspace 3)');
    expect(ledger.getPreview(runIdOf(out)).every((t) => t.before === null)).toBe(true);
  });

  it('marks a link at the file, a file with a second name and a FIFO unreadable, without blocking', async () => {
    writeFileSync(join(outside, 't.txt'), 'outside');
    symlinkSync(join(outside, 't.txt'), join(ws, 'leaf.txt'));
    linkSync(join(outside, 't.txt'), join(ws, 'hard.txt'));
    execFileSync('mkfifo', [join(ws, 'pipe.txt')]);
    const out = await plan([{ target: 'leaf.txt', after: 'x' }, { target: 'hard.txt', after: 'x' }, { target: 'pipe.txt', after: 'x' }]);
    expect(out).toContain('invalid 3 (unreadable 3)');
  });

  it('refuses a target named through /proc or above the workspace', async () => {
    writeFileSync(join(ws, 'in.txt'), 'in');
    const out = await plan([{ target: `/proc/self/root${ws}/in.txt`, after: 'x' }, { target: '../outside/x.txt', after: 'x' }]);
    expect(out).toContain('invalid 2 (path_outside_workspace 2)');
  });

  it('refuses a source file behind a link', async () => {
    writeFileSync(join(outside, 'src.json'), JSON.stringify([{ target: 'a.txt', after: 'x' }]));
    symlinkSync(join(outside, 'src.json'), join(ws, 'linked.json'));
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'linked.json' }, agent()))
      .toBe('Error: The source file is not a readable file.');
  });
});

describe('bulk_apply refuses what changed since the plan', () => {
  // One target per run: a run halts once more than 5 % of its targets failed.
  async function changedAfterPlan(target: string, change: () => void): Promise<string | null> {
    const runId = runIdOf(await plan([{ target, after: 'after' }]));
    approve(runId);
    change();
    await apply(runId);
    return ledger.getPreview(runId)[0]!.error;
  }

  it('a link planted on the way is path_changed, and nothing is written behind it', async () => {
    mkdirSync(join(ws, 'd'));
    writeFileSync(join(ws, 'd', 'a.txt'), 'before');
    expect(await changedAfterPlan('d/a.txt', () => {
      rmSync(join(ws, 'd'), { recursive: true });
      mkdirSync(join(outside, 'd'));
      writeFileSync(join(outside, 'd', 'a.txt'), 'before');
      symlinkSync(join(outside, 'd'), join(ws, 'd'));
    })).toBe('path_changed');
    expect(readFileSync(join(outside, 'd', 'a.txt'), 'utf8')).toBe('before');
  });

  it('a second name given to the file is a conflict, and the file is not written', async () => {
    writeFileSync(join(ws, 'h.txt'), 'before');
    expect(await changedAfterPlan('h.txt', () => linkSync(join(ws, 'h.txt'), join(outside, 'h2.txt')))).toBe('conflict');
    expect(readFileSync(join(outside, 'h2.txt'), 'utf8')).toBe('before');
  });

  it('a FIFO in the file\'s place is a conflict, without blocking', async () => {
    writeFileSync(join(ws, 'p.txt'), 'before');
    expect(await changedAfterPlan('p.txt', () => {
      rmSync(join(ws, 'p.txt'));
      execFileSync('mkfifo', [join(ws, 'p.txt')]);
    })).toBe('conflict');
    expect(lstatSync(join(ws, 'p.txt')).isFIFO()).toBe(true);
  });

  it('keeps an existing file\'s mode, and a write that fails is failed, with nothing left behind', async () => {
    writeFileSync(join(ws, 'x.sh'), 'old', { mode: 0o750 });
    mkdirSync(join(ws, 'ro'));
    writeFileSync(join(ws, 'ro', 'r.txt'), 'before');
    const runId = runIdOf(await plan([{ target: 'x.sh', after: 'new' }, { target: 'ro/r.txt', after: 'after' }]));
    approve(runId);
    chmodSync(join(ws, 'ro'), 0o555);
    try {
      await apply(runId);
    } finally {
      chmodSync(join(ws, 'ro'), 0o755);
    }
    expect(statSync(join(ws, 'x.sh')).mode & 0o777).toBe(0o750);
    if (process.getuid?.() !== 0) {
      expect(ledger.getPreview(runId).find((t) => t.key === join(ws, 'ro/r.txt'))!.error).toBe('write_failed');
      expect(readFileSync(join(ws, 'ro', 'r.txt'), 'utf8')).toBe('before');
    }
  });
});
