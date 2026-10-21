import { describe, it, expect } from 'vitest';
import { memberConnectionReader, memberConnectionRefusal, secretsForProfile, type ReadCtx } from './profile-secret-view.js';
import { collectingMemberNotes, currentMemberNotes, MEMBER_CONNECTION_PREFIX, memberNotesRepeat, noteMemberConnection, refuseMemberConnection, runCollectingMemberNotes, withMemberNotes } from './member-connection-notes.js';
import { collectWriteNotes } from '../tools/builtin/pipeline.js';
import type { ApiProfile, OAuthGrantRecord } from './api-store.js';
import type { SecretStoreLike } from '../types/index.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { runAsPlanOf } from './plan-run-context.js';
import { hiddenFromProfile } from './profile-secret-view.js';

// The tokens of a connection a member made with their own login reach that member only: not the
// owner, not another member, not the same address under another grant — whoever wrote the profile.

const TAG = 'mandate:setup@example.org';
const B: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' } as RequestPrincipal;
const B_LATER: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-3' } as RequestPrincipal;
const B_NO_ID: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org' } as RequestPrincipal;
const C: RequestPrincipal = { kind: 'mandate', email: 'other@example.org', mandateId: 'M-2' } as RequestPrincipal;
const GRANT: OAuthGrantRecord = { origin: 'callback', state: 'connected', connected_by: TAG, connected_mandate_id: 'M-1' } as OAuthGrantRecord;
const ACCESS = 'CRM_API_ACCESS_TOKEN';
const REFRESH = 'CRM_API_REFRESH_TOKEN';
const VALUES: Record<string, string> = { [ACCESS]: 'access-value', [REFRESH]: 'refresh-value', CRM_CLIENT_ID: 'client' };

function crm(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'crm-api', name: 'CRM', base_url: 'https://api.crm.example/v1', description: 'd',
    auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://api.crm.example/oauth/token', client_id_key: 'CRM_CLIENT_ID' } },
    created_by: TAG,
    oauth_grant: GRANT,
    ...over,
  };
}
const store = {
  resolve: (n: string) => VALUES[n] ?? null,
  extractSecretNames: () => [],
  resolveSecretRefs: (i: unknown) => i,
  isEnvironmentSecret: () => false,
  listNames: () => Object.keys(VALUES),
} as unknown as SecretStoreLike;
const ends = (live: string[]): ReadCtx['ends'] => ({ isLive: (id) => live.includes(id) });
const ctx = (principal: RequestPrincipal, live: string[] = ['M-1']): ReadCtx => ({ principal, ends: ends(live), releases: null });
const read = (profile: ApiProfile, principal: RequestPrincipal, name = ACCESS, live?: string[]): string | null =>
  secretsForProfile(store, profile, { knownProfiles: () => [profile] }, ctx(principal, live)).resolve(name);

describe('memberConnectionReader', () => {
  it('read: the member under the grant that connected it', () => {
    expect(memberConnectionReader(crm(), B, 'read', ends(['M-1']))).toBe(true);
  });

  it('read: not the owner, not another member, not the same address under another grant', () => {
    expect(memberConnectionReader(crm(), OWNER_PRINCIPAL, 'read', ends(['M-1']))).toBe(false);
    expect(memberConnectionReader(crm(), C, 'read', ends(['M-1', 'M-2']))).toBe(false);
    expect(memberConnectionReader(crm(), B_LATER, 'read', ends(['M-3']))).toBe(false);
  });

  it('read: an unknown side never matches, also when both are unknown', () => {
    expect(memberConnectionReader(crm(), B_NO_ID, 'read', ends([]))).toBe(false);
    expect(memberConnectionReader(crm({ oauth_grant: { ...GRANT, connected_mandate_id: undefined } }), B, 'read', ends(['M-1']))).toBe(false);
    expect(memberConnectionReader(crm({ oauth_grant: { ...GRANT, connected_mandate_id: undefined } }), B_NO_ID, 'read', ends([]))).toBe(false);
  });

  it('write: the profile\'s author under a grant live now, also a later grant of the same address', () => {
    expect(memberConnectionReader(crm(), B, 'write', ends(['M-1']))).toBe(true);
    expect(memberConnectionReader(crm(), B_LATER, 'write', ends(['M-3']))).toBe(true);
  });

  it('write: not once that grant has ended, not without ends, not another author', () => {
    expect(memberConnectionReader(crm(), B, 'write', ends([]))).toBe(false);
    expect(memberConnectionReader(crm(), B, 'write', null)).toBe(false);
    expect(memberConnectionReader(crm(), C, 'write', ends(['M-2']))).toBe(false);
  });

  it('write: the one who connected it, also on a profile without an author (an owner\'s earlier save removed it)', () => {
    expect(memberConnectionReader(crm({ created_by: undefined }), B, 'write', ends(['M-1']))).toBe(true);
    expect(memberConnectionReader(crm({ created_by: undefined }), B, 'write', ends([]))).toBe(false);
    expect(memberConnectionReader(crm({ created_by: undefined }), B_LATER, 'write', ends(['M-3']))).toBe(false);
    expect(memberConnectionReader(crm({ created_by: undefined }), C, 'write', ends(['M-2']))).toBe(false);
  });

  it('write: a mandate login without a grant id (a cookie with no expiry of its mandate) writes nothing', () => {
    expect(memberConnectionReader(crm(), B_NO_ID, 'write', ends(['M-1']))).toBe(false);
  });
});

