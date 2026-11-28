import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool, bulkStatusTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import { ArtifactStore } from '../../core/artifact-store.js';
import { DataStore } from '../../core/data-store.js';
import { canonicalJson } from '../../core/bulk-ledger.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';
import { TEST_STAMP } from '../../../tests/helpers/row-stamp.js';
import type { MemoryScopeRef } from '../../types/index.js';

const scope: MemoryScopeRef = { type: 'context', id: 'bulk-rule-artifact-test' };
import { judgeRuleSourceChanged, normalizeJudgeRule } from '../../core/bulk-judge-rule.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';
import type { IAgent } from '../../types/index.js';

/**
 * A judge rule named by its saved artifact reaches the run as the artifact holds it, byte for
 * byte: the model does not retype it on the way (it spelled out umlauts, dropped quoted examples
 * and changed quotation marks when it did).
 */

// Typographic quotes, umlauts, an apostrophe, a dash, two lines and the closing line break: every
// kind of character the retyping changed.
const RULE_TEXT = 'R1 Schreibe „sachlich“ – keine Superlative.\nR2 Beispiel: „Bio-Hanföl, kaltgepresst“; nie „das beste Öl“.\nR3 Max. 160 Zeichen, Kund:innen werden nicht geduzt. It’s fine.\n';
const MANDATE = { kind: 'mandate', email: 'helper@example.ch', mandateId: 'M-1' } as RequestPrincipal;

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let artifacts: ArtifactStore;
let data: DataStore;

function agent(principal: RequestPrincipal = OWNER_PRINCIPAL, store: Pick<ArtifactStore, 'get'> | null = artifacts): IAgent {
  return { toolContext: { bulkLedger: ledger, artifactStore: store, dataStore: data }, currentThreadId: 'thread-1', principal } as unknown as IAgent;
}

const plan = (judge: Record<string, unknown>, principal?: RequestPrincipal, store?: Pick<ArtifactStore, 'get'> | null): Promise<string> => bulkPlanTool.handler({
  target_system: 'http', target_host: 'shop.example.com',
  source_list: { path: '/wp-json/wc/v3/products' },
  judge: { schema: { description: { type: 'string', maxLength: 2000 } }, ...judge },
} as unknown as Parameters<typeof bulkPlanTool.handler>[0], store === undefined ? agent(principal) : agent(principal, store));

