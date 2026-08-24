import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PromptStore, PromptConflictError, promptOriginOf, parseOriginJson, originWireFields } from './prompt-store.js';
import { RunHistory } from './run-history.js';

/** Build a fresh SQLite instance with just the pending_prompts schema the
 * PromptStore depends on. Mirrors migrations v25 + v27 + v29 + v33 + v43
 * (post-rewrite — connect_mail in the CHECK + payload_json column). */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  const stmts = [
    `CREATE TABLE pending_prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_type TEXT NOT NULL CHECK(prompt_type IN ('ask_user','ask_secret','connect_mail')),
      question TEXT NOT NULL,
      options_json TEXT,
      questions_json TEXT,
      segments_json TEXT,
      partial_answers_json TEXT,
      secret_name TEXT,
      secret_key_type TEXT,
      answer TEXT,
      answer_saved INTEGER,
      answer_error TEXT,
      multi_select INTEGER,
      payload_json TEXT,
      origin_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT,
      expires_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_pending_prompts_session ON pending_prompts(session_id, status)`,
    `CREATE UNIQUE INDEX idx_pending_prompts_session_unique
      ON pending_prompts(session_id) WHERE status = 'pending'`,
  ];
  for (const s of stmts) db.prepare(s).run();
  return db;
}

describe('PromptStore', () => {
  let db: Database.Database;
  let store: PromptStore;

  beforeEach(() => {
    db = makeDb();
    store = new PromptStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('single-question ask_user', () => {
    it('round-trips insert -> answer -> waitForAnswer', async () => {
      const id = store.insertAskUser('s1', 'hello?', ['yes', 'no']);
      const wait = store.waitForAnswer(id);
      // Answer asynchronously -- event bus should deliver quickly.
      setTimeout(() => { store.answerUser(id, 'yes'); }, 10);
      const row = await wait;
      expect(row?.status).toBe('answered');
      expect(row?.answer).toBe('yes');
    });

    it('persists multi_select so a reconnect can restore it (v33)', () => {
      const multiId = store.insertAskUser('s1', 'pick some?', ['a', 'b', 'c'], true);
      expect(store.getById(multiId)?.multi_select).toBe(1);
      expect(store.getPending('s1')?.multi_select).toBe(1);
      // Default + explicit-false stay NULL (single-select), unchanged for pre-v33 callers.
      const singleId = store.insertAskUser('s2', 'pick one?', ['a', 'b']);
      expect(store.getById(singleId)?.multi_select).toBeNull();
      const falseId = store.insertAskUser('s3', 'pick one?', ['a', 'b'], false);
      expect(store.getById(falseId)?.multi_select).toBeNull();
    });

    it('resolves immediately if already answered (fast path)', async () => {
      const id = store.insertAskUser('s1', 'q');
      store.answerUser(id, 'a');
      const row = await store.waitForAnswer(id);
      expect(row?.answer).toBe('a');
    });

    it('answerUser is idempotent -- second call returns false', () => {
      const id = store.insertAskUser('s1', 'q');
      expect(store.answerUser(id, 'a')).toBe(true);
      expect(store.answerUser(id, 'a')).toBe(false);
    });
  });

  describe('multi-question tabs', () => {
    it('stores questions and accepts array answers', async () => {
      const id = store.insertAskUserTabs('s1', [
        { question: 'q1', header: 'H1' },
        { question: 'q2', options: ['a', 'b'] },
      ]);
      const row = store.getById(id);
      expect(row?.questions_json).toContain('q1');
      expect(row?.questions_json).toContain('q2');

      const wait = store.waitForAnswer(id);
      setTimeout(() => { store.answerUserTabs(id, ['x', 'y']); }, 10);
      const answered = await wait;
      expect(answered?.answer).toBe(JSON.stringify(['x', 'y']));
    });

    it('rejects empty questions', () => {
      expect(() => store.insertAskUserTabs('s1', [])).toThrow();
    });

    it('persists partial answers without settling', () => {
      const id = store.insertAskUserTabs('s1', [{ question: 'q1' }, { question: 'q2' }]);
      store.setPartialAnswers(id, ['first', null]);
      const row = store.getById(id);
      expect(row?.status).toBe('pending'); // not settled
      expect(row?.partial_answers_json).toBe(JSON.stringify(['first', null]));
    });
  });

  describe('unicity per session', () => {
    it('rejects a second pending prompt in the same session', () => {
      store.insertAskUser('s1', 'q1');
      expect(() => store.insertAskUser('s1', 'q2')).toThrow(PromptConflictError);
    });

    it('allows new prompt after previous is answered', () => {
      const id = store.insertAskUser('s1', 'q1');
      store.answerUser(id, 'a');
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
    });

    it('allows new prompt after previous is expired', () => {
      // Insert, then manually mark expired to simulate TTL elapsed.
      const id = store.insertAskUser('s1', 'q1');
      db.prepare(`UPDATE pending_prompts SET status = 'expired' WHERE id = ?`).run(id);
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
    });
  });

  describe('an abandoned onboarding card does not wedge the session', () => {
    // The Step-0 basics prompt is written by the UI and settled only on SAVE.
    // Its skip button and both fail-open error paths return without telling the
    // server, and a closed tab does not either — so the row sat `pending` for
    // the full 24h TTL and the per-session UNIQUE index made every later
    // ask_user / ask_secret throw. Invisible, too: the pending endpoint reports
    // onboarding_basics as `pending: false`.
    it('lets an agent prompt supersede a pending onboarding_basics row', () => {
      const orphan = store.insertOnboardingBasics('s1', [{ question: 'What is the company called?' }], ['company']);
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
      const row = db
        .prepare(`SELECT status FROM pending_prompts WHERE id = ?`)
        .get(orphan) as { status: string };
      // Expired, not deleted — the row still explains what happened.
      expect(row.status).toBe('expired');
    });

    it('supersedes it for ask_secret too, not just ask_user', () => {
      store.insertOnboardingBasics('s1', [{ question: 'q' }], ['company']);
      expect(() => store.insertAskSecret('s1', 'need a key', 'STRIPE_KEY', 'api_key')).not.toThrow();
    });

    it('does NOT let an onboarding card displace a live agent prompt', () => {
      // The asymmetry is the point: a run is blocked on the agent's question,
      // so that one wins. Without this the fix would trade one wedge for a
      // worse one.
      store.insertAskUser('s1', 'q1');
      expect(() => store.insertOnboardingBasics('s1', [{ question: 'q' }], ['company'])).toThrow(PromptConflictError);
    });

    it('still conflicts when the blocker is a normal prompt', () => {
      // The retry must be scoped to the abandoned card. A second agent prompt
      // has to keep throwing, or the UNIQUE index stops meaning anything.
      store.insertAskUserTabs('s1', [{ question: 'q1' }]);
      expect(() => store.insertAskUser('s1', 'q2')).toThrow(PromptConflictError);
    });

    it('judges the payload by its kind, not by a substring', () => {
      // payload_json is caller-supplied on connect_mail, so a substring test
      // would misread any account id or folder name that happens to contain
      // those characters — and would then refuse to supersede, wedging the
      // session for the same 24h the fix exists to prevent.
      store.insertOnboardingBasics('s1', [{ question: 'q' }], ['company']);
      const decoyPayload = JSON.stringify({ kind: 'connect_mail', accountId: 'onboarding_basics@example.com' });
      expect(() => store.insertConnectMail('s1', 'connect?', decoyPayload)).not.toThrow();
    });

    it('leaves another session alone', () => {
      // s1 must have its OWN blocker, or the insert below succeeds outright and
      // the expire never runs — which is what the first version of this test
      // did. It then proved nothing: widening the WHERE to `(session_id = ? OR
      // 1=1)` passed the whole file.
      store.insertOnboardingBasics('s1', [{ question: 'q' }], ['company']);
      store.insertOnboardingBasics('s2', [{ question: 'q' }], ['company']);
      store.insertAskUser('s1', 'q1');
      const other = db
        .prepare(`SELECT status FROM pending_prompts WHERE session_id = 's2'`)
        .get() as { status: string };
      expect(other.status).toBe('pending');
    });

    it('never touches a card the user already answered', () => {
      // The `status = 'pending'` clause is what stands between a saved card and
      // silent data loss: flipping an ANSWERED row to expired makes `/promote`
      // refuse it ("Prompt not answered yet"), so the basics the user typed
      // never reach durable knowledge. Deleting that clause passed 36/36.
      const card = store.insertOnboardingBasics('s1', [{ question: 'q' }], ['company']);
      store.answerUserTabs(card, ['ACME Ltd']);
      store.insertAskUser('s1', 'q1');
      const row = db
        .prepare(`SELECT status FROM pending_prompts WHERE id = ?`)
        .get(card) as { status: string };
      expect(row.status).toBe('answered');
    });

    it('retries once, not until it wins', () => {
      // The retry flag is the only thing bounding a catch block that calls
      // itself; removing it passed 36/36. Simulated here by leaving a SECOND
      // pending row behind that the expire cannot clear, so an unbounded
      // version would keep going.
      store.insertOnboardingBasics('s1', [{ question: 'q' }], ['company']);
      db.prepare(
        `INSERT INTO pending_prompts (id, session_id, prompt_type, question, status, expires_at)
         VALUES ('ghost', 's1', 'ask_user', 'q', 'answered', datetime('now', '+1 day'))`,
      ).run();
      // The expire clears the card; the retry then succeeds exactly once.
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
      const pending = db
        .prepare(`SELECT COUNT(*) AS c FROM pending_prompts WHERE session_id = 's1' AND status = 'pending'`)
        .get() as { c: number };
      expect(pending.c).toBe(1);
    });
  });

  describe('abort signal', () => {
    it('resolves with aborted outcome immediately when signal already aborted', async () => {
      const id = store.insertAskUser('s1', 'q');
      const ac = new AbortController();
      ac.abort();
      const outcome = await store.waitForSettled(id, ac.signal);
      expect(outcome.status).toBe('aborted');
    });

    it('resolves with aborted when signal fires during wait', async () => {
      const id = store.insertAskUser('s1', 'q');
      const ac = new AbortController();
      const promise = store.waitForSettled(id, ac.signal);
      setTimeout(() => ac.abort(), 20);
      const outcome = await promise;
      expect(outcome.status).toBe('aborted');
    });
  });

  describe('expiry', () => {
    it('expireOld transitions past-due prompts and notifies waiters', async () => {
      const id = store.insertAskUser('s1', 'q');
      // Force expires_at into the past.
      db.prepare(`UPDATE pending_prompts SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(id);
      const wait = store.waitForSettled(id);
      store.expireOld();
      const outcome = await wait;
      expect(outcome.status).toBe('expired');
    });

    it('expirePrompt settles a single in-flight wait with expired and frees the session slot', async () => {
      const id = store.insertAskUser('s1', 'q');
      const wait = store.waitForSettled(id);
      expect(store.expirePrompt(id)).toBe(true);
      const outcome = await wait;
      expect(outcome.status).toBe('expired');
      // Slot is free again — a fresh prompt for the same session must insert.
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
    });

    it('expirePrompt is idempotent', () => {
      const id = store.insertAskUser('s1', 'q');
      expect(store.expirePrompt(id)).toBe(true);
      expect(store.expirePrompt(id)).toBe(false);
    });

    it('expirePrompt is a no-op for an already-answered prompt', () => {
      const id = store.insertAskUser('s1', 'q');
      store.answerUser(id, 'a');
      expect(store.expirePrompt(id)).toBe(false);
      expect(store.getById(id)?.status).toBe('answered');
    });
  });

  describe('getPending', () => {
    it('returns undefined when nothing pending', () => {
      expect(store.getPending('nope')).toBeUndefined();
    });

    it('returns the pending row with questions_json populated for tabs', () => {
      const id = store.insertAskUserTabs('s1', [{ question: 'q1' }]);
      const row = store.getPending('s1');
      expect(row?.id).toBe(id);
      expect(row?.questions_json).toBeTruthy();
    });
  });

  // Each SecretOutcome must hit the right column pair on the row.
  // The bug this guards against is a regression that swaps the bind order
  // of (answer_saved, answer_error) and silently produces wrong state.
  describe('answerSecret outcome → column mapping', () => {
    it('saved → answer_saved=1, answer_error=NULL', () => {
      const id = store.insertAskSecret('s1', 'API_KEY', 'enter');
      expect(store.answerSecret(id, 'saved')).toBe(true);
      const row = store.getById(id);
      expect(row?.answer_saved).toBe(1);
      expect(row?.answer_error).toBeNull();
      expect(row?.status).toBe('answered');
    });

    it('canceled → answer_saved=0, answer_error=NULL', () => {
      const id = store.insertAskSecret('s1', 'API_KEY', 'enter');
      expect(store.answerSecret(id, 'canceled')).toBe(true);
      const row = store.getById(id);
      expect(row?.answer_saved).toBe(0);
      expect(row?.answer_error).toBeNull();
    });

    it('managed_blocked → answer_saved=0, answer_error="managed_blocked"', () => {
      const id = store.insertAskSecret('s1', 'SHOPIFY_TOKEN', 'enter');
      expect(store.answerSecret(id, 'managed_blocked')).toBe(true);
      const row = store.getById(id);
      expect(row?.answer_saved).toBe(0);
      expect(row?.answer_error).toBe('managed_blocked');
    });

    it('vault_error → answer_saved=0, answer_error="vault_error"', () => {
      const id = store.insertAskSecret('s1', 'API_KEY', 'enter');
      expect(store.answerSecret(id, 'vault_error')).toBe(true);
      const row = store.getById(id);
      expect(row?.answer_saved).toBe(0);
      expect(row?.answer_error).toBe('vault_error');
    });
  });

  describe('connect_mail prompt (v43)', () => {
    const payload = JSON.stringify({ id: 'a', address: 'a@gmail.com', preset: 'gmail' });

    it('inserts a connect_mail row carrying payload_json, never a password', () => {
      const id = store.insertConnectMail('s1', 'Connect mailbox a@gmail.com', payload);
      const row = store.getById(id);
      expect(row?.prompt_type).toBe('connect_mail');
      expect(row?.payload_json).toBe(payload);
      // No secret columns are populated for a mail prompt.
      expect(row?.secret_name).toBeNull();
      // The store never holds a password — the payload carries only config.
      expect(row?.payload_json).not.toContain('pass');
    });

    it('getPending restores the connect_mail row with its payload (reconnect path)', () => {
      store.insertConnectMail('s1', 'Connect mailbox a@gmail.com', payload);
      const pending = store.getPending('s1');
      expect(pending?.prompt_type).toBe('connect_mail');
      expect(pending?.payload_json).toBe(payload);
    });

    it('answerMailConnect(true) → answer_saved=1 (connected), answer_error=NULL', () => {
      const id = store.insertConnectMail('s1', 'q', payload);
      expect(store.answerMailConnect(id, true)).toBe(true);
      const row = store.getById(id);
      expect(row?.answer_saved).toBe(1);
      expect(row?.answer_error).toBeNull();
      expect(row?.status).toBe('answered');
    });

    it('answerMailConnect(false) → answer_saved=0 (canceled)', () => {
      const id = store.insertConnectMail('s1', 'q', payload);
      expect(store.answerMailConnect(id, false)).toBe(true);
      const row = store.getById(id);
      expect(row?.answer_saved).toBe(0);
      expect(row?.answer_error).toBeNull();
    });

    it('settles a waiting turn via the event bus (connected)', async () => {
      const id = store.insertConnectMail('s1', 'q', payload);
      const wait = store.waitForAnswer(id);
      setTimeout(() => { store.answerMailConnect(id, true); }, 10);
      const row = await wait;
      expect(row?.status).toBe('answered');
      expect(row?.answer_saved).toBe(1);
    });

    it('shares the one-pending-prompt-per-session unicity guard', () => {
      store.insertConnectMail('s1', 'q', payload);
      expect(() => store.insertConnectMail('s1', 'q2', payload)).toThrow(PromptConflictError);
    });
  });

  describe('insertOnboardingBasics (Onboarding Wave 1 Step-0, D9v2)', () => {
    it('inserts a tabs-answerable prompt carrying the engine-only onboarding_basics marker', () => {
      const id = store.insertOnboardingBasics('s-onb', [{ question: 'Company?' }, { question: 'Role?' }], ['company', 'role']);
      const row = store.getById(id);
      expect(row?.prompt_type).toBe('ask_user');
      expect(row?.questions_json).not.toBeNull(); // tabs-shaped → the existing /reply-tabs answers it
      // The marker is the promote-path security discriminator (engine-only; a model ask_user has NULL).
      expect(JSON.parse(row!.payload_json!)).toEqual({ kind: 'onboarding_basics', keys: ['company', 'role'] });
    });

    it('throws on an empty question set', () => {
      expect(() => store.insertOnboardingBasics('s-onb2', [], [])).toThrow();
    });
  });

  // A prompt raised inside a workflow step can sit here for minutes, which is
  // exactly the window a page gets reloaded in. The live SSE event carries the
  // origin; without persisting it the restored dialog drops back to the
  // unexplained "Allow / Deny" the whole feature exists to prevent.
  describe('prompt origin (v52)', () => {
    const origin = { workflowName: 'bexio Triage Phase 1-3', stepId: 'load_contacts', stepTask: 'Paginate contacts' };

    it('persists the origin on every prompt kind that a step can raise', () => {
      const cases: Array<[string, string]> = [
        ['ask_user', store.insertAskUser('o1', 'Allow?', ['Allow', 'Deny'], false, undefined, origin)],
        ['tabs', store.insertAskUserTabs('o2', [{ question: 'Which?' }], origin)],
        ['ask_secret', store.insertAskSecret('o3', 'BEXIO_TOKEN', 'Key?', 'api_key', origin)],
        ['connect_mail', store.insertConnectMail('o4', 'Connect', '{"address":"a@b.c"}', origin)],
      ];
      for (const [kind, id] of cases) {
        const row = store.getById(id);
        expect(JSON.parse(row!.origin_json!), kind).toEqual(origin);
      }
    });

    it('stores NULL when the prompt has no origin — a main-agent prompt must render no origin line', () => {
      const id = store.insertAskUser('o5', 'Allow?', ['Allow', 'Deny']);
      expect(store.getById(id)?.origin_json).toBeNull();
    });

    it('keeps a partial origin partial instead of inventing the missing half', () => {
      const id = store.insertAskUser('o6', 'Allow?', undefined, false, undefined, { stepId: 'solo' });
      expect(JSON.parse(store.getById(id)!.origin_json!)).toEqual({ stepId: 'solo' });
    });
  });
});

/**
 * The suite above builds `pending_prompts` by hand, so it can only prove the
 * store agrees with ITSELF — a migration that added the wrong column name, or
 * none at all, would leave every test above green and every real tenant
 * throwing on the first workflow prompt. This one runs the actual migrations.
 */
describe('PromptStore against the real migrated schema', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('writes and reads the origin on a database built by the migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-prompt-origin-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    try {
      const store = new PromptStore(history.getDb());
      const id = store.insertAskUser('real-1', 'Allow?', ['Allow', 'Deny'], false, undefined, {
        workflowName: 'bexio Triage Phase 1-3',
        stepId: 'load_contacts',
      });
      expect(JSON.parse(store.getById(id)!.origin_json!))
        .toEqual({ workflowName: 'bexio Triage Phase 1-3', stepId: 'load_contacts' });
    } finally {
      history.close();
    }
  });
});

describe('promptOriginOf', () => {
  it('narrows a full meta to the origin fields and nothing else', () => {
    expect(promptOriginOf({
      workflowName: 'W', stepId: 's', stepTask: 't',
      subagentName: 'triage', subagentTask: 'Fold dupes',
      multiSelect: true,
    })).toEqual({
      workflowName: 'W', stepId: 's', stepTask: 't',
      subagentName: 'triage', subagentTask: 'Fold dupes',
    });
  });

  it('survives on a sub-agent alone — a spawn outside any workflow has no step', () => {
    expect(promptOriginOf({ subagent: true, subagentName: 'triage', subagentTask: 'Fold dupes' }))
      .toEqual({ subagent: true, subagentName: 'triage', subagentTask: 'Fold dupes' });
  });

  it('⭐ keeps the flag when every name is empty — the disclosure is not the spec\'s to delete', () => {
    // `spec.name` of one zero-width space passes `validateSpawnInput` and cleans
    // to nothing in the client. If the flag travelled only alongside a surviving
    // name, the parent could suppress its own disclosure by choosing one.
    expect(promptOriginOf({ subagent: true, subagentName: '', subagentTask: '' }))
      .toEqual({ subagent: true });
  });

  it('⭐ only the engine\'s own `true` counts, not any truthy value off a crafted row', () => {
    // Asserted through `parseOriginJson`, because that is the path a crafted row
    // actually takes — and with values a TRUTHY check would accept. A fixture of
    // `undefined` proves nothing here: it is falsy, so `=== true` and a plain
    // truthy test agree on it, and mutating the comparison survives.
    expect(parseOriginJson('{"subagent":1,"workflowName":"W"}')).toEqual({ workflowName: 'W' });
    expect(parseOriginJson('{"subagent":"false","workflowName":"W"}')).toEqual({ workflowName: 'W' });
    expect(parseOriginJson('{"subagent":true}')).toEqual({ subagent: true });
  });

  it('⭐ bounds what a field can carry into the row and onto the wire', () => {
    // `spec.task` may be 16 KB (MAX_SPAWN_TASK_LENGTH). Unbounded here, all of
    // it was persisted per prompt and pushed through every SSE frame to render
    // 160 characters. This bound is NOT the display bound — it exists so the
    // storage and the transport are finite, and the client is free to clamp
    // tighter for layout without touching it.
    //
    // The fixture is ASTRAL on purpose. With `'x'.repeat()` a UTF-16 `slice`
    // and a code-point slice are indistinguishable, so the bound could be
    // rewritten to cut surrogate pairs in half and every assertion would hold.
    const long = '😀'.repeat(20_000);
    const o = promptOriginOf({ subagent: true, subagentTask: long, stepTask: long })!;
    expect([...o.subagentTask!]).toHaveLength(512);
    expect([...o.stepTask!]).toHaveLength(512);
    expect(o.subagentTask!.isWellFormed(), 'the cut split a surrogate pair').toBe(true);
    // A value inside the bound is untouched — no ellipsis, no trimming.
    expect(promptOriginOf({ stepTask: 'Paginate contacts' })!.stepTask).toBe('Paginate contacts');
  });

  it('is undefined when the meta carries no origin — multiSelect alone is not one', () => {
    expect(promptOriginOf({ multiSelect: true })).toBeUndefined();
    expect(promptOriginOf({})).toBeUndefined();
    expect(promptOriginOf(undefined)).toBeUndefined();
  });

  it('survives on the workflow name alone', () => {
    // The half that matters most to a non-technical user: a step id is jargon,
    // the workflow name is what they clicked. Dropping the origin because two
    // of three fields are missing would lose exactly the useful one.
    expect(promptOriginOf({ workflowName: 'bexio Triage' })).toEqual({ workflowName: 'bexio Triage' });
  });

  it('treats an empty field as absent, so the row cannot claim what the dialog denies', () => {
    // The client-side parser treats '' as absent. If this side kept it, the row
    // would persist `{"workflowName":""}` — an origin the renderer then refuses
    // to show. Two layers disagreeing about the same value is how a stored fact
    // and a displayed one drift apart.
    expect(promptOriginOf({ workflowName: '', stepId: 'load_contacts' }))
      .toEqual({ workflowName: undefined, stepId: 'load_contacts', stepTask: undefined });
    expect(promptOriginOf({ workflowName: '', stepId: '', stepTask: '' })).toBeUndefined();
  });
});

describe('parseOriginJson', () => {
  it('round-trips what promptOriginOf wrote', () => {
    const origin = { workflowName: 'bexio Triage', stepId: 'load_contacts', stepTask: 'Paginate' };
    expect(parseOriginJson(JSON.stringify(origin))).toEqual(origin);
  });

  it('degrades to undefined instead of throwing, whatever the row holds', () => {
    // The origin is a LABEL on a prompt. A bad label must cost the user their
    // provenance line, never the resume of the prompt a run is blocked on —
    // an unguarded JSON.parse here 500s `GET /pending-prompt` for that session
    // and the run stays wedged with no way to answer it.
    //
    // Only the first two of these DISCRIMINATE: they are the cases that throw
    // without the try/catch. The rest pin the contract, not a guard — they would
    // stay green with every shape check deleted, which is why the implementation
    // does not carry those checks.
    expect(() => parseOriginJson('{not json')).not.toThrow();
    expect(parseOriginJson('{not json')).toBeUndefined();
    expect(parseOriginJson('null')).toBeUndefined();
    expect(parseOriginJson('"a string"')).toBeUndefined();
    expect(parseOriginJson('[{"workflowName":"x"}]')).toBeUndefined();
    expect(parseOriginJson(null)).toBeUndefined();
  });

  it('drops non-string fields rather than rendering them', () => {
    expect(parseOriginJson('{"workflowName":42,"stepId":"load_contacts"}'))
      .toEqual({ workflowName: undefined, stepId: 'load_contacts', stepTask: undefined });
  });

  it('⭐ reads back every field the writer can write — no half-known set', () => {
    // The failure this replaces: the write side and the read side were two
    // hand-written field lists, so a field added to one and forgotten in the
    // other persists on the row and comes back as nothing. It looks like a
    // rendering bug and is a parsing one. Both derive from ORIGIN_FIELDS now,
    // and the point of asserting it here is that the DERIVATION is what holds —
    // the exhaustive `Record<keyof PromptOrigin, true>` makes forgetting a field
    // a compile error, and this proves the two agree at runtime as well.
    const full = {
      workflowName: 'W', stepId: 's', stepTask: 't',
      subagentName: 'triage', subagentTask: 'Fold dupes',
    };
    const written = promptOriginOf(full)!;
    expect(parseOriginJson(JSON.stringify(written))).toEqual(full);
  });
});

describe('originWireFields', () => {
  it('names every field on the wire, in the snake_case the client reads', () => {
    expect(originWireFields({
      workflowName: 'W', stepId: 's', stepTask: 't',
      subagentName: 'triage', subagentTask: 'Fold dupes',
    })).toEqual({
      workflow_name: 'W', step_id: 's', step_task: 't',
      subagent_name: 'triage', subagent_task: 'Fold dupes',
    });
  });

  it('agrees with the persisted row about an empty field', () => {
    // The four SSE emits used to read the meta RAW while the row went through
    // `promptOriginOf`, so `''` was absent in the database and present on the
    // wire — the live dialog and the one restored after a refresh could disagree
    // about whether a prompt had an origin at all.
    expect(originWireFields({ workflowName: '', stepId: 'load' }).workflow_name).toBeUndefined();
    expect(promptOriginOf({ workflowName: '', stepId: 'load' })?.workflowName).toBeUndefined();
  });

  it('is all-undefined when there is no origin, so the event grows no fields', () => {
    expect(Object.values(originWireFields(undefined)).every(v => v === undefined)).toBe(true);
  });
});
