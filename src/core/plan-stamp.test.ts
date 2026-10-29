import { describe, it, expect, beforeEach } from 'vitest';
import { encodeStamp, planOfTrigger, stampEntriesFor, stampExpect, stampFromRow, stampListState, stampSubject } from './plan-stamp.js';
import type { ApiProfile, OAuthGrantRecord } from './api-store.js';
import { runAsPlanOf } from './plan-run-context.js';
import { bindingOf, planConnectionState } from './profile-secret-view.js';
import type { RequestPrincipal } from './request-principal.js';
import { _resetPipelineStore, storePipeline, type PlannedPipeline } from '../tools/builtin/pipeline.js';
import type { RunHistory } from './run-history.js';
import type { TriggerRecord } from '../types/index.js';

const AT = '2026-10-08T00:00:00.000Z';
const WF = '2026-10-07T00:00:00.000Z';
const ENTRIES = [{ profile: 'crm-api', grant: 'grant-1', binding: 'b'.repeat(64) }];

describe('stampFromRow: the list counts only for the stamp it was written with', () => {
  it('gives the entries back for the same stamp and workflow confirmation', () => {
    expect(stampFromRow(encodeStamp(AT, null, ENTRIES), AT, null)).toEqual(ENTRIES);
    expect(stampFromRow(encodeStamp(AT, WF, ENTRIES), AT, WF)).toEqual(ENTRIES);
  });

  it('gives none for another stamp, no stamp, or another workflow confirmation', () => {
    expect(stampFromRow(encodeStamp(AT, null, ENTRIES), '2026-10-09T00:00:00.000Z', null)).toBeNull();
    expect(stampFromRow(encodeStamp(AT, null, ENTRIES), null, null)).toBeNull();
    expect(stampFromRow(encodeStamp(AT, WF, ENTRIES), AT, '2026-10-09T00:00:00.000Z')).toBeNull();
    expect(stampFromRow(encodeStamp(AT, WF, ENTRIES), AT, null)).toBeNull();
    expect(stampFromRow(encodeStamp(AT, null, ENTRIES), AT, WF)).toBeNull();
  });

  it.each([
    ['nothing stored', null],
    ['not JSON', '{'],
    ['not an object', '"x"'],
    ['no entries', JSON.stringify({ at: AT, wf: null })],
    ['an empty list', encodeStamp(AT, null, [])],
    ['an entry without a grant', JSON.stringify({ at: AT, wf: null, entries: [{ profile: 'crm-api', binding: 'b' }] })],
    ['an entry with a number for a profile', JSON.stringify({ at: AT, wf: null, entries: [{ profile: 1, grant: 'g', binding: 'b' }] })],
    ['one good entry beside a broken one', JSON.stringify({ at: AT, wf: null, entries: [...ENTRIES, null] })],
  ])('gives none for %s', (_label, raw) => {
    expect(stampFromRow(raw, AT, null)).toBeNull();
  });
});