const runId = (out: string): string => /Bulk run ([0-9a-f-]{36})/.exec(out)![1]!;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-rule-artifact-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
  mkdirSync(join(dir, 'artifacts'));
  artifacts = new ArtifactStore(join(dir, 'artifacts'));
  mkdirSync(join(dir, 'workspace'));
  setTenantWorkspace(join(dir, 'workspace'));
  data = new DataStore(join(dir, 'datastore.db'));
});
afterEach(() => {
  clearTenantWorkspace();
  data.close();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bulk_plan takes a judge rule from a saved artifact', () => {
  it('stores the artifact\'s text byte for byte, with the artifact, its version, the text\'s hash and its title', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const out = await plan({ rule_artifact: saved.id });
    const stored = ledger.getJudgeRuleForOwner(runId(out))!;
    expect(Buffer.from(stored.rule, 'utf8').equals(Buffer.from(RULE_TEXT, 'utf8'))).toBe(true);
    expect(stored.source).toEqual({ artifact: saved.id, version: saved.version, sha256: sha(RULE_TEXT), title: 'Regeln' });
    // The planner is told where the rule came from, so it does not retype it as the rule.
    expect(out).toContain(`The rule is the text of artifact ${saved.id} (v${String(saved.version)}) as saved, unchanged.`);
  });

  it('keeps a rule\'s leading spaces and its exact length of 4000 characters', async () => {
    const indented = '  R1 eingerückt.\n';
    const a = artifacts.save({ title: 'Eingerückt', content: indented, type: 'text' });
    expect(ledger.getJudgeRuleForOwner(runId(await plan({ rule_artifact: a.id })))!.rule).toBe(indented);
    const full = 'ä'.repeat(4_000);
    const b = artifacts.save({ title: 'Voll', content: full, type: 'text' });
    expect(ledger.getJudgeRuleForOwner(runId(await plan({ rule_artifact: b.id })))!.rule).toBe(full);
  });

  it('carries the text and its source on every form that takes a judge: a data-store run and a run from a collection to a host', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const source = { artifact: saved.id, version: saved.version, sha256: sha(RULE_TEXT), title: 'Regeln' };
    data.createCollection({ name: 'products', scope, columns: [{ name: 'sku', type: 'string' }, { name: 'title', type: 'string' }], uniqueKey: ['sku'] });
    data.insertRecords({ collection: 'products', records: [{ sku: 'A', title: 'old' }], stamp: TEST_STAMP });
    data.createCollection({ name: 'staged', scope, columns: [{ name: 'target', type: 'string' }], uniqueKey: ['target'] });
    data.insertRecords({ collection: 'staged', records: [{ target: 'A' }], stamp: TEST_STAMP });
    const toStore = await bulkPlanTool.handler({
      target_system: 'data_store', target_collection: 'products', source_collection: 'staged',
      judge: { rule_artifact: saved.id, schema: { title: { type: 'string', maxLength: 70 } } },
    } as unknown as Parameters<typeof bulkPlanTool.handler>[0], agent());
    const a = ledger.getJudgeRuleForOwner(runId(toStore))!;
    expect([a.rule, a.source]).toEqual([RULE_TEXT, source]);
    data.insertRecords({ collection: 'staged', records: [{ target: '/products/1' }], stamp: TEST_STAMP });
    const toHost = await bulkPlanTool.handler({
      target_system: 'http', target_host: 'api.example.com', source_collection: 'staged',
      judge: { rule_artifact: saved.id, schema: { title: { type: 'string', maxLength: 70 } } },
    } as unknown as Parameters<typeof bulkPlanTool.handler>[0], agent());
    const b = ledger.getJudgeRuleForOwner(runId(toHost))!;
    expect([b.rule, b.source]).toEqual([RULE_TEXT, source]);
  });

  it('a data-store run whose rule is read from an artifact stamps its writes unknown beside the conversation\'s grants; a typed rule does not', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    data.createCollection({ name: 'products', scope, columns: [{ name: 'sku', type: 'string' }, { name: 'title', type: 'string' }], uniqueKey: ['sku'] });
    data.createCollection({ name: 'staged', scope, columns: [{ name: 'target', type: 'string' }], uniqueKey: ['target'] });
    data.insertRecords({ collection: 'staged', records: [{ target: 'A' }], stamp: { ...TEST_STAMP, grants: ['gS'] } });
    const withGrants = { ...agent(), conversationGrants: { members: () => ['gA'] } } as unknown as IAgent;
    const planWith = async (judge: Record<string, unknown>): Promise<unknown> => {
      const out = await bulkPlanTool.handler({
        target_system: 'data_store', target_collection: 'products', source_collection: 'staged',
        judge: { ...judge, schema: { title: { type: 'string', maxLength: 70 } } },
      } as unknown as Parameters<typeof bulkPlanTool.handler>[0], withGrants);
      return (engineDb.getDb().prepare('SELECT planner_grants AS g FROM bulk_runs WHERE id = ?').get(runId(out)) as { g: string | null }).g;
    };
    expect(await planWith({ rule: 'Set a title.' })).toBe('["gA","gS"]');
    expect(await planWith({ rule_artifact: saved.id })).toBe('["gA","gS","unknown"]');
  });

  it('keeps no title for an artifact without one, and at most 200 characters of a long one', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const titled = (title: unknown): Pick<ArtifactStore, 'get'> => ({ get: (id: string) => ({ ...artifacts.get(saved.id)!, id, title: title as string }) });
    for (const none of ['', undefined]) {
      const stored = ledger.getJudgeRuleForOwner(runId(await plan({ rule_artifact: saved.id }, OWNER_PRINCIPAL, titled(none))))!;
      expect(stored.source).toEqual({ artifact: saved.id, version: saved.version, sha256: sha(RULE_TEXT) });
      expect('title' in stored.source!).toBe(false);
    }
    const long = ledger.getJudgeRuleForOwner(runId(await plan({ rule_artifact: saved.id }, OWNER_PRINCIPAL, titled('ä'.repeat(250)))))!;
    expect(long.source!.title).toBe('ä'.repeat(200));
  });

  it('a typed rule stores no source, and keeps the hash it had before a source existed', async () => {
    const out = await plan({ rule: 'Write a short description.' });
    const stored = ledger.getJudgeRuleForOwner(runId(out))!;
    expect(stored.source).toBeUndefined();
    expect('source' in stored).toBe(false);
    // The hash over exactly the shape a typed rule had before: no source key, not even a null one.
    const { hash, ...rule } = stored;
    expect(hash).toBe(engineDb.keyedHash(['bulk-judge-rule-v1', canonicalJson({ rule: rule.rule, schema: rule.schema, tier: rule.tier, verdict: rule.verdict })]));
  });

  it('a source the planner writes itself is not stored: only a text read from an artifact has one', async () => {
    const out = await plan({ rule: RULE_TEXT, source: { artifact: 'a1b2c3d4', version: 1, sha256: sha(RULE_TEXT) } });
    expect('source' in ledger.getJudgeRuleForOwner(runId(out))!).toBe(false);
  });

  it('refuses a rule and an artifact together, and plans nothing', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    expect(await plan({ rule: 'x', rule_artifact: saved.id })).toContain('Give judge.rule or judge.rule_artifact, not both.');
    expect(ledger.listRuns(10)).toHaveLength(0);
  });

  it('under an access the rule is typed: an artifact\'s content is not read for a mandate, and nothing is planned', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const reads: string[] = [];
    const watched = { get: (id: string) => { reads.push(id); return artifacts.get(id); } };
    expect(await plan({ rule_artifact: saved.id }, MANDATE, watched)).toContain('judge.rule_artifact is for the owner: under an access, type the rule as judge.rule.');
    expect(reads).toEqual([]);
    expect(ledger.listRuns(10)).toHaveLength(0);
  });

  it('refuses an id that names no artifact, one of another type, and one longer than a rule may be', async () => {
    expect(await plan({ rule_artifact: 'deadbeef' })).toContain('There is no saved artifact deadbeef.');
    const page = artifacts.save({ title: 'Seite', content: '<p>R1</p>', type: 'html' });
    expect(await plan({ rule_artifact: page.id })).toContain(`Artifact ${page.id} is of type html; a rule is taken only from a markdown or text artifact.`);
    const long = artifacts.save({ title: 'Lang', content: 'x'.repeat(4_001), type: 'text' });
    expect(await plan({ rule_artifact: long.id })).toContain(`Artifact ${long.id} has 4001 characters; a rule may have at most 4000.`);
    expect(await plan({ rule_artifact: '../etc' })).toContain('judge.rule_artifact must be the id of a saved artifact, as artifact_list shows it.');
    expect(ledger.listRuns(10)).toHaveLength(0);
  });

  it('names the artifact when its text is empty, holds a hidden character or lost its document, and says when no store is there', async () => {
    const empty = artifacts.save({ title: 'Leer', content: '  \n', type: 'text' });
    expect(await plan({ rule_artifact: empty.id })).toContain(`Artifact ${empty.id} is empty; a rule needs text.`);
    const hidden = artifacts.save({ title: 'Versteckt', content: 'R1\u200Bsachlich', type: 'text' });
    expect(await plan({ rule_artifact: hidden.id })).toContain(`Artifact ${hidden.id} holds a character a reader does not see`);
    const lost = { get: (id: string) => ({ ...artifacts.get(empty.id)!, id, content: 'R1', lostOnSave: true as const }) };
    expect(await plan({ rule_artifact: 'a1b2c3d4' }, OWNER_PRINCIPAL, lost)).toContain('Artifact a1b2c3d4 lost its document on a save');
    expect(await plan({ rule_artifact: 'a1b2c3d4' }, OWNER_PRINCIPAL, null)).toContain('Saved artifacts are not available on this instance: type the rule as judge.rule.');
    expect(ledger.listRuns(10)).toHaveLength(0);
  });

  it('a judge without rule and without rule_artifact is told both ways', async () => {
    expect(await plan({})).toContain('or name a saved artifact as judge.rule_artifact.');
  });
});

