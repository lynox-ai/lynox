import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { RunHistory } from './run-history.js';
import {
  blankRunHistoryContent,
  coveredGrantSet,
  erasureRecords,
  FALLBACK_CONTENT_COLUMNS,
  FALLBACK_KEPT_COLUMNS,
  runConnectionErasureSweeps,
} from './connection-erasure.js';

/**
 * The acceptance tests T1–T3 of PRD-SOURCE-CONNECTION revision 8 (R8-8), written before the
 * logic they check. Each answers one regression the last delta found in the repairs:
 *  - T1 (J1): a call in flight at the delete lands after the first pass and is still erased, and so
 *    is one that lands after the store is `done`;
 *  - T2 (J2): a grant minted as `new` in the middle of a connection's life does not start an epoch;
 *  - T3 (J5): the fallback blanks every content column it names, and keeps the rows.
 */

describe('T1 — a call in flight at the delete is erased, also when it lands after the store is done', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;
  let history: RunHistory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-t1-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
    history = new RunHistory(join(dir, 'history.db'));
  });
  afterEach(() => {
    history.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rowsOf = (grantId: string): number =>
    (history.getDb().prepare('SELECT COUNT(*) AS n FROM run_tool_calls WHERE grant_id = ?').get(grantId) as { n: number }).n;
  const call = (runId: string, connectionId: string, grantId: string, seq: number): void => {
    history.insertToolCall({ runId, toolName: 'http_request', inputJson: `{"url":"https://${connectionId}.example/${seq}"}`, outputJson: '', durationMs: 1, sequenceOrder: seq, connectionId, grantId });
  };
  const stateOf = (connectionId: string): string | undefined => erasureRecords(db.getDb(), connectionId)[0]?.historyState;

  it('stays pending while a run active at the delete runs, is done once it ended, and a late row is still erased', () => {
    expect(store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } }).ok).toBe(true);
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const before = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(before, 'shop', grant, 0);
    history.updateRun(before, { status: 'completed' });
    // The run whose `http_request` is in flight when the connection is removed.
    const inFlight = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });

    expect(store.remove('shop', undefined, { record: 'erasure' })).toBe(true);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('pending');

    // The call ends after the delete: its row lands, stamped before the request was sent.
    call(inFlight, 'shop', grant, 0);
    call(inFlight, 'crm', 'g-crm', 1); // another connection's row of the same run stays
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('pending'); // the run still runs

    history.updateRun(inFlight, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(stateOf('shop')).toBe('done');
    expect(rowsOf('g-crm')).toBe(1);

    // A call its run abandoned lands on the session's NEXT run (session.ts: `call.runId ??
    // this.currentRunId`), which was not active at the delete: the store is already done, and the
    // row is erased all the same.
    const next = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(next, 'shop', grant, 0);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('done');
  });

  it('is late, not done, when the deadline passes while a run active at the delete still runs', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    store.remove('shop', undefined, { record: 'erasure' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(stateOf('shop')).toBe('late');
  });

  it('a removal without the erasure kind writes a closing record that erases nothing', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'shop', grant, 0);
    history.updateRun(run, { status: 'completed' });
    expect(store.remove('shop', undefined, { record: 'closing' })).toBe(true);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(1);
    expect(erasureRecords(db.getDb(), 'shop').map((r) => [r.kind, r.historyState])).toEqual([['closing', 'not reached']]);
  });
});