describe('stampExpect', () => {
  const T = { id: 't1', effect: 'run_agent', title: 'Report', description: 'Weekly', created_mandate_id: 'M-EVA' } as unknown as TriggerRecord;
  it('is the same for a watch whose run moved only its baseline, and differs when what it watches changes', () => {
    const W = { ...T, watch_config: JSON.stringify({ url: 'https://a.example', last_hash: 'h1' }) } as TriggerRecord;
    expect(stampExpect({ ...W, watch_config: JSON.stringify({ url: 'https://a.example', last_hash: 'h2' }) }, null, ENTRIES)).toBe(stampExpect(W, null, ENTRIES));
    expect(stampExpect({ ...W, watch_config: JSON.stringify({ url: 'https://b.example', last_hash: 'h1' }) }, null, ENTRIES)).not.toBe(stampExpect(W, null, ENTRIES));
    expect(stampExpect({ ...W, watch_config: JSON.stringify({ url: 'https://a.example', selector: '#price', last_hash: 'h1' }) }, null, ENTRIES)).not.toBe(stampExpect(W, null, ENTRIES));
    expect(stampExpect({ ...W, watch_config: JSON.stringify({ url: 'https://a.example', interval_minutes: 5, last_hash: 'h1' }) }, null, ENTRIES)).not.toBe(stampExpect(W, null, ENTRIES));
  });

  it('takes a watch config it cannot read as it stands, so two different ones still differ', () => {
    const at = (watch_config: string): string => stampExpect({ ...T, watch_config } as TriggerRecord, null, ENTRIES);
    expect(at('not json')).not.toBe(at('also not json'));
    expect(at('[1]')).not.toBe(at('[2]'));
    expect(at('null')).not.toBe(at('"x"'));
  });

  it('is the same for the same schedule and list, and differs for a change of the list or of any field it binds', () => {
    expect(stampExpect(T, null, ENTRIES)).toBe(stampExpect({ ...T }, null, [{ ...ENTRIES[0]! }]));
    expect(stampExpect(T, null, ENTRIES)).not.toBe(stampExpect(T, null, []));
    expect(stampExpect(T, null, ENTRIES)).not.toBe(stampExpect(T, null, [{ ...ENTRIES[0]!, grant: 'grant-2' }]));
    expect(stampExpect(T, null, ENTRIES)).not.toBe(stampExpect(T, null, [{ ...ENTRIES[0]!, binding: 'c'.repeat(64) }]));
    expect(stampExpect(T, null, ENTRIES)).not.toBe(stampExpect(T, WF, ENTRIES));
    for (const change of [
      { id: 't2' }, { effect: 'run_workflow' }, { title: 'Report, then mail everyone' }, { description: 'Daily' },
      { schedule_cron: '* * * * *' }, { watch_config: '{}' }, { pipeline_id: 'wf-2' }, { pipeline_params: '{"a":1}' },
      { model_tier: 'deep' }, { created_mandate_id: 'M-OTHER' }, { mandate_editor_id: 'M-OTHER' },
    ]) {
      expect(stampExpect({ ...T, ...change } as TriggerRecord, null, ENTRIES)).not.toBe(stampExpect(T, null, ENTRIES));
    }
  });
});

describe('stampSubject', () => {
  const T = { id: 't1', effect: 'run_agent', title: 'Report', description: 'Weekly', created_mandate_id: 'M-EVA' } as unknown as TriggerRecord;
  it('is what the digest binds: a field changes the subject exactly when it changes the digest', () => {
    // The preview shows the owner this subject, so a field the digest held but the subject did
    // not would be stamped unseen.
    for (const change of [
      { id: 't2' }, { effect: 'run_workflow' }, { source: 'watch' }, { title: 'Report, then mail everyone' }, { description: 'Daily' },
      { schedule_cron: '* * * * *' }, { watch_config: '{}' }, { pipeline_id: 'wf-2' }, { pipeline_params: '{"a":1}' },
      { model_tier: 'deep' }, { created_mandate_id: 'M-OTHER' }, { mandate_editor_id: 'M-OTHER' },
      { watch_config: JSON.stringify({ url: 'https://a.example', interval_minutes: 5 }) },
    ]) {
      const t = { ...T, ...change } as TriggerRecord;
      expect([stampSubject(t, null)].map((x) => JSON.stringify(x))).not.toEqual([JSON.stringify(stampSubject(T, null))]);
      expect(stampExpect(t, null, ENTRIES)).not.toBe(stampExpect(T, null, ENTRIES));
    }
    expect(stampSubject(T, WF).wf).toBe(WF);
    // And a run moving only a watch's baseline changes neither.
    const W = { ...T, watch_config: JSON.stringify({ url: 'https://a.example', last_hash: 'h1' }) } as TriggerRecord;
    expect(stampSubject({ ...W, watch_config: JSON.stringify({ url: 'https://a.example', last_hash: 'h2' }) }, null)).toEqual(stampSubject(W, null));
  });
});

