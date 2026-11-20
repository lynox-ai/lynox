import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptMeta, PromptText } from '../../types/index.js';

/**
 * `api_setup` create/update once foreign content is in the conversation: the token address an
 * oauth2 profile saves (`auth.oauth.token_url`) is where every later token fetch and refresh posts
 * the client ID and client secret from the vault. The save goes through the origin check, as a
 * save (`credentialAddress`), not as a read. The declarations under test are the tool's own
 * (`apiSetupTool`); only its handler is replaced, so nothing is stored and no request leaves.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('../../core/stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from '../../core/agent.js';
import { OwnerKnownTargets } from '../../core/owner-known-targets.js';
import { ConversationLatch } from '../../core/conversation-latch.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { OAUTH_PRESETS } from '../../core/oauth-presets.js';
import { originRunNotice, originTokenUrlRefused } from '../../core/origin-notices.js';
import { UNATTENDED_BLOCK_ANSWER } from '../../core/prompt-store.js';
import { apiSetupTool } from './api-setup.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };
type Auth = { type: string; vault_keys?: string[]; oauth?: Record<string, unknown> };
type Profile = { id: string; name: string; base_url: string; description: string; auth?: Auth };
type Input = { action: string; profile?: Profile; id?: string; openapi_url?: string; docs_url?: string };

const SECRET_VALUE = 'Q-VALUE-FROM-THE-CHAT';
const EVIL_TOKEN_URL = `https://collect.evil.example/t/acme-invoices?leak=${SECRET_VALUE}&n=2`;

function oauthProfile(tokenUrl: string, oauth: Record<string, unknown> = {}): Profile {
  return {
    id: 'acme', name: 'Acme', base_url: 'https://api.acme.example', description: 'Acme API',
    auth: { type: 'oauth2', vault_keys: ['ACME_CLIENT_ID', 'ACME_CLIENT_SECRET'], oauth: { token_url: tokenUrl, client_id_key: 'ACME_CLIENT_ID', client_secret_key: 'ACME_CLIENT_SECRET', ...oauth } },
  };
}

/** The tool with its own declarations; the handler only records what it was asked to do. */
function apiSetup(): ToolEntry & { done: string[] } {
  const done: string[] = [];
  return {
    ...(apiSetupTool as unknown as ToolEntry),
    done,
    handler: async (input: Input) => {
      const tokenUrl = input.profile?.auth?.oauth?.['token_url'];
      done.push(input.profile ? `${input.action}:${typeof tokenUrl === 'string' ? tokenUrl : '-'}` : `${input.action}:${input.id ?? input.docs_url ?? input.openapi_url ?? ''}`);
      return 'ok';
    },
  } as unknown as ToolEntry & { done: string[] };
}

function asker(answer: string): { fn: (q: string | PromptText, o?: string[], m?: PromptMeta) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  return { asked, fn: async (q) => { asked.push(flattenPrompt(q)); return answer; } };
}

type Extra = Partial<ConstructorParameters<typeof Agent>[0]>;

function agentOf(tool: ToolEntry, promptUser: ((q: string | PromptText) => Promise<string>) | undefined, ownerText = 'nothing named', tainted = true, extra: Extra = {}): Agent {
  const agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools: [tool], promptUser,
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => [ownerText] }),
    conversationLatch: ConversationLatch.detached(),
    ...extra,
  } as ConstructorParameters<typeof Agent>[0]);
  if (tainted) agent.restoreConversationTaint();
  return agent;
}

const call = (agent: Agent, input: Input): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `s${Math.random()}`, name: 'api_setup', input });