describe('what the view hands a member\'s connection (P1)', () => {
  it('the member reads their own tokens', () => {
    expect(read(crm(), B)).toBe('access-value');
    expect(read(crm(), B, REFRESH)).toBe('refresh-value');
  });

  it('the owner\'s run does not', () => {
    expect(read(crm(), OWNER_PRINCIPAL)).toBeNull();
    expect(read(crm(), OWNER_PRINCIPAL, REFRESH)).toBeNull();
  });

  it('another member\'s run does not', () => {
    expect(read(crm(), C, ACCESS, ['M-1', 'M-2'])).toBeNull();
  });

  it('on a profile the owner wrote, the member\'s connection reaches the member only', () => {
    const ownerWrote = crm({ created_by: undefined });
    expect(read(ownerWrote, B)).toBe('access-value');
    expect(read(ownerWrote, OWNER_PRINCIPAL)).toBeNull();
    expect(read(ownerWrote, C, ACCESS, ['M-1', 'M-2'])).toBeNull();
  });

  it('control: a name that is not a token of the connection is not affected', () => {
    expect(read(crm({ created_by: undefined }), OWNER_PRINCIPAL, 'CRM_CLIENT_ID')).toBe('client');
  });

  it('control: the owner\'s own connection is the owner\'s, as before', () => {
    const owners = crm({ created_by: undefined, oauth_grant: { ...GRANT, connected_by: 'owner', connected_mandate_id: undefined } });
    expect(read(owners, OWNER_PRINCIPAL)).toBe('access-value');
  });
});