describe('planOfTrigger', () => {
  beforeEach(() => { _resetPipelineStore(); });

  const history = (authorship: unknown): RunHistory => ({
    getPlannedPipeline: () => undefined,
    getWorkflowAuthorship: () => authorship,
  }) as unknown as RunHistory;
  const MANDATE_WF = { createdBy: 'mandate:eva@kanzlei.example', createdMandateId: 'M-EVA', mandateEditor: null, mandateEditorId: null, mandateEditedAt: null, createdAt: '2026-10-01 00:00:00' };

  it('carries the workflow\'s confirmation for a workflow schedule, and none for any other', async () => {
    storePipeline('wf-1', { id: 'wf-1', name: 'w', confirmedAt: WF } as unknown as PlannedPipeline);
    const wfTask = { id: 't', effect: 'run_workflow', pipeline_id: 'wf-1', created_by: 'owner' } as unknown as TriggerRecord;
    const plan = await planOfTrigger(wfTask, history(MANDATE_WF));
    expect(plan.workflowConfirmedAt).toBe(WF);
    expect(plan.of).toMatchObject({ kind: 'mandate', mandateId: 'M-EVA' });
    const agent = await planOfTrigger({ id: 'a', effect: 'run_agent', created_by: 'owner' } as unknown as TriggerRecord, history(MANDATE_WF));
    expect(agent.workflowConfirmedAt).toBeNull();
  });

  it('carries no confirmation for a workflow not yet confirmed', async () => {
    storePipeline('wf-2', { id: 'wf-2', name: 'w' } as unknown as PlannedPipeline);
    const plan = await planOfTrigger({ id: 't', effect: 'run_workflow', pipeline_id: 'wf-2', created_by: 'owner' } as unknown as TriggerRecord, history(MANDATE_WF));
    expect(plan.workflowConfirmedAt).toBeNull();
  });
});