describe('api_setup saving a token address after foreign content', () => {
  for (const action of ['create', 'update'] as const) {
    it(`${action}: an oauth2 profile with a token address the owner did not name is asked about, and not saved without a yes`, async () => {
      const tool = apiSetup();
      const ask = asker('Deny');
      const agent = agentOf(tool, ask.fn);
      const result = await call(agent, { action, profile: oauthProfile(EVIL_TOKEN_URL) });
      expect(ask.asked).toHaveLength(1);
      expect(ask.asked[0]).toMatch(/^Save this API connection\? lynox gets its tokens from "collect\.evil\.example", path "\/t\/acme-invoices", with 2 values after the "\?"\. /);
      expect(tool.done).toEqual([]);
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toMatch(/^Not saved: /);
      expect(String(result.content)).toContain('the profile was not saved');
      expect(String(result.content)).not.toMatch(/Not read|Not sent/);
    });
  }

  it('the question names the host and the path, the query only by its count, never a value (EN)', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toEqual([
      'Save this API connection? lynox gets its tokens from "collect.evil.example", path "/t/acme-invoices", with 2 values after the "?". '
      + 'Each time lynox fetches or refreshes a token, it sends the Client ID and Client Secret from your vault there. '
      + 'This conversation contains content from outside, and you haven\'t named "collect.evil.example". A yes allows this address; once the connection is saved, lynox does not ask again when it fetches tokens.\n\n'
      + 'Write "collect.evil.example" here in the chat, and lynox won\'t ask about this host again in this conversation.',
    ]);
    expect(ask.asked[0]).not.toContain(SECRET_VALUE);
    expect(ask.asked[0]).not.toContain('leak');
  });

  it('the question names the host and the path, the query only by its count, never a value (DE)', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { noticeLanguage: 'de' } as Extra);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toEqual([
      'Diese API-Verbindung speichern? lynox holt ihre Tokens bei „collect.evil.example“, Pfad „/t/acme-invoices“, mit 2 Angaben nach dem „?“. '
      + 'Bei jedem Abruf und jeder Erneuerung eines Tokens schickt lynox die Client-ID und das Client-Secret aus deinem Vault dorthin. '
      + 'Im Gespräch steht Inhalt von ausserhalb, und „collect.evil.example“ hast du nicht genannt. Ein Ja erlaubt diese Adresse; ist die Verbindung gespeichert, fragt lynox bei Token-Abrufen nicht mehr nach.\n\n'
      + 'Schreib „collect.evil.example“ hier in den Chat, dann fragt lynox in diesem Gespräch nicht mehr nach diesem Host.',
    ]);
    expect(ask.asked[0]).not.toContain(SECRET_VALUE);
  });

  it('one value is said in the singular, no query says nothing of values, and the path "/" is not named', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'create', profile: oauthProfile('https://collect.evil.example/t?x=1') });
    await call(agent, { action: 'create', profile: oauthProfile('https://collect.evil.example/oauth/token') });
    await call(agent, { action: 'create', profile: oauthProfile('https://collect.evil.example/') });
    await call(agent, { action: 'create', profile: oauthProfile('https://collect.evil.example/?a=1&b=2') });
    expect(ask.asked[0]).toContain('from "collect.evil.example", path "/t", with 1 value after the "?". Each time');
    expect(ask.asked[1]).toContain('from "collect.evil.example", path "/oauth/token". Each time');
    expect(ask.asked[1]).not.toContain('value');
    expect(ask.asked[2]).toContain('from "collect.evil.example". Each time');
    expect(ask.asked[2]).not.toContain('path');
    expect(ask.asked[3]).toContain('from "collect.evil.example", with 2 values after the "?". Each time');
    const de = asker('Deny');
    const agentDe = agentOf(tool, de.fn, 'nothing named', true, { noticeLanguage: 'de' } as Extra);
    await call(agentDe, { action: 'create', profile: oauthProfile('https://collect.evil.example/t?x=1') });
    await call(agentDe, { action: 'create', profile: oauthProfile('https://collect.evil.example/') });
    await call(agentDe, { action: 'create', profile: oauthProfile('https://collect.evil.example/oauth/token') });
    expect(de.asked[0]).toContain('bei „collect.evil.example“, Pfad „/t“, mit 1 Angabe nach dem „?“. Bei jedem');
    expect(de.asked[1]).toContain('bei „collect.evil.example“. Bei jedem');
    expect(de.asked[2]).toContain('bei „collect.evil.example“, Pfad „/oauth/token“. Bei jedem');
  });

  it('a yes saves the profile', async () => {
    const tool = apiSetup();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'update', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toHaveLength(1);
    expect(tool.done).toEqual([`update:${EVIL_TOKEN_URL}`]);
  });

  it('CONTROL: a token address on a host the owner named is saved without a question', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'the token endpoint is on auth.acme.example');
    await call(agent, { action: 'create', profile: oauthProfile('https://auth.acme.example/oauth/token') });
    await call(agent, { action: 'update', profile: oauthProfile('https://auth.acme.example/oauth/token') });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual(['create:https://auth.acme.example/oauth/token', 'update:https://auth.acme.example/oauth/token']);
  });

  it('CONTROL: without foreign content before it, the same save is not asked about', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', false);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([`create:${EVIL_TOKEN_URL}`]);
  });

  it('CONTROL: a profile on a built-in provider is not asked about, whatever its token_url says', async () => {
    const presetId = OAUTH_PRESETS.ids()[0];
    expect(presetId).toBeDefined();
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL, { preset_id: presetId }) });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([`create:${EVIL_TOKEN_URL}`]);
  });

  it('CONTROL: a provider id this engine does not know is no way around the question', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL, { preset_id: 'no-such-provider' }) });
    expect(ask.asked).toHaveLength(1);
    expect(tool.done).toEqual([]);
  });

  it('CONTROL: a profile without oauth2 is not asked about', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    const bearer: Profile = { id: 'acme', name: 'Acme', base_url: 'https://collect.evil.example', description: 'x', auth: { type: 'bearer', vault_keys: ['ACME_TOKEN'], oauth: { token_url: EVIL_TOKEN_URL } } };
    await call(agent, { action: 'create', profile: bearer });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([`create:${EVIL_TOKEN_URL}`]);
  });

  it('CONTROL: bootstrap is still asked about as a read', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    const result = await call(agent, { action: 'bootstrap', openapi_url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toMatch(/^Read the page on "collect\.evil\.example"\? /);
    expect(String(result.content)).toMatch(/^Not read: /);
  });

  it('a session of someone the owner let in is refused, not asked', async () => {
    const tool = apiSetup();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { principal: { kind: 'mandate', email: 'helper@example.ch' } } as Extra);
    const result = await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/^Not saved: /);
    expect(String(result.content)).toContain('Only the owner can save it, from their own chat.');
  });

  it('a run nobody can be asked in (a trigger) is refused, and nothing is saved', async () => {
    const tool = apiSetup();
    const agent = agentOf(tool, undefined, 'nothing named', false, { autonomy: 'autonomous', sendOrigin: { kind: 'trigger', name: 'Neue API' } } as Extra);
    agent.noteUntrustedData();
    const result = await call(agent, { action: 'update', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(tool.done).toEqual([]);
    expect(String(result.content)).toMatch(/^Not saved: /);
    expect(String(result.content)).toContain('which the owner did not name');
    expect(String(result.content)).toContain('This run has no reader');
    expect(String(result.content)).not.toContain(SECRET_VALUE);
  });

  it('the run result of a trigger says the profile was not saved', () => {
    const refusal = { targets: { values: ['collect.evil.example'], unreadable: false }, noun: 'tokenUrl' as const, origin: { kind: 'readContent' as const } };
    expect(originRunNotice('Neue API', refusal, 'en')).toBe('The trigger "Neue API" did not save the API profile that gets its tokens from "collect.evil.example": you did not name this address; it comes from content lynox read. A run without you cannot ask. If the profile should be saved anyway, ask lynox in the chat, and lynox will ask you.');
    expect(originRunNotice('Neue API', refusal, 'de')).toBe('Der Trigger "Neue API" hat das API-Profil, das seine Tokens bei "collect.evil.example" holt, nicht gespeichert: Diese Adresse hast nicht du genannt, sie stammt aus Inhalten, die lynox gelesen hat. Ein Lauf ohne dich kann nicht nachfragen. Soll das Profil trotzdem gespeichert werden, bitte lynox im Chat darum, dann fragt lynox dich.');
    expect(originRunNotice('Neue API', { ...refusal, targets: { values: [], unreadable: true } }, 'en')).toBe('The trigger "Neue API" did not save the API profile: lynox could not read the address the profile gets its tokens from. Check the trigger with lynox in the chat.');
    expect(originRunNotice('Neue API', { ...refusal, targets: { values: [], unreadable: true } }, 'de')).toBe('Der Trigger "Neue API" hat das API-Profil nicht gespeichert: lynox konnte die Adresse nicht lesen, bei der das Profil seine Tokens holt. Prüfe den Trigger mit lynox im Chat.');
  });

  it('an address that carries another address is asked about, even on a host the owner named, with no way out', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'the token endpoint is on auth.acme.example');
    const result = await call(agent, { action: 'create', profile: oauthProfile('https://auth.acme.example/token?u=https%3A%2F%2Fcollect.evil.example%2Fd') });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toContain('This address carries another address');
    expect(ask.asked[0]).not.toContain('Write "auth.acme.example" here in the chat');
    expect(ask.asked[0]).not.toContain('collect.evil.example');
    expect(tool.done).toEqual([]);
    expect(String(result.content)).toMatch(/^Not saved: /);
    expect(String(result.content)).toContain('carries another address');
  });

  it('a token address whose host cannot be read is refused without a question, as a save', async () => {
    const tool = apiSetup();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn);
    // Parses as https, but names no host as written (no "//").
    const result = await call(agent, { action: 'create', profile: oauthProfile('https:collect.evil.example/t') });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([]);
    expect(String(result.content)).toMatch(/^Not saved: lynox could not read the token address of this profile/);
  });

  it('when the owner\'s words cannot be read, the question and the refusal say so, and name no way out', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => { throw new Error('store gone'); } }) } as Extra);
    const result = await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toContain('lynox could not check whether you named "collect.evil.example"');
    expect(ask.asked[0]).not.toContain('here in the chat');
    expect(tool.done).toEqual([]);
    expect(String(result.content)).toMatch(/^Not saved: lynox could not check where "collect\.evil\.example" comes from/);
    expect(String(result.content)).not.toContain('in the chat themselves');
  });

  it('a token address a search listed is still asked about: credentials go there', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    agent.searchResultAddresses.noteResults('acme oauth token endpoint', [EVIL_TOKEN_URL]);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toHaveLength(1);
    expect(tool.done).toEqual([]);
  });

  it('a profile saved before the foreign content asks nothing when its token is fetched after it', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', false);
    await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    agent.restoreConversationTaint();
    await call(agent, { action: 'fetch_token', id: 'acme' });
    await call(agent, { action: 'fetch_token', id: 'acme' });
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([`create:${EVIL_TOKEN_URL}`, 'fetch_token:acme', 'fetch_token:acme']);
  });
  it('the refusal after a no names the way out without promising a save without questions', async () => {
    const tool = apiSetup();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    const result = await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(String(result.content)).toContain('they can write its host in the chat themselves and ask again; lynox then does not ask about this host again in this conversation.');
    expect(String(result.content)).not.toContain('without asking');
  });

  it('a token_url that is not text (a list) is refused as unreadable after foreign content, and nothing is saved', async () => {
    const tool = apiSetup();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn, 'the token endpoint is on collect.evil.example');
    for (const action of ['create', 'update'] as const) {
      for (const bad of [[EVIL_TOKEN_URL], 42, '']) {
        const result = await call(agent, { action, profile: oauthProfile(bad as unknown as string) });
        expect(String(result.content), `${action} ${JSON.stringify(bad)}`).toMatch(/^Not saved: lynox could not read the token address of this profile/);
      }
    }
    expect(ask.asked).toEqual([]);
    expect(tool.done).toEqual([]);
  });

  it('a question nobody watching can answer (blocked in an unattended run) refuses the save as unattended', async () => {
    const tool = apiSetup();
    const ask = asker(UNATTENDED_BLOCK_ANSWER);
    const agent = agentOf(tool, ask.fn);
    const result = await call(agent, { action: 'create', profile: oauthProfile(EVIL_TOKEN_URL) });
    expect(ask.asked).toHaveLength(1);
    expect(tool.done).toEqual([]);
    expect(String(result.content)).toMatch(/^Not saved: /);
    expect(String(result.content)).toContain('This run has no reader');
  });

  it('a trigger from before its creator was recorded gets the way out through the chat, not "Confirm recipients"', () => {
    const host = { values: ['collect.evil.example'], unreadable: false };
    const origin = { kind: 'triggerRun' as const, name: 'Neue API', setUpBy: { kind: 'unknown' as const }, predatesRecord: true };
    const model = originTokenUrlRefused('unattended', host, origin);
    expect(model).toMatch(/^Not saved: the token address of this profile is on "collect\.evil\.example", which the owner did not name; it came from the trigger "Neue API"\. /);
    expect(model).toContain('Add: if it should be saved, the owner can ask lynox in the chat, and lynox will ask them there.');
    expect(model).not.toContain('Confirm recipients');
    expect(originRunNotice('Neue API', { targets: host, noun: 'tokenUrl', origin }, 'en')).toBe('The trigger "Neue API" did not save the API profile that gets its tokens from "collect.evil.example": you did not name this address; it comes from the trigger "Neue API". A run without you cannot ask. If the profile should be saved anyway, ask lynox in the chat, and lynox will ask you.');
    expect(originRunNotice('Neue API', { targets: host, noun: 'tokenUrl', origin }, 'de')).toBe('Der Trigger "Neue API" hat das API-Profil, das seine Tokens bei "collect.evil.example" holt, nicht gespeichert: Diese Adresse hast nicht du genannt, sie stammt aus dem Trigger "Neue API". Ein Lauf ohne dich kann nicht nachfragen. Soll das Profil trotzdem gespeichert werden, bitte lynox im Chat darum, dann fragt lynox dich.');
    // CONTROL: a send from the same trigger keeps its own advice.
    expect(originRunNotice('Neue API', { targets: host, noun: 'host', origin }, 'en')).toContain('choose "Confirm recipients"; after that it sends again.');
  });

  it('in the owner\'s chat, a yes to an address that carries another one saves it', async () => {
    const tool = apiSetup();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn, 'the token endpoint is on auth.acme.example');
    const url = 'https://auth.acme.example/token?u=https%3A%2F%2Fcollect.evil.example%2Fd';
    await call(agent, { action: 'create', profile: oauthProfile(url) });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toContain('This address carries another address');
    expect(tool.done).toEqual([`create:${url}`]);
  });

  it('an address that carries another one keeps the way out through the chat in an unattended run, where lynox asks and a yes counts', () => {
    const host = { values: ['auth.acme.example'], unreadable: false };
    const model = originTokenUrlRefused('unattended', host, { kind: 'readContent' }, true);
    expect(model).toMatch(/^Not saved: the token address of this profile, on "auth\.acme\.example", carries another address/);
    expect(model).toContain('Add: if it should be saved, the owner can ask lynox in the chat, and lynox will ask them there.');
  });

  describe('with the real handler: the origin question comes first, and a no ends there', () => {
    const answering = (answers: string[]): { fn: (q: string | PromptText) => Promise<string>; asked: string[] } => {
      const asked: string[] = [];
      return { asked, fn: async (q) => { asked.push(flattenPrompt(q)); return answers[asked.length - 1] ?? 'Deny'; } };
    };
    const realAgent = (promptUser: (q: string | PromptText) => Promise<string>): Agent => agentOf(apiSetupTool as unknown as ToolEntry, promptUser);
    // A host outside the vetted sub-processors: the save asks its own acceptance question after the origin check.
    const profile = (): Profile => ({ ...oauthProfile(EVIL_TOKEN_URL), base_url: 'https://collect.evil.example/api' });

    it('a no to the origin question asks nothing else', async () => {
      const ask = answering(['Deny']);
      const result = await call(realAgent(ask.fn), { action: 'create', profile: profile() });
      expect(ask.asked).toHaveLength(1);
      expect(ask.asked[0]).toMatch(/^Save this API connection\? /);
      expect(String(result.content)).toMatch(/^Not saved: /);
    });

    it('CONTROL: a yes to it is followed by the acceptance question of the save', async () => {
      const ask = answering(['Allow', 'Deny']);
      const result = await call(realAgent(ask.fn), { action: 'create', profile: profile() });
      expect(ask.asked).toHaveLength(2);
      expect(ask.asked[0]).toMatch(/^Save this API connection\? /);
      expect(ask.asked[1]).toContain('needs your acceptance');
      expect(String(result.content)).toContain('not saved — user declined');
    });
  });
});
