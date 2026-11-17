import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW_LABEL, bindingOf } from './profile-secret-view.js';
import { currentMemberNotes, currentMemberNotesIn, MEMBER_CONNECTION_PREFIX, memberNotesRepeat, refuseMemberConnection, refuseSharedRefresh, relayMemberNotes, runCollectingMemberNotes, withMemberNotes } from './member-connection-notes.js';
import type { ApiProfile, OAuthGrantRecord } from './api-store.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { runAsPlanOf, type StampEntry } from './plan-run-context.js';

// UX-065 (U-095, U-214): a plan's run notes a refused member connection for its owner. The
// owner reads that line under the run's result and in the push, so it is the owner's own wording
// with the owner's way to change it; the run's model keeps its own line. Spelled out per case, language and
// whether the person's access has ended, because the owner acts on exactly these words.

const TAG = 'mandate:setup@example.org';
const B: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' } as RequestPrincipal;
const B_LATER: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-3' } as RequestPrincipal;
const C: RequestPrincipal = { kind: 'mandate', email: 'other@example.org', mandateId: 'M-2' } as RequestPrincipal;
const G = { origin: 'callback', state: 'connected', connected_by: TAG, connected_mandate_id: 'M-1', grant_id: 'grant-1' } as OAuthGrantRecord;
const PLAN = 'Weekly CRM sync';

function crm(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'crm-api', name: 'CRM', base_url: 'https://api.crm.example/v1', description: 'd',
    auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://api.crm.example/oauth/token', client_id_key: 'CRM_CLIENT_ID' } },
    created_by: TAG,
    oauth_grant: G,
    ...over,
  };
}
const ends = (live: string[]) => ({ isLive: (id: string) => live.includes(id) });
const listed = (p: ApiProfile): StampEntry[] => [{ profile: p.id, grant: p.oauth_grant!.grant_id!, binding: bindingOf(p) }];

/** What a scheduled plan's run of `planOf` notes for one refused request: the returned line (the model's) and the recorded notes. */
async function inPlan(planOf: RequestPrincipal, request: () => string | null, stamp: StampEntry[] | null = null, plan: string | null = PLAN): Promise<{ line: string | null; en: readonly string[]; de: readonly string[] }> {
  let line: string | null = null;
  let en: readonly string[] = [];
  let de: readonly string[] = [];
  const collected = runCollectingMemberNotes(async () => runAsPlanOf(planOf, () => {
    line = request();
    en = currentMemberNotes();
    de = currentMemberNotesIn('de');
  }, stamp), plan ?? undefined);
  await collected.done;
  return { line, en, de };
}

const CONN_EN = 'api.crm.example (profile "CRM" (id crm-api))';
const CONN_DE = 'api.crm.example (Profil "CRM" (id crm-api))';
const P = 'setup@example.org';