describe('stampListState: what the owner\'s list of a confirmed plan shows (B3)', () => {
  const EVA = { kind: 'mandate', email: 'eva@kanzlei.example', mandateId: 'M-1' } as RequestPrincipal;
  const G = { origin: 'callback', state: 'connected', connected_by: 'mandate:eva@kanzlei.example', connected_mandate_id: 'M-1', grant_id: 'grant-1', account: { label: 'eva@crm', source: 'userinfo' } } as OAuthGrantRecord;
  const crm = (over: Partial<ApiProfile> = {}): ApiProfile => ({
    id: 'crm-api', name: 'CRM', base_url: 'https://api.crm.example/v1', description: 'd', created_by: 'mandate:eva@kanzlei.example',
    auth: { type: 'oauth2', vault_keys: [], oauth: { token_url: 'https://api.crm.example/oauth/token', client_id_key: 'CRM_CLIENT_ID' } },
    oauth_grant: G, ...over,
  });
  const live = { isLive: (id: string) => id === 'M-1' };
  const store = (...ps: ApiProfile[]) => ({ knownProfiles: () => ps });
  const stamped = (ps: ApiProfile[], wf: string | null = null): string => encodeStamp(AT, wf, stampEntriesFor(EVA, store(...ps), live));

  it('lists what a run may use, as listed, with the provider and the account', () => {
    const p = crm();
    expect(stampListState(stamped([p]), AT, null, EVA, store(p), live)).toEqual({
      lapsed: false, ended: false, entries: [{ provider: 'api.crm.example', account: 'eva@crm', state: 'listed' }],
    });
  });

  it('a connection made again (an unknown account too) or pointed elsewhere is changed, and a run does not use it', () => {
    // bp's condition (2): the account is unknown, and the stamp still binds the grant, not the profile.
    const p = crm({ oauth_grant: { ...G, account: undefined } as OAuthGrantRecord });
    const raw = stamped([p]);
    for (const now of [crm({ oauth_grant: { ...G, account: undefined, grant_id: 'grant-2' } as OAuthGrantRecord }), crm({ base_url: 'https://evil.example/v1', oauth_grant: { ...G, account: undefined } as OAuthGrantRecord })]) {
      expect(stampListState(raw, AT, null, EVA, store(now), live)!.entries).toEqual([{ provider: expect.any(String), account: null, state: 'changed' }]);
      expect(runAsPlanOf(EVA, () => planConnectionState(now), stampFromRow(raw, AT, null))).toBe('changed');
    }
  });

  it('shows listed exactly where the run reads the connection as listed', () => {
    // Parity with the run's own reader, over the states a row can be in.
    const p = crm();
    const raw = stamped([p]);
    const variants: ApiProfile[] = [p, crm({ oauth_grant: { ...G, grant_id: 'grant-2' } as OAuthGrantRecord }), crm({ base_url: 'https://other.example' })];
    for (const now of variants) {
      const shown = stampListState(raw, AT, null, EVA, store(now), live)!.entries[0]!.state;
      const run = runAsPlanOf(EVA, () => planConnectionState(now), stampFromRow(raw, AT, null));
      expect(shown === 'listed', `${now.base_url} ${now.oauth_grant?.grant_id}`).toBe(run === 'listed');
    }
    expect(bindingOf(variants[2]!)).not.toBe(bindingOf(p));
  });

  it('a connection removed since is changed, with no provider', () => {
    expect(stampListState(stamped([crm()]), AT, null, EVA, store(), live)!.entries).toEqual([{ provider: null, account: null, state: 'changed' }]);
  });

  it('a connection made since the stamp is new; nothing stored and nothing new shows nothing', () => {
    const p = crm();
    const q = crm({ id: 'shop-api', base_url: 'https://shop.example/api', oauth_grant: { ...G, grant_id: 'grant-s', account: undefined } as OAuthGrantRecord });
    expect(stampListState(stamped([p]), AT, null, EVA, store(p, q), live)!.entries.map((e) => e.state)).toEqual(['listed', 'new']);
    // A plan stamped empty before the helper connected: the new one is what the owner sees.
    expect(stampListState(encodeStamp(AT, null, []), AT, null, EVA, store(q), live)).toEqual({ lapsed: false, ended: false, entries: [{ provider: 'shop.example', account: null, state: 'new' }] });
    expect(stampListState(null, AT, null, EVA, store(), live)).toBeNull();
    expect(stampListState(encodeStamp(AT, null, []), AT, null, EVA, store(), live)).toBeNull();
  });

  it('the whole list lapses when the trigger or its workflow was stamped again, and only then', () => {
    const p = crm();
    expect(stampListState(stamped([p]), '2026-10-09T00:00:00.000Z', null, EVA, store(p), live)!.lapsed).toBe(true);
    expect(stampListState(stamped([p], WF), AT, '2026-10-09T00:00:00.000Z', EVA, store(p), live)!.lapsed).toBe(true);
    expect(stampListState(stamped([p], WF), AT, null, EVA, store(p), live)!.lapsed).toBe(true);
    expect(stampListState(stamped([p], WF), AT, WF, EVA, store(p), live)!.lapsed).toBe(false);
    // A changed entry alone does not lapse the list.
    expect(stampListState(stamped([p]), AT, null, EVA, store(crm({ oauth_grant: { ...G, grant_id: 'grant-2' } as OAuthGrantRecord })), live)!.lapsed).toBe(false);
  });

  it('once the mandate\'s access ended, every entry waits and the list says ended', () => {
    const p = crm();
    const ended = { isLive: () => false };
    expect(stampListState(stamped([p]), AT, null, EVA, store(p), ended)).toEqual({ lapsed: false, ended: true, entries: [{ provider: 'api.crm.example', account: 'eva@crm', state: 'waits' }] });
    expect(stampListState(stamped([p]), AT, null, EVA, store(p), null)!.ended).toBe(true);
    // One removed since stays removed, under the ended note.
    expect(stampListState(stamped([p]), AT, null, EVA, store(), ended)).toEqual({ lapsed: false, ended: true, entries: [{ provider: null, account: null, state: 'changed' }] });
  });

  it('carries no grant, no binding, no mandate id', () => {
    const p = crm();
    const out = JSON.stringify(stampListState(stamped([p]), AT, null, EVA, store(p, crm({ id: 'x', oauth_grant: { ...G, grant_id: 'grant-x' } as OAuthGrantRecord })), live));
    for (const secret of ['grant-1', 'grant-x', bindingOf(p), 'M-1', 'crm-api']) expect(out).not.toContain(secret);
  });
});
