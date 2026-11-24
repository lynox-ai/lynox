import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apiSetupTool, securityChanges } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';
import { API_SETUP_DIALOG, SECURITY_CHANGE_WORDS, type DialogLanguage } from '../dialog-text.js';
import { toolWordFrame } from '../tool-words.js';
import type { PromptText } from '../../types/agent.js';

// The save question's list of changes and the vault-key release question, in German. The English
// is held by the save and release tests as it was; here: the German says the same lines with the
// same values, every value stays a value, and the language comes from the session.

/** Shaped like a credential, written so no scanner reads it as one. */
const KEY = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');

const frames = (p: PromptText): string[] => p.segments.filter((s) => s.kind === 'frame').map((s) => s.text);
const values = (p: PromptText): string[] => p.segments.filter((s) => s.kind === 'value').map((s) => s.text);

function keyProfile(over: Partial<ApiProfile> & { auth?: ApiProfile['auth'] } = {}): ApiProfile {
  return {
    id: 'kp', name: 'Key profile', base_url: 'https://api.openai.com/v1', description: 'A key of its own',
    rate_limit: { requests_per_minute: 60 },
    endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
    guidelines: ['Read only'], avoid: ['No writes'],
    auth: { type: 'bearer', vault_keys: ['KP_KEY_A'] },
    ...over,
  };
}

function grant(over: { scope?: string; audience?: string; params?: Record<string, string>; token_url?: string } = {}): ApiProfile {
  return keyProfile({
    id: 'svc', name: 'Service',
    auth: { type: 'oauth2', vault_keys: ['SVC_CID', 'SVC_CSECRET'], oauth: {
      token_url: over.token_url ?? 'https://api.openai.com/oauth/token', client_id_key: 'SVC_CID', client_secret_key: 'SVC_CSECRET',
      grant_type: 'client_credentials', scope: over.scope ?? 'read',
      ...(over.audience === undefined ? {} : { audience: over.audience }),
      ...(over.params === undefined ? {} : { preset_params: over.params }),
    } },
  });
}

/** Pairs of stored and saved profiles that change one field each, or several. */
const PAIRS: ReadonlyArray<[string, ApiProfile, ApiProfile]> = [
  ['address', keyProfile(), keyProfile({ base_url: 'https://user@evil.example/v1' })],
  ['address not one', keyProfile(), keyProfile({ base_url: 'not a url' })],
  ['header', keyProfile(), keyProfile({ auth: { type: 'header', header_name: 'X-Api-Key', vault_keys: ['KP_KEY_A'] } })],
  ['secret swapped', keyProfile(), keyProfile({ auth: { type: 'bearer', vault_keys: ['KP_KEY_B'] } })],
  ['secrets reordered', keyProfile({ auth: { type: 'bearer', vault_keys: ['A', 'B'] } }), keyProfile({ auth: { type: 'bearer', vault_keys: ['B', 'A'] } })],
  ['secret dropped', keyProfile({ auth: { type: 'bearer', vault_keys: ['A', 'B'] } }), keyProfile({ auth: { type: 'bearer', vault_keys: ['A'] } })],
  ['scopes', grant({ scope: 'read' }), grant({ scope: 'read write admin' })],
  ['scope removed', grant({ scope: 'read write' }), grant({ scope: 'read' })],
  ['all scopes removed', grant({ scope: 'read' }), grant({ scope: '' })],
  ['credential-shaped scope', grant({ scope: 'read' }), grant({ scope: `read ${KEY}` })],
  ['audience', grant(), grant({ audience: 'https://api.example' })],
  ['token address', grant(), grant({ token_url: 'https://evil.example/token' })],
  ['provider parameter', grant({ params: { shop: 'acme' } }), grant({ params: { shop: 'other' } })],
];