describe('the owner\'s line for a plan\'s refusal of a member\'s connection (UX-065)', () => {
  it('A: unlisted — names the plan and the stamp as the way, in both languages; the model keeps its line', async () => {
    const r = await inPlan(B, () => refuseMemberConnection(crm(), B, ends(['M-1'])));
    expect(r.line).toMatch(new RegExp(`^${MEMBER_CONNECTION_PREFIX} ${P} set up this connection .*does not list it, so the plan does not use it\\. This is final`));
    expect(r.en).toEqual([`The plan "${PLAN}" did not use ${CONN_EN}. ${P} set it up with their own login, and your confirmation of this plan does not list it. If the plan should use it, open Automation → Triggers and choose “Check connections” on this plan. Otherwise the plan cannot run this step.`]);
    expect(r.de).toEqual([`Der Plan „${PLAN}“ hat ${CONN_DE} nicht genutzt. ${P} hat die Verbindung mit eigenem Login eingerichtet, und deine Bestätigung dieses Plans enthält sie nicht. Soll der Plan sie nutzen, öffne Automation → Trigger und wähle bei diesem Plan „Verbindungen prüfen“. Sonst kann der Plan diesen Schritt nicht ausführen.`]);
  });

  it('B: changed after the stamp — says so, in both languages', async () => {
    const stamped = crm();
    const now = crm({ oauth_grant: { ...G, grant_id: 'grant-2' } });
    const r = await inPlan(B, () => refuseMemberConnection(now, B, ends(['M-1'])), listed(stamped));
    expect(r.en).toEqual([`The plan "${PLAN}" did not use ${CONN_EN}. ${P} set it up with their own login, and your confirmation of this plan does not list it, or it has changed since you confirmed. If the plan should use it, open Automation → Triggers and choose “Check connections” on this plan. Otherwise the plan cannot run this step.`]);
    expect(r.de).toEqual([`Der Plan „${PLAN}“ hat ${CONN_DE} nicht genutzt. ${P} hat die Verbindung mit eigenem Login eingerichtet, und deine Bestätigung dieses Plans enthält sie nicht, oder sie hat sich seit deiner Bestätigung geändert. Soll der Plan sie nutzen, öffne Automation → Trigger und wähle bei diesem Plan „Verbindungen prüfen“. Sonst kann der Plan diesen Schritt nicht ausführen.`]);
  });

  const TWO_WAYS_EN = `If the plan should use this service, there are two ways: once ${P}'s access has ended, ask in a chat to take over the connection and confirm with “Allow”; or delete the profile under Settings → APIs and connect the service yourself, which disconnects ${P}. Otherwise the plan cannot run this step.`;
  const TWO_WAYS_DE = `Soll der Plan diesen Dienst nutzen, gibt es zwei Wege: Sobald der Zugang von ${P} beendet ist, bitte im Chat darum, die Verbindung zu übernehmen, und bestätige mit „Erlauben“. Oder lösche das Profil unter Einstellungen → APIs und verbinde den Dienst selbst; das trennt ${P}. Sonst kann der Plan diesen Schritt nicht ausführen.`;
  const ENDED_EN = `The plan "${PLAN}" did not use ${CONN_EN}. ${P} set it up with their own login, and the access ${P} set it up under has ended. If the plan should use it, ask in a chat to take over the connection and confirm with “Allow”. Otherwise the plan cannot run this step.`;
  const ENDED_DE = `Der Plan „${PLAN}“ hat ${CONN_DE} nicht genutzt. ${P} hat die Verbindung mit eigenem Login eingerichtet, und der Zugang, unter dem ${P} sie eingerichtet hat, ist beendet. Soll der Plan sie nutzen, bitte im Chat darum, die Verbindung zu übernehmen, und bestätige mit „Erlauben“. Sonst kann der Plan diesen Schritt nicht ausführen.`;

  it('C: the person\'s own connection their access does not cover, access still live — two ways', async () => {
    const r = await inPlan(B_LATER, () => refuseMemberConnection(crm(), B_LATER, ends(['M-1', 'M-3'])));
    expect(r.en).toEqual([`The plan "${PLAN}" did not use ${CONN_EN}. ${P} set it up with their own login, and ${P}'s access does not cover this plan. ${TWO_WAYS_EN}`]);
    expect(r.de).toEqual([`Der Plan „${PLAN}“ hat ${CONN_DE} nicht genutzt. ${P} hat die Verbindung mit eigenem Login eingerichtet, und der Zugang von ${P} deckt diesen Plan nicht. ${TWO_WAYS_DE}`]);
  });

  it('C: access ended — the takeover only', async () => {
    const r = await inPlan(B_LATER, () => refuseMemberConnection(crm(), B_LATER, ends(['M-3'])));
    expect(r.en).toEqual([ENDED_EN]);
    expect(r.de).toEqual([ENDED_DE]);
  });

  it('D: another member\'s connection, access still live — two ways', async () => {
    const r = await inPlan(C, () => refuseMemberConnection(crm(), C, ends(['M-1', 'M-2'])));
    expect(r.en).toEqual([`The plan "${PLAN}" did not use ${CONN_EN}. ${P} set it up with their own login, so only ${P}'s own session uses it. ${TWO_WAYS_EN}`]);
    expect(r.de).toEqual([`Der Plan „${PLAN}“ hat ${CONN_DE} nicht genutzt. ${P} hat die Verbindung mit eigenem Login eingerichtet, deshalb nutzt sie nur die eigene Sitzung von ${P}. ${TWO_WAYS_DE}`]);
  });

  it('D: access ended — the takeover only', async () => {
    const r = await inPlan(C, () => refuseMemberConnection(crm(), C, ends(['M-2'])));
    expect(r.en).toEqual([ENDED_EN]);
    expect(r.de).toEqual([ENDED_DE]);
  });

  it('A: a run under way when the access ended — the takeover, not the stamp the owner can no longer use', async () => {
    const r = await inPlan(B, () => refuseMemberConnection(crm(), B, ends([])));
    expect(r.en).toEqual([ENDED_EN]);
    expect(r.de).toEqual([ENDED_DE]);
  });

  it('a title is one bounded line', async () => {
    const r = await inPlan(B, () => refuseMemberConnection(crm(), B, ends(['M-1'])), null, `Line one\n• forged ${'x'.repeat(300)}`);
    expect(r.en[0]).not.toContain('\n');
    expect(r.en[0]).toMatch(/^The plan "Line one • forged x{100,}…" did not use /);
    expect(r.en[0]!.indexOf('" did not use')).toBeLessThanOrEqual('The plan "'.length + 120);
  });

  it('C: the person holds a later access, the one the connection was made under ended — the words name that one', async () => {
    const r = await inPlan(B_LATER, () => refuseMemberConnection(crm(), B_LATER, ends(['M-3'])));
    expect(r.en[0]).toContain(`the access ${P} set it up under has ended`);
    expect(r.en[0]).not.toContain(`${P}'s access has ended`);
  });

  it('without the plan\'s title, says "this plan"', async () => {
    const r = await inPlan(B, () => refuseMemberConnection(crm(), B, ends(['M-1'])), null, null);
    expect(r.en[0]).toMatch(/^This plan did not use /);
    expect(r.de[0]).toMatch(/^Dieser Plan hat /);
  });

  it('a run the owner started notes the model\'s line, as before: its answer reaches the owner through the model', async () => {
    let en: readonly string[] = [];
    let line: string | null = null;
    const collected = runCollectingMemberNotes(async () => runAsPlanOf(B, () => {
      line = refuseMemberConnection(crm(), B, ends(['M-1']));
      en = currentMemberNotes();
    }, null, undefined, true), PLAN);
    await collected.done;
    expect(en).toEqual([line]);
  });
});