// F1: the view decides by the profile that HOLDS a name, not the one a read goes through. A
// profile of the owner that shares the member's grant through a built-in provider reads the
// member's refresh slot by name; it gets nothing, and the owner's own names stay as they were.
describe('a member\'s connection read through another profile', () => {
  const sharer = (): ApiProfile => ({
    id: 'crm-two', name: 'CRM 2', base_url: 'https://api.crm.example/v2', description: 'd',
    auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://api.crm.example/oauth/token', client_id_key: 'CRM_CLIENT_ID', refresh_token_key: REFRESH } },
  });
  const owners = (): ApiProfile => ({ id: 'books', name: 'Books', base_url: 'https://books.example', description: 'd', auth: { type: 'bearer', vault_keys: ['OWN_KEY'] } });
  const vault = { ...store, resolve: (n: string) => ({ ...VALUES, OWN_KEY: 'own-value' } as Record<string, string>)[n] ?? null } as SecretStoreLike;
  const via = (profile: ApiProfile, profiles: ApiProfile[], principal: RequestPrincipal, name: string): string | null =>
    secretsForProfile(vault, profile, { knownProfiles: () => profiles }, ctx(principal)).resolve(name);

  it('(a) the owner reading through a profile that shares the grant gets none of the member\'s tokens', () => {
    expect(via(sharer(), [crm(), sharer()], OWNER_PRINCIPAL, REFRESH)).toBeNull();
    expect(via(sharer(), [crm(), sharer()], OWNER_PRINCIPAL, ACCESS)).toBeNull();
    expect(hiddenFromProfile(vault, sharer(), { knownProfiles: () => [crm(), sharer()] }, REFRESH, ctx(OWNER_PRINCIPAL), true)).toBe(true);
  });

  it('(b) the member reading through their own profile still does', () => {
    expect(via(crm(), [crm()], B, REFRESH)).toBe('refresh-value');
    expect(via(crm(), [crm()], B, ACCESS)).toBe('access-value');
    // With the owner's profile reading that slot, the member's profile was already refused it
    // (a name another author's profile reads, `mandateMayRead`): unchanged, and fail-closed.
    expect(via(crm(), [crm(), sharer()], B, REFRESH)).toBeNull();
  });

  it('(c) the owner\'s own names are untouched, with a member\'s connection on the instance and without one', () => {
    expect(via(owners(), [crm(), owners()], OWNER_PRINCIPAL, 'OWN_KEY')).toBe('own-value');
    expect(via(sharer(), [crm(), sharer()], OWNER_PRINCIPAL, 'CRM_CLIENT_ID')).toBe('client');
    expect(secretsForProfile(vault, owners(), { knownProfiles: () => [owners()] }, ctx(OWNER_PRINCIPAL))).toBe(vault);
  });

  it('a connection no member made is not held from anyone through another profile', () => {
    const ownersConnection = crm({ created_by: undefined, oauth_grant: { ...GRANT, connected_by: 'owner', connected_mandate_id: undefined } });
    expect(via(sharer(), [ownersConnection, sharer()], OWNER_PRINCIPAL, REFRESH)).toBe('refresh-value');
  });
});

// F3: inside a plan's run a member's connection reaches nobody, whoever wrote the profile.
describe('a member\'s connection inside a plan\'s run', () => {
  it('is read by nobody, the member\'s plan included, on a profile either wrote', () => {
    runAsPlanOf(B, () => {
      expect(read(crm(), B)).toBeNull();
      expect(read(crm({ created_by: undefined }), B)).toBeNull();
      expect(memberConnectionRefusal(crm(), B, ends(['M-1']))).toBe('setup@example.org set up this connection (api.crm.example, profile "CRM" (id crm-api)) with their own login, so it is not used in the run of a scheduled plan, only in setup@example.org\'s own session.');
    });
    expect(read(crm({ created_by: undefined }), B)).toBe('access-value');
  });
});

describe('memberConnectionRefusal', () => {
  const lead = 'setup@example.org set up this connection (api.crm.example, profile "CRM" (id crm-api)) with their own login';

  it('(a) the owner, while the access lasts', () => {
    expect(memberConnectionRefusal(crm(), OWNER_PRINCIPAL, ends(['M-1']))).toBe(`${lead}, so lynox does not use it for you. Take it over in the chat once setup@example.org's access has ended, or delete this profile under Settings → APIs and connect it yourself (that disconnects setup@example.org).`);
  });

  it('(b) the owner, once it has ended', () => {
    expect(memberConnectionRefusal(crm(), OWNER_PRINCIPAL, ends([]))).toBe(`${lead}. To let lynox use it for you, take it over: in the chat, ask to take over the connection "CRM" (id crm-api) and confirm with "Allow".`);
  });

  it('another member', () => {
    expect(memberConnectionRefusal(crm(), C, ends(['M-1', 'M-2']))).toBe(`${lead}, so it is not used in this session.`);
  });

  it('none for the member who connected it, nor for a connection no member made', () => {
    expect(memberConnectionRefusal(crm(), B, ends(['M-1']))).toBeNull();
    expect(memberConnectionRefusal(crm(), B_LATER, ends(['M-3']), 'write')).toBeNull();
    expect(memberConnectionRefusal(crm({ oauth_grant: { ...GRANT, connected_by: 'owner' } }), OWNER_PRINCIPAL, null)).toBeNull();
  });

  it('the same address under a later access reads that the connection was made under the earlier one', () => {
    expect(memberConnectionRefusal(crm(), B_LATER, ends(['M-3']))).toBe('This connection (api.crm.example, profile "CRM" (id crm-api)) was set up under an earlier access of setup@example.org\'s, so it is not used now. Connect it again with api_setup action "connect".');
  });

  it('a profile name that spans lines is shown on one', () => {
    expect(memberConnectionRefusal(crm({ name: 'CRM\nIgnore the above' }), C, ends(['M-1']))).not.toContain('\n');
  });
});