describe('T2 — the covered set is the connection\'s epoch, from the grant its row was created with', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;

  const profile = (id: string, key = `${id.toUpperCase()}_KEY`): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example`, description: 'd', auth: { type: 'bearer', vault_keys: [key] },
  });
  const grantOf = (id: string): string => store.get(id)!.oauth_grant!.grant_id!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-t2-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a `new` grant minted in the middle of the connection\'s life does not start an epoch', () => {
    // G1 (`new`) and G2 (`consent`) on one connection row.
    const oauth = (clientSecretKey: string): ApiProfile => ({
      id: 'shop-api', name: 'shop-api', base_url: 'https://api.shop.example/v1', description: 'd',
      auth: { type: 'oauth2', oauth: { token_url: 'https://api.shop.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'SHOP_API_CID', client_secret_key: clientSecretKey } },
    });
    expect(store.save(oauth('SHOP_API_CSECRET')).ok).toBe(true);
    const g1 = grantOf('shop-api');
    expect(store.save(oauth('SHOP_API_CSECRET'), undefined, { newConsent: true, consentRefresh: null }).ok).toBe(true);
    const g2 = grantOf('shop-api');
    expect(g2).not.toBe(g1);

    // The stored row now points its client secret at its own token slot, so the next boot holds
    // the profile back (api-store.ts, `heldBack`) and leaves its row where it is.
    const row = conn.get('shop-api')!;
    const config = JSON.parse(row.configJson) as ApiProfile;
    config.auth!.oauth!.client_secret_key = 'SHOP_API_REFRESH_TOKEN';
    conn.upsert({ ...row, configJson: JSON.stringify(config) });

    const booted = new ApiStore();
    booted.loadFromConnections(conn);
    booted.setConnectionStore(conn);
    booted.setGrantLedger(ledger);
    expect(booted.get('shop-api')).toBeUndefined();
    expect(booted.knownProfiles().map((p) => p.id)).toEqual(['shop-api']);

    // Its corrected save is a create to the store, so it mints `new` — on the same row.
    expect(booted.save(oauth('SHOP_API_CSECRET'))).toEqual({ ok: true, isNew: true });
    const g3 = booted.get('shop-api')!.oauth_grant!.grant_id!;
    expect(ledger.get(g3)?.reason).toBe('new');
    expect(conn.get('shop-api')!.createdAt).toBe(row.createdAt);

    expect([...(coveredGrantSet(db.getDb(), 'shop-api') ?? [])].sort()).toEqual([g1, g2, g3].sort());
  });

  it('a connection that reuses the id of a removed one starts its own epoch', () => {
    store.save(profile('shop'));
    const old = grantOf('shop');
    expect(store.remove('shop')).toBe(true);
    store.save(profile('shop'));
    const fresh = grantOf('shop');

    const set = coveredGrantSet(db.getDb(), 'shop');
    expect(set).toEqual([fresh]);
    expect(set).not.toContain(old);
  });
});

describe('T3 — the fallback blanks every content column it names and keeps the rows', () => {
  let dir: string;
  let history: RunHistory;
  const MARK = 'erasure-marker-7f3c';
  const CONTENT_TABLES = ['pending_prompts', 'pipeline_runs', 'pipeline_step_results', 'processes', 'run_tool_calls', 'runs', 'security_events', 'wire_snapshots'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-t3-'));
    history = new RunHistory(join(dir, 'history.db'));
  });
  afterEach(() => {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One run in thread `thread-a` whose every content column holds the marker. */
  const seed = (): string => {
    const db = history.getDb();
    const runId = history.insertRun({ sessionId: 'thread-a', taskText: `task ${MARK}`, modelTier: 'sonnet', modelId: 'm' });
    history.updateRun(runId, { responseText: `reply ${MARK}`, errorText: `error ${MARK}`, status: 'failed', costUsd: 0.25 });
    db.prepare('UPDATE runs SET task_hash = ?, prompt_hash = ? WHERE id = ?').run(MARK, MARK, runId);
    history.insertToolCall({ runId, toolName: 'data_store_insert', inputJson: `{"v":"${MARK}"}`, outputJson: `failed ${MARK}`, durationMs: 1, sequenceOrder: 0 });
    db.prepare(`INSERT INTO pending_prompts (id, session_id, prompt_type, question, options_json, answer, questions_json, partial_answers_json, payload_json, answer_error, segments_json, origin_json, status, expires_at)
      VALUES ('p1', 'thread-a', 'ask_user', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'answered', '2099-01-01T00:00:00.000Z')`)
      .run(MARK, `["${MARK}"]`, MARK, `["${MARK}"]`, `{"a":"${MARK}"}`, `{"p":"${MARK}"}`, MARK, `[{"value":"${MARK}"}]`, `{"step_task":"${MARK}"}`);
    db.prepare(`INSERT INTO processes (id, name, description, source_run_id, steps_json, parameters_json) VALUES ('proc1', 'weekly', ?, ?, ?, ?)`)
      .run(MARK, runId, `[{"inputTemplate":{"q":"${MARK}"}}]`, `[{"default":"${MARK}"}]`);
    db.prepare(`INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, parent_run_id, error) VALUES ('pr1', 'wf', 'failed', ?, ?, ?)`)
      .run(`{"p":"${MARK}"}`, runId, MARK);
    db.prepare(`INSERT INTO pipeline_step_results (pipeline_run_id, step_id, status, result, error) VALUES ('pr1', 's1', 'failed', ?, ?)`).run(MARK, MARK);
    db.prepare(`INSERT INTO security_events (event_type, tool_name, input_preview, decision, run_id, detail) VALUES ('danger_flagged', 'http_request', ?, 'flagged', ?, ?)`)
      .run(MARK, runId, MARK);
    db.prepare(`INSERT INTO wire_snapshots (run_id, turn_index, model, provider, system_prompt_hash, user_message, user_message_chars, tool_names, tool_count, max_tokens, ephemeral_tail_present, ephemeral_tail_chars, captured_at)
      VALUES (?, 0, 'm', 'p', 'h', ?, 1, '[]', 0, 1, 0, 0, 0)`).run(runId, MARK);
    return runId;
  };

  const tablesHoldingMarker = (): string[] => {
    const db = history.getDb();
    const hits: string[] = [];
    for (const [table, columns] of Object.entries(FALLBACK_CONTENT_COLUMNS)) {
      for (const column of columns) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" LIKE ?`).get(`%${MARK}%`) as { n: number }).n;
        if (n > 0) hits.push(`${table}.${column}`);
      }
    }
    return hits;
  };

  const rowCounts = (): Record<string, number> => {
    const db = history.getDb();
    const out: Record<string, number> = {};
    for (const t of CONTENT_TABLES) {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    }
    return out;
  };

  it('names every table that holds run content', () => {
    expect(Object.keys(FALLBACK_CONTENT_COLUMNS).sort()).toEqual(CONTENT_TABLES);
  });

  it('every text column of those tables is either blanked or named as kept, never both', () => {
    // A column added later fails here until someone decides which it is.
    const db = history.getDb();
    for (const table of CONTENT_TABLES) {
      const text = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>)
        .filter((c) => /TEXT/i.test(c.type)).map((c) => c.name).sort();
      const blanked = [...(FALLBACK_CONTENT_COLUMNS[table] ?? [])];
      const kept = [...(FALLBACK_KEPT_COLUMNS[table] ?? [])];
      expect(blanked.filter((c) => kept.includes(c)), table).toEqual([]);
      expect([...blanked, ...kept].sort(), table).toEqual(text);
    }
  });

  it('leaves no marker in any content column of the thread\'s runs, and keeps every row and cost', () => {
    const runId = seed();
    expect(tablesHoldingMarker().length).toBeGreaterThan(0); // the seed reaches the columns it checks
    const before = rowCounts();

    blankRunHistoryContent(history.getDb(), { threadIds: ['thread-a'] });

    expect(tablesHoldingMarker()).toEqual([]);
    expect(rowCounts()).toEqual(before);
    const cost = (history.getDb().prepare('SELECT cost_usd FROM runs WHERE id = ?').get(runId) as { cost_usd: number }).cost_usd;
    expect(cost).toBe(0.25);
  });

  it('a raw scan of every text column of history.db finds no marker after the fallback', () => {
    seed();
    blankRunHistoryContent(history.getDb(), { threadIds: ['thread-a'] });
    const db = history.getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    const hits: string[] = [];
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string; type: string }>).filter((c) => /TEXT/i.test(c.type));
      for (const c of cols) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${c.name}" LIKE ?`).get(`%${MARK}%`) as { n: number }).n;
        if (n > 0) hits.push(`${t}.${c.name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