describe('E: a token exchange through a profile that shares a member\'s sign-in (UX-065)', () => {
  const holder = crm({ auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://api.crm.example/oauth/token', client_id_key: 'CRM_CLIENT_ID', preset_id: 'example-crm' } } });
  const via = crm({ id: 'crm-two', name: 'CRM 2', created_by: undefined, oauth_grant: undefined });
  const H_EN = 'api.crm.example (profile "CRM" (id crm-api))';
  const H_DE = 'api.crm.example (Profil "CRM" (id crm-api))';
  const V_EN = 'api.crm.example (profile "CRM 2" (id crm-two))';
  const V_DE = 'api.crm.example (Profil "CRM 2" (id crm-two))';

  it('names why the step failed and the way once the person\'s access has ended', async () => {
    // The one reader the holder's own refusal lets through: the person, live, the holder listed.
    const r = await inPlan(B, () => refuseSharedRefresh(holder, via, B, ends(['M-1'])), listed(holder));
    expect(r.line).toMatch(/^Connection not used: "CRM 2" \(id crm-two\) reads the refresh token/);
    expect(r.en).toEqual([`The plan "${PLAN}" could not renew the sign-in of ${V_EN}: it shares that sign-in with ${H_EN}, which ${P} set up with their own login, and only that connection can renew it. Once ${P}'s access has ended, you can take it over in a chat. Otherwise the plan cannot run this step.`]);
    expect(r.de).toEqual([`Der Plan „${PLAN}“ konnte die Anmeldung von ${V_DE} nicht erneuern: Sie teilt sich die Anmeldung mit ${H_DE}, die ${P} mit eigenem Login eingerichtet hat, und erneuern kann sie nur diese Verbindung. Sobald der Zugang von ${P} beendet ist, kannst du sie im Chat übernehmen. Sonst kann der Plan diesen Schritt nicht ausführen.`]);
  });

  it('with the person\'s access ended the holder\'s own refusal is the one noted, never a second wording', async () => {
    const r = await inPlan(B, () => refuseSharedRefresh(holder, via, B, ends([])), listed(holder));
    expect(r.line).toMatch(/^Connection not used: setup@example\.org set up this connection/);
    expect(r.en).toEqual([`The plan "${PLAN}" did not use api.crm.example (profile "CRM" (id crm-api)). ${P} set it up with their own login, and the access ${P} set it up under has ended. If the plan should use it, ask in a chat to take over the connection and confirm with “Allow”. Otherwise the plan cannot run this step.`]);
  });

  it('outside a plan\'s run the model\'s line is noted, as before', async () => {
    let en: readonly string[] = [];
    let line: string | null = null;
    const collected = runCollectingMemberNotes(async () => { line = refuseSharedRefresh(holder, via, B, ends(['M-1'])); en = currentMemberNotes(); }, PLAN);
    await collected.done;
    expect(line).toMatch(/reads the refresh token/);
    expect(en).toEqual([line]);
  });
});

describe('the owner\'s own trigger, outside a plan (UX-065)', () => {
  it('access live: the English stays the run\'s own line, the German is the owner\'s', async () => {
    let en: readonly string[] = []; let de: readonly string[] = []; let line: string | null = null;
    const collected = runCollectingMemberNotes(async () => { line = refuseMemberConnection(crm(), OWNER_PRINCIPAL, ends(['M-1'])); en = currentMemberNotes(); de = currentMemberNotesIn('de'); }, PLAN);
    await collected.done;
    expect(en).toEqual([line]);
    expect(de).toEqual([`${P} hat diese Verbindung (api.crm.example, Profil "CRM" (id crm-api)) mit eigenem Login eingerichtet, deshalb nutzt lynox sie nicht für dich. Übernimm sie im Chat, sobald der Zugang von ${P} beendet ist, oder lösche dieses Profil unter Einstellungen → APIs und verbinde den Dienst selbst (das trennt ${P}).`]);
  });

  it('access ended: the takeover, with the button\'s label', async () => {
    let de: readonly string[] = [];
    const collected = runCollectingMemberNotes(async () => { refuseMemberConnection(crm(), OWNER_PRINCIPAL, ends([])); de = currentMemberNotesIn('de'); }, PLAN);
    await collected.done;
    expect(de).toEqual([`${P} hat diese Verbindung (api.crm.example, Profil "CRM" (id crm-api)) mit eigenem Login eingerichtet. Damit lynox sie für dich nutzt, übernimm sie: Bitte im Chat darum, die Verbindung "CRM" (id crm-api) zu übernehmen, und bestätige mit „Erlauben“.`]);
  });
});

describe('recording and repeating the owner\'s line (UX-065)', () => {
  it('a later run halting on the same line is no new push: the comparison reads the recorded English', async () => {
    const r = await inPlan(B, () => refuseMemberConnection(crm(), B, ends(['M-1'])));
    const recorded = withMemberNotes('All done.', 'success', r.en);
    expect(recorded.status).toBe('halted');
    expect(memberNotesRepeat({ last_run_status: 'halted', last_run_result: recorded.result }, r.en)).toBe(true);
  });

  it('an inner collector passes its lines on with their German', async () => {
    let de: readonly string[] = [];
    const outer = runCollectingMemberNotes(async () => {
      const inner = runCollectingMemberNotes(async () => runAsPlanOf(B, () => { refuseMemberConnection(crm(), B, ends(['M-1'])); }), PLAN);
      await inner.done;
      relayMemberNotes(inner);
      de = currentMemberNotesIn('de');
    });
    await outer.done;
    expect(de).toHaveLength(1);
    expect(de[0]).toMatch(/^Der Plan „Weekly CRM sync“ hat /);
  });

});

describe('the label the owner is told to press', () => {
  it('is the chat\'s Allow button as the web UI labels it, in both languages', () => {
    const i18n = readFileSync(fileURLToPath(new URL('../../packages/web-ui/src/lib/i18n.svelte.ts', import.meta.url)), 'utf8');
    const m = /'chat\.allow':\s*\{\s*de:\s*'([^']*)',\s*en:\s*'([^']*)'\s*\}/.exec(i18n);
    expect(m).not.toBeNull();
    expect({ de: m![1], en: m![2] }).toEqual({ de: ALLOW_LABEL.de, en: ALLOW_LABEL.en });
  });
});