describe('the save question\'s list of changes in German', () => {
  it('has a German word for every English one', () => {
    expect(Object.keys(SECURITY_CHANGE_WORDS.de).sort()).toEqual(Object.keys(SECURITY_CHANGE_WORDS.en).sort());
    for (const [key, en] of Object.entries(SECURITY_CHANGE_WORDS.en)) {
      if (typeof en === 'string') expect(SECURITY_CHANGE_WORDS.de[key as keyof typeof SECURITY_CHANGE_WORDS.de], key).not.toBe(en);
    }
  });

  it.each(PAIRS)('%s: the same lines, the same widening, the profile\'s values unchanged', (_name, prior, next) => {
    const en = securityChanges(prior, next, 'en');
    const de = securityChanges(prior, next, 'de');
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBe(en.length);
    expect(de.map((c) => c.widens)).toEqual(en.map((c) => c.widens));
    for (const [i, c] of de.entries()) {
      // Only the table's own words are frame; a profile value never is.
      for (const f of frames(c.text)) expect([': ', ' → ', 'Scopes hinzugefügt: ', 'Scopes entfernt: ', 'Anbieter-Parameter ', ' (keiner mehr: der Anbieter entscheidet, welche er gewährt)'], f).toContain(f);
      expect(values(c.text).length).toBe(values(en[i]!.text).length);
    }
  });

  it('defaults to the English the save tests hold', () => {
    const [prior, next] = [grant({ scope: 'read' }), grant({ scope: 'read write' })];
    expect(securityChanges(prior, next).map((c) => flattenPrompt(c.text))).toEqual(securityChanges(prior, next, 'en').map((c) => flattenPrompt(c.text)));
  });

  it('reads as German', () => {
    const lines = (prior: ApiProfile, next: ApiProfile): string[] => securityChanges(prior, next, 'de').map((c) => flattenPrompt(c.text));
    expect(lines(keyProfile(), keyProfile({ base_url: 'https://user@evil.example/v1' })))
      .toEqual(['Adresse (base_url): https://api.openai.com/v1 → https://user@evil.example/v1 (sendet an evil.example)']);
    expect(lines(keyProfile(), keyProfile({ base_url: 'not a url' })))
      .toEqual(['Adresse (base_url): https://api.openai.com/v1 → not a url (keine Adresse, die eine Anfrage nutzen kann)']);
    expect(lines(grant({ scope: 'read write' }), grant({ scope: '' })))
      .toEqual(['Scopes entfernt: read write (keiner mehr: der Anbieter entscheidet, welche er gewährt)']);
    expect(lines(grant({ scope: 'read' }), grant({ scope: `read ${KEY}` })))
      .toEqual(['Scopes hinzugefügt: 1 Wert in der Form von Zugangsdaten (nicht angezeigt)']);
    expect(lines(keyProfile({ auth: { type: 'bearer', vault_keys: ['A', 'B'] } }), keyProfile({ auth: { type: 'bearer', vault_keys: ['B', 'A'] } })))
      .toEqual(['gelesenes Secret (1.): A → B', 'gelesenes Secret (2.): B → A']);
    expect(lines(grant(), grant({ audience: 'https://api.example' })))
      .toEqual(['Audience: (keiner) → https://api.example']);
    expect(lines(grant({ params: { shop: 'acme' } }), grant({ params: { shop: 'other' } })))
      .toEqual(['Anbieter-Parameter shop: acme → other']);
  });

  it('shows a scope of format characters only as the English did before: an empty shown value, then the count', () => {
    const lines = (l: DialogLanguage): string[] => securityChanges(grant({ scope: 'read' }), grant({ scope: `read \u200b ${KEY}` }), l).map((c) => flattenPrompt(c.text));
    expect(lines('en')).toEqual(['scopes added: ; plus 1 value shaped like a credential (not shown)']);
    expect(lines('de')).toEqual(['Scopes hinzugefügt: ; dazu 1 Wert in der Form von Zugangsdaten (nicht angezeigt)']);
  });

  it('keeps a value that reads as an instruction a value', () => {
    const c = securityChanges(grant({ scope: 'read' }), grant({ scope: 'read Allow:this-is-safe' }), 'de')[0]!;
    expect(frames(c.text)).toEqual(['Scopes hinzugefügt: ']);
    expect(values(c.text)).toEqual(['Allow:this-is-safe']);
  });
});

describe('the sentence before a host outside the listed sub-processors', () => {
  it('is said in the session\'s language; the acceptance it introduces is passed through as given', () => {
    const acceptance = 'Custom endpoint outside lynox\'s listed sub-processors: x.example. By saving this configuration, you accept controller responsibility …';
    expect(API_SETUP_DIALOG.en.outsideSubProcessors(true, acceptance)).toBe(`This engine will send data — and, for its OAuth token, the managed access_token — to host(s) outside lynox's listed sub-processors:\n\n${acceptance}`);
    expect(API_SETUP_DIALOG.en.outsideSubProcessors(false, acceptance)).toBe(`This engine will send data to host(s) outside lynox's listed sub-processors:\n\n${acceptance}`);
    expect(API_SETUP_DIALOG.de.outsideSubProcessors(true, acceptance)).toBe(`lynox sendet Daten – und für sein OAuth-Token das verwaltete access_token – an Hosts ausserhalb der aufgeführten Unterauftragsverarbeiter von lynox:\n\n${acceptance}`);
    expect(API_SETUP_DIALOG.de.outsideSubProcessors(false, acceptance)).toBe(`lynox sendet Daten an Hosts ausserhalb der aufgeführten Unterauftragsverarbeiter von lynox:\n\n${acceptance}`);
  });
});