describe('what bulk_status tells about a run whose rule came from an artifact', () => {
  it('never the rule\'s text, to the owner or to an access: only the run and its counts', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const id = runId(await plan({ rule_artifact: saved.id }));
    for (const principal of [OWNER_PRINCIPAL, MANDATE]) {
      const out = await bulkStatusTool.handler({ run_id: id } as unknown as Parameters<typeof bulkStatusTool.handler>[0], agent(principal));
      expect(out).not.toContain('sachlich');
      expect(out).not.toContain('Superlative');
    }
    // Control: the owner's status is about this run.
    expect(await bulkStatusTool.handler({ run_id: id } as unknown as Parameters<typeof bulkStatusTool.handler>[0], agent())).toContain(id);
  });
});

describe('a run whose rule came from an artifact starts only while the artifact holds the planned text', () => {
  it('reads unchanged while the artifact holds the same text, even after a save of the same text', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const stored = ledger.getJudgeRuleForOwner(runId(await plan({ rule_artifact: saved.id })))!;
    expect(judgeRuleSourceChanged(stored, artifacts)).toBeNull();
    artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown', id: saved.id });
    expect(judgeRuleSourceChanged(stored, artifacts)).toBeNull();
  });

  it('refuses once the artifact is edited after the plan, naming it by its planned title, and the run keeps the planned text', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const id = runId(await plan({ rule_artifact: saved.id }));
    // Renamed with the edit: the owner is told the title they planned with, not the new one.
    artifacts.save({ title: 'Umbenannt', content: RULE_TEXT.replace('160', '150'), type: 'markdown', id: saved.id });
    const stored = ledger.getJudgeRuleForOwner(id)!;
    expect(judgeRuleSourceChanged(stored, artifacts)).toEqual({
      code: 'rule_source_changed', title: 'Regeln',
      message: "This run's rule has changed since it was planned. The change may not be yours. Read the rule under Artifacts, then ask lynox in the chat to plan the run again.",
    });
    // Nothing switches to the newer text.
    expect(stored.rule).toBe(RULE_TEXT);
  });

  it('refuses once the artifact is gone, naming it by its planned title, and without a store by its code alone', async () => {
    const saved = artifacts.save({ title: 'Regeln', content: RULE_TEXT, type: 'markdown' });
    const stored = ledger.getJudgeRuleForOwner(runId(await plan({ rule_artifact: saved.id })))!;
    expect(artifacts.delete(saved.id)).toBe(true);
    expect(judgeRuleSourceChanged(stored, artifacts)).toEqual({
      code: 'rule_source_gone', title: 'Regeln',
      message: "The artifact with this run's rule has been deleted or cannot be read. Ask lynox in the chat to plan the run again.",
    });
    // No title and nothing the store said: only that it cannot be read now.
    expect(judgeRuleSourceChanged(stored, null)).toEqual({
      code: 'rule_source_unreadable',
      message: "Saved artifacts cannot be read on this instance right now, so lynox cannot check this run's rule. Nothing was judged. Try again later.",
    });
  });

  it('a typed rule is never refused for its source', () => {
    const typed = normalizeJudgeRule({ rule: 'x', schema: { title: { type: 'string', maxLength: 40 } } });
    expect(judgeRuleSourceChanged(typed, artifacts)).toBeNull();
    expect(judgeRuleSourceChanged(typed, null)).toBeNull();
  });
});