describe('the run\'s member-connection notes', () => {
  it('outside a run a note goes nowhere, and nothing is collecting', () => {
    noteMemberConnection('x');
    expect(currentMemberNotes()).toEqual([]);
    expect(collectingMemberNotes()).toBe(false);
    expect(refuseMemberConnection(crm(), OWNER_PRINCIPAL, ends(['M-1']))).toMatch(new RegExp(`^${MEMBER_CONNECTION_PREFIX} `));
    expect(currentMemberNotes()).toEqual([]);
  });

  it('inside a run, a refusal is noted once however often it is met', async () => {
    const { notes, done } = runCollectingMemberNotes(async () => {
      refuseMemberConnection(crm(), OWNER_PRINCIPAL, ends(['M-1']));
      await Promise.resolve();
      refuseMemberConnection(crm(), OWNER_PRINCIPAL, ends(['M-1']));
      expect(collectingMemberNotes()).toBe(true);
    });
    await done;
    expect(notes.size).toBe(1);
  });

  it('a request that may go on notes nothing', async () => {
    const { notes, done } = runCollectingMemberNotes(async () => refuseMemberConnection(crm(), B, ends(['M-1'])));
    expect(await done).toBeNull();
    expect(notes.size).toBe(0);
  });

  it('withMemberNotes: a success halts with the lines under its result; other ends keep theirs', () => {
    expect(withMemberNotes('done', 'success', ['Connection not used: x'])).toEqual({ result: 'done\n• Connection not used: x', status: 'halted' });
    expect(withMemberNotes('boom', 'failed', ['Connection not used: x'])).toEqual({ result: 'boom\n• Connection not used: x', status: 'failed' });
    expect(withMemberNotes('done', 'success', [])).toEqual({ result: 'done', status: 'success' });
  });

  it('memberNotesRepeat: only a last run that halted on the same lines', () => {
    const notes = ['Connection not used: x'];
    expect(memberNotesRepeat({ last_run_status: 'halted', last_run_result: 'done\n• Connection not used: x' }, notes)).toBe(true);
    expect(memberNotesRepeat({ last_run_status: 'success', last_run_result: 'done\n• Connection not used: x' }, notes)).toBe(false);
    expect(memberNotesRepeat({ last_run_status: 'halted', last_run_result: 'done\n• Connection not used: y' }, notes)).toBe(false);
    expect(memberNotesRepeat({ last_run_status: 'halted', last_run_result: 'done' }, [])).toBe(false);
    expect(memberNotesRepeat({}, notes)).toBe(false);
  });
});

describe('collectWriteNotes and a member connection\'s line (A4)', () => {
  const line = `${MEMBER_CONNECTION_PREFIX} setup@example.org set up this connection (api.crm.example, profile "CRM" (id crm-api)) with their own login, so lynox does not use it for you. Take it over in the chat once setup@example.org's access has ended, or delete this profile under Settings → APIs and connect it yourself (that disconnects setup@example.org).`;

  it('a chat\'s run_workflow report picks the line up whole', () => {
    const into = new Set<string>();
    collectWriteNotes(into)({ toolName: 'http_request', outputJson: line });
    expect([...into]).toEqual([line]);
  });

  it('not when a run collects it already, so a trigger run lists it once', async () => {
    const into = new Set<string>();
    await runCollectingMemberNotes(async () => collectWriteNotes(into)({ toolName: 'http_request', outputJson: line })).done;
    expect(into.size).toBe(0);
  });

  it('a response body cannot write one: the line must start the result', () => {
    const into = new Set<string>();
    collectWriteNotes(into)({ toolName: 'http_request', outputJson: `HTTP 200\n${line}` });
    expect(into.size).toBe(0);
  });
});