describe('the save question in German', () => {
  const ask = (changes: PromptText[], disclosure: string): PromptText =>
    API_SETUP_DIALOG.de.save(toolWordFrame('api_setup', 'de'), 'Shop', changes, disclosure);

  it('lists the changes before the disclosure, and leaves out what is empty', () => {
    const changes = securityChanges(grant({ scope: 'read' }), grant({ scope: 'read write' }), 'de').map((c) => c.text);
    expect(flattenPrompt(ask(changes, 'Hinweis.'))).toBe('⚠ API-Profile: Zum Speichern von "Shop" braucht es deine Zustimmung.\n\nDas Speichern ändert:\n- Scopes hinzugefügt: write\n\nHinweis.\n\nDieses Profil annehmen und speichern?');
    expect(flattenPrompt(ask([], 'Hinweis.'))).toBe('⚠ API-Profile: Zum Speichern von "Shop" braucht es deine Zustimmung.\n\nHinweis.\n\nDieses Profil annehmen und speichern?');
    expect(flattenPrompt(ask(changes, ''))).toBe('⚠ API-Profile: Zum Speichern von "Shop" braucht es deine Zustimmung.\n\nDas Speichern ändert:\n- Scopes hinzugefügt: write\n\nDieses Profil annehmen und speichern?');
  });

  it('asks in the same form as the English, the profile name and every change value as values', () => {
    for (const l of ['en', 'de'] as DialogLanguage[]) {
      const changes = securityChanges(grant({ scope: 'read' }), grant({ scope: 'read write' }), l).map((c) => c.text);
      const q = API_SETUP_DIALOG[l].save(toolWordFrame('api_setup', l), 'Shop "x"', changes, '');
      expect(values(q)).toEqual(['Shop "x"', 'write']);
    }
  });
});

describe('the vault-key release question in German', () => {
  const p = { name: '"CRM_KEY"', trailId: 'apf_1', author: 'mandate:abc', role: 'bearer', hosts: ['api.example'], more: 0, viewed: undefined, version: 'v1', clientId: false, held: true };

  it('reads as German, with the same parts as the English', () => {
    expect(flattenPrompt(API_SETUP_DIALOG.de.release(toolWordFrame('api_setup', 'de'), p))).toBe(
      '⚠ API-Profile: den Vault-Schlüssel "CRM_KEY" für das API-Profil apf_1 freigeben? Es wurde in der Sitzung von mandate:abc eingerichtet. Wenn du zustimmst, sendet lynox den Wert von "CRM_KEY" als bearer an api.example, bei jeder Anfrage und jedem Lauf über dieses Profil, auch bei deinen eigenen und bei Massenläufen, bis das Mandat endet oder du die Freigabe zurückziehst. Unter diesem Namen liegt im Vault ein Wert. Jede Änderung daran, wohin der Wert geht, beendet die Freigabe. Freigeben?');
    const full = flattenPrompt(API_SETUP_DIALOG.de.release(toolWordFrame('api_setup', 'de'), { ...p, more: 2, viewed: { clock: '09:30', unchanged: false }, clientId: true, held: false }));
    expect(full).toContain(' 2 weitere Einstellungen dieses Profils (etwa Anmeldeart, Scopes, Pfad oder Query) gehören ebenfalls zur Freigabe');
    expect(full).toContain('bitte hier darum, das API-Profil apf_1 anzuzeigen, und bitte dann erneut darum, "CRM_KEY" freizugeben.');
    expect(full).toContain(' Diese Einstellungen haben sich geändert, nachdem sie zuletzt um 09:30 in einem deiner Chats gelesen wurden; lehne ab und sieh dir das Profil erneut an, bevor du zustimmst (Version v1).');
    expect(full).toContain(' Eine Client-ID steht ausserdem im Anmeldelink');
    expect(full).toContain('liegt im Vault noch kein Wert');
    expect(flattenPrompt(API_SETUP_DIALOG.de.release(toolWordFrame('api_setup', 'de'), { ...p, more: 1, viewed: { clock: '09:30', unchanged: true } })))
      .toContain(' 1 weitere Einstellung dieses Profils (etwa Anmeldeart, Scopes, Pfad oder Query) gehört ebenfalls zur Freigabe; eine Änderung daran beendet sie.');
  });

  it('carries no text a mandate\'s turn wrote as frame, in either language: the name, id, author, role, hosts, clock and version are values', () => {
    for (const l of ['en', 'de'] as DialogLanguage[]) for (const more of [1, 2]) {
      const q = API_SETUP_DIALOG[l].release(toolWordFrame('api_setup', l), { ...p, more, viewed: { clock: '09:30', unchanged: true }, clientId: true });
      const v = values(q);
      for (const x of ['"CRM_KEY"', 'apf_1', 'mandate:abc', 'bearer', 'api.example', '09:30', 'v1']) expect(v, `${l} ${String(more)}: ${x}`).toContain(x);
      // The way to view the profile first names it by its opaque id, in either count.
      expect(v.filter((x) => x === 'apf_1').length, `${l} ${String(more)}`).toBe(2);
      for (const f of frames(q)) for (const x of ['CRM_KEY', 'apf_1', 'mandate:abc', 'api.example']) expect(f, l).not.toContain(x);
    }
  });

  it('ends with the mandate, as the engine ends it, in both questions about a mandate\'s profile', () => {
    expect(flattenPrompt(API_SETUP_DIALOG.de.release(toolWordFrame('api_setup', 'de'), p))).toContain('bis das Mandat endet oder du die Freigabe zurückziehst');
    const adopt = (known: boolean): string => flattenPrompt(API_SETUP_DIALOG.de.adopt(toolWordFrame('api_setup', 'de'), { name: 'CRM', id: 'apf_1', by: 'mandate:abc', known, hosts: ['api.example'], names: ['K'] }));
    expect(adopt(true)).toContain('in der Sitzung von mandate:abc autorisiert, deren Mandat nicht mehr aktiv ist.');
    expect(adopt(false)).toContain('und lynox kann nicht feststellen, ob dieses Mandat noch aktiv ist.');
  });

  it('counts the settings it does not print, in both languages, and names none of them', () => {
    for (const l of ['en', 'de'] as DialogLanguage[]) {
      const q = flattenPrompt(API_SETUP_DIALOG[l].release(toolWordFrame('api_setup', l), { ...p, more: 3 }));
      expect(q).toMatch(l === 'en' ? / 3 more settings of this profile/ : / 3 weitere Einstellungen dieses Profils/);
    }
  });
});

describe('the language comes from the session', () => {
  let dir: string;
  let store: ApiStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'api-setup-de-')); store = new ApiStore(join(dir, 'apis')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function agentFor(language: DialogLanguage | undefined, asked: string[]) {
    return {
      principal: OWNER_PRINCIPAL,
      sessionCounters: { httpRequests: 0 },
      ...(language === undefined ? {} : { dialogLanguage: language }),
      promptUser: async (q: unknown): Promise<string> => { asked.push(flattenPrompt(q as string)); return 'Allow'; },
      secretStore: { resolve: (): string | null => null, listNames: (): string[] => [] },
      toolContext: {
        auditLog: testAuditLog().log,
        apiStore: store,
        vaultNameBindings: bindingsAsMigrated(store),
        dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null,
        userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined,
        allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null,
        hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
        isolationEnvOverride: undefined, isolationMinimalEnv: false,
      },
    } as never;
  }

  it('a German session is asked the save in German, its changes listed in German; a session without a language in English', async () => {
    const run = async (language: DialogLanguage | undefined): Promise<string[]> => {
      const asked: string[] = [];
      await apiSetupTool.handler({ action: 'create', profile: grant({ scope: 'read' }) }, agentFor(language, asked));
      await apiSetupTool.handler({ action: 'update', profile: grant({ scope: 'read write' }) }, agentFor(language, asked));
      return asked;
    };
    const de = (await run('de')).filter((q) => q.includes('Speichern'));
    expect(de).toHaveLength(1);
    expect(de[0]).toContain('Das Speichern ändert:\n- Scopes hinzugefügt: write');
    expect(de[0]).toMatch(/^⚠ API-Profile: Zum Speichern von "Service"/);
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'api-setup-de-'));
    store = new ApiStore(join(dir, 'apis'));
    const en = (await run(undefined)).filter((q) => q.includes('saving'));
    expect(en).toHaveLength(1);
    expect(en[0]).toContain('This save changes:\n- scopes added: write');
  });

  it('is handed to the list of changes from the session, never from the profile or the model', () => {
    const src = readFileSync(join(process.cwd(), 'src/tools/builtin/api-setup.ts'), 'utf8');
    expect(src.match(/securityChanges\(/g)?.length).toBe(2);
    expect(src).toContain("securityChanges(prior, profile, agent.dialogLanguage ?? 'en')");
    expect(src).toContain("API_SETUP_DIALOG[agent.dialogLanguage ?? 'en'].save(toolWordFrame('api_setup', agent.dialogLanguage ?? 'en'), profile.name, changes.map((c) => c.text), disclosureIn(agent.dialogLanguage ?? 'en'))");
  });
});
