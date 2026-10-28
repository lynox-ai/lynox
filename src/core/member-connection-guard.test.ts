import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The tokens of a connection a member made with their own login reach that member only, and the
// place that decides it is the view a profile reads the vault through (`secretsForProfile`), the
// `secret:` gate and the attach. What goes AROUND them is what this guard counts: a raw read of
// the vault, a masked or fingerprinted value, and an attach that fixes its reader to the owner.
// Each such site is pinned with why it may stand; a new one fails here until it says so. The
// list is of bypasses, not of uses of the view, so a site that forgets the view is the one that
// shows up. Its limits, stated: a call split across lines, a receiver outside the word list,
// and a read that uses the view but asks it about the wrong profile are not seen here; the
// last is why the view decides by the profile that HOLDS a name (`heldFromReader`).

const SRC = join(__dirname, '..');

const BYPASS: readonly RegExp[] = [
  /\b(secretStore|store|vault|secrets|inner|target)\??!?\.resolve\(/,
  /getMasked\(/,
  /\.fingerprint\(/,
  /\bvault\??\.get\(/,
  /principal: OWNER_PRINCIPAL/,
  /resolveSecretRefs\(/,
  /\.getAll\(\)/,
  /getSecretStore\(\)\??\.resolve\(/,
];

/** `file|line text` → why it may stand. Keyed by text, not line number, so an edit elsewhere in the file keeps it. */
const PINNED: Readonly<Record<string, string>> = {
  // The view itself and the stores it wraps.
  'core/profile-secret-view.ts|return (name: string): string | null => (hidden(name) ? null : target.resolve(name));': 'the view: resolves only what hiddenFromProfile lets through',
  'core/secret-scope.ts|return { resolve: (name) => (slots.has(name) ? inner.resolve(name) : null) };': 'a scope over a store: narrows, never widens',
  "core/secret-scope.ts|resolve: (name) => (permits(name, 'resolve') ? inner.resolve(name) : null),": 'a scope over a store: narrows, never widens',
  "core/secret-scope.ts|getMasked: (name) => (permits(name, 'getMasked') ? inner.getMasked(name) : null),": 'a scope over a store: narrows, never widens',
  'core/secret-store.ts|getMasked(name: string): string | null {': 'the definition',
  'types/security.ts|getMasked(name: string): string | null;': 'the declaration',
  // Reads through the view: `secretStore` here is `secretsForProfile(...)` (http.ts attach).
  'tools/builtin/http.ts|const current = secretStore.resolve(refreshKey);': 'view; revoked-grant compare, not sent',
  'tools/builtin/http.ts|const stored = secretStore.resolve(refreshSlot);': 'view; renewal input',
  'tools/builtin/http.ts|const resolved = secretStore.resolve(tokenKey);': 'view; the attach, behind the member refusal',
  'tools/builtin/http.ts|const user = secretStore.resolve(userKey);': 'view; basic auth, no token slot',
  'tools/builtin/http.ts|const pass = secretStore.resolve(passKey);': 'view; basic auth, no token slot',
  'tools/builtin/http.ts|const token = secretStore.resolve(tokenKey);': 'view; a profile\'s own key',
  'tools/builtin/http.ts|: a.secretStore.resolve(key)': 'view; existence answer for a model-owned key',
  'tools/builtin/http.ts|return { inputs: oauthRenewalInputs(profile, stores.secretStore.resolve(slot)), ms };': 'hashed into a hold key after a renewal that went through; not sent',
  // Existence and fingerprint compares: the value decides a boolean, it is not sent or shown.
  'tools/builtin/api-setup.ts|if (store.resolve(name) !== null) left.push(name);': 'existence after delete, before a save',
  'core/api-store.ts|return secretStore?.resolve(k) ?? null;': 'delete purge: fingerprint compare',
  'core/api-store.ts|value = secretStore?.resolve(w.name) ?? null;': 'delete refusal: fingerprint compare',
  'core/engine.ts|read: (name, hash) => fingerprintStore.fingerprint(name, hash),': 'boot grant backfill: a digest into the grant record',
  // Fixed names that are no API profile's token slot.
  "core/engine.ts|?? this.secretStore?.resolve('GCP_PROJECT_ID')": 'fixed engine name',
  "core/engine.ts|const mistralApiKey = this.secretStore?.resolve('LYNOX_INBOX_MISTRAL_API_KEY')": 'fixed engine name',
  "core/engine.ts|?? this.secretStore?.resolve('MISTRAL_API_KEY')": 'fixed engine name',
  "core/engine-init.ts|const vaultApiKey = vault.get('ANTHROPIC_API_KEY');": 'fixed engine name',
  "core/engine-init.ts|const mistralKey = vault.get('MISTRAL_API_KEY');": 'fixed engine name',
  'core/llm/provider-keys.ts|const primaryVault = secretStore?.resolve(slot);': 'LLM provider key slots',
  'core/llm/provider-keys.ts|const altVault = secretStore?.resolve(altSlot);': 'LLM provider key slots',
  'core/llm/provider-keys.ts|if (secretStore.resolve(slot)) return null;   // already has its own key': 'LLM provider key slots',
  'core/llm/provider-keys.ts|const value = (fromEnv && fromEnv.length > 0) ? fromEnv : secretStore.resolve(legacy);': 'LLM provider key slots',
  'tools/builtin/calendar.ts|const url = store.resolve(`${CALENDAR_FEED_PREFIX}${label}`);': 'calendar feed names',
  'core/google-client-pair.ts|const vaultId = vault?.get(idName);': 'the Google client pair',
  'core/google-client-pair.ts|const vaultSecret = vault?.get(secretName);': 'the Google client pair',
  'integrations/google/google-auth.ts|const encrypted = vault.get(VAULT_TOKEN_KEY);': 'the Google integration\'s own token, no API profile',
  'integrations/microsoft/microsoft-auth.ts|const raw = this.vault?.get(MICROSOFT_OAUTH_TOKENS_KEY) ?? null;': 'the Microsoft integration\'s own token, no API profile',
  'server/http-api.ts|client_id: secrets.resolve(keys.id),': 'a preset client id, public',
  'server/http-api.ts|const priorId = secrets.resolve(keys.id);': 'a preset client id, public',
  // Names with the last characters of a value: the briefing and ask_secret's list.
  'core/engine-init.ts|const names = visibleNames.map(n => `secret:${n} (${store!.getMasked(n)})`).join(\', \');': 'masked listing; reviewed separately',
  "tools/builtin/ask-secret.ts|const listing = names.map(n => `${n} (${store!.getMasked(n) ?? '****'})`).join(', ');": 'masked listing; reviewed separately',
  // Migration between instances: an admin route, refused to a mandate.
  'core/migration-import.ts|const value = vault.get(w.name);': 'admin migration restore',
  "server/http-api.ts|? { principal: OWNER_PRINCIPAL, actorKind: 'cp-migration' as const }": 'audit actor of a migration, no attach',
  "core/engine.ts|principal: OWNER_PRINCIPAL, action: 'connection.erasure.run-history',": 'audit actor of the connection erasure sweep, no attach',
  "core/plan-takeover.ts|principal: OWNER_PRINCIPAL, action: 'plan.takeover', phase: 'done', correlationId: newCorrelationId(),": 'audit actor of the owner\'s takeover of a paused plan, no attach',
  'core/migration-export.ts|const allSecrets = vault.getAll();': 'admin migration export, refused to a mandate before dispatch',
  'core/secret-vault.ts|const entries = oldVault.getAll();': 'vault re-key',
  'core/secret-store.ts|const entries = this.vault.getAll();': 'the store\'s own load',
  'core/secret-store.ts|resolveSecretRefs(input: unknown): unknown {': 'the definition',
  'types/security.ts|resolveSecretRefs(input: unknown): unknown;': 'the declaration',
  'core/profile-secret-view.ts|target.extractSecretNames(input).some(hidden) ? input : target.resolveSecretRefs(input);': 'the view',
  'core/agent.ts|const resolved = this.secretStore!.resolveSecretRefs({ url: rawUrl }) as { url?: unknown };': 'host probe of a secret: reference, compared, not sent',
  'core/agent.ts|processedInput = this.secretStore!.resolveSecretRefs(tc.input);': 'tool input after the secret: gate above it in the same call',
  'tools/builtin/api-setup.ts|const probed = store.resolveSecretRefs(probe) as { _: string };': 'existence probe, boolean only',
  'tools/builtin/api-setup.ts|const probed = secretStore.resolveSecretRefs(probe) as { _: string };': 'view; existence probe in fetch_token',
  'tools/builtin/api-setup.ts|const profiles = apiStore.getAll();': 'profiles, no values',
  'tools/builtin/api-setup.ts|const ids = apiStore.getAll().filter((p) => connectionWaits(p, ends)).map((p) => p.id);': 'profile ids, no values',
  'core/transcribe/session-context.ts|return store.getAll().map((p) => p.name).filter((n) => n.length > 0);': 'profile names, no values',
  'integrations/push/web-push-channel.ts|for (const row of this.store.getAll()) {': 'push subscriptions, not the vault',
  'server/http-api.ts|jsonResponse(res, 200, { profiles: store.getAll().map((p) => profileForReader(p, reader)), importWaiting: store.importWaitsOn() });': 'profiles as the reader may see them: no fingerprints, no account of another person\'s connection',
  'server/http-api.ts|secret: (name) => this.engine?.getSecretStore()?.resolve(name) ?? null,': 'webhook signature secret named by its connection row; compared, not sent',
};

/** Owner-fixed attaches, each pinned by how its line starts (the line is long); each meets the member refusal. */
const OWNER_ATTACHES: ReadonlyArray<{ file: string; starts: string; why: string }> = [
  { file: 'core/worker-loop.ts', starts: 'const profile = await attachStoredCredential(url, headers, isWriteMethod(method), { apiStore, secretStore, principal: OWNER_PRINCIPAL,', why: 'bulk run attach: refused with the member\'s line, not sent' },
  { file: 'server/http-api.ts', starts: 'if (!apiStore || !secretStore || !(await attachStoredCredential(key, {}, /* the run\'s first writing key: a write */ true, { apiStore, secretStore, principal: OWNER_PRINCIPAL,', why: 'bulk reach probe: refused with the member\'s line, not sent' },
];

function sourceFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.set(relative(SRC, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/** Every bypass-shaped site that no pin covers, as `file:line: text`. */
function unpinned(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    text.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
      if (!BYPASS.some((re) => re.test(line))) return;
      if (PINNED[`${file}|${line}`] !== undefined) return;
      if (OWNER_ATTACHES.some((a) => a.file === file && line.startsWith(a.starts))) return;
      found.push(`${file}:${i + 1}: ${line}`);
    });
  }
  return found;
}

describe('bypasses of the member-connection view', () => {
  const files = sourceFiles(SRC);

  it('every raw vault read, masked or fingerprinted value and owner-fixed attach is pinned with its reason', () => {
    expect(unpinned(files)).toEqual([]);
  });

  it('every pin still names a site, so the list does not keep reasons for code that is gone', () => {
    const lines = new Set<string>();
    for (const [file, text] of files) for (const raw of text.split('\n')) lines.add(`${file}|${raw.trim()}`);
    expect(Object.keys(PINNED).filter((k) => !lines.has(k))).toEqual([]);
    for (const a of OWNER_ATTACHES) expect(files.get(a.file)!.split('\n').filter((l) => l.trim().startsWith(a.starts))).toHaveLength(1);
  });

  it('mutant: a raw read of a token slot added to the worker is caught', () => {
    const mutated = new Map(files);
    mutated.set('core/worker-loop.ts', `${files.get('core/worker-loop.ts')!}\nconst leaked = secretStore.resolve(accessTokenKey(profile.id));\n`);
    expect(unpinned(mutated)).toEqual([expect.stringContaining('core/worker-loop.ts:')]);
  });

  it('mutant: a second owner-fixed attach in a pinned file is caught', () => {
    const mutated = new Map(files);
    mutated.set('core/worker-loop.ts', `${files.get('core/worker-loop.ts')!}\nawait attachStoredCredential(u, h, true, { apiStore, secretStore, principal: OWNER_PRINCIPAL });\n`);
    expect(unpinned(mutated)).toEqual([expect.stringContaining('core/worker-loop.ts:')]);
  });

  it('mutant: an owner-fixed attach in another file is caught', () => {
    const mutated = new Map(files);
    mutated.set('core/pipeline-step.ts', 'await attachStoredCredential(url, headers, true, { apiStore, secretStore, principal: OWNER_PRINCIPAL });\n');
    expect(unpinned(mutated)).toEqual([expect.stringContaining('core/pipeline-step.ts:1:')]);
  });
});

// A7: who a profile's author is decides whose its connection may be (`memberConnectionReader`
// 'write'), so every save of a profile is counted with what it does to `created_by`, and each
// place that removes it carries the check that keeps it off a member's live connection.
const PROFILE_SAVES: Readonly<Record<string, string>> = {
  'tools/builtin/api-setup.ts|return apiStore.save(next, apisDir, { exchange, actor }).ok ? \'saved\' : \'not-saved\';': 'grant persist: spreads the stored profile, author kept',
  'tools/builtin/api-setup.ts|const mergedSave = w.run(\'save\', () => apiStore.save(merged, apisDir), ifOk);': 'refine: applyRefine keeps the author',
  'tools/builtin/api-setup.ts|const saved = w.run(\'save\', () => apiStore.save(profile, apisDir), ifOk);': 'create/update: author removed behind the owner-save check',
  'tools/builtin/api-setup.ts|const saved = apiStore.save(next, apisDir);': 'adopt_connection: author removed once the connection waits',
  'server/http-api.ts|const saved = apiStore.save(': 'connect callback: spreads the stored profile, author kept',
};
/** Each removal of the author, with what must stand in the lines before it. */
const AUTHOR_REMOVALS: ReadonlyArray<{ file: string; line: string; check: RegExp }> = [
  { file: 'tools/builtin/api-setup.ts', line: 'delete profile.created_by;', check: /isMandateConnection\(storedForSave\)\s*&& !connectionWaits\(/ },
  { file: 'tools/builtin/api-setup.ts', line: 'delete next.created_by;', check: /if \(!connectionWaits\(current, ends\)\)/ },
];

function profileSaves(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/\bapiStore\??\.save\(/.test(line) && !line.startsWith('//') && !line.startsWith('*')) found.push(`${file}|${line}`);
  }
  return found;
}

function authorRemovals(files: ReadonlyMap<string, string>): Array<{ at: string; checked: boolean }> {
  const out: Array<{ at: string; checked: boolean }> = [];
  for (const [file, text] of files) {
    const lines = text.split('\n');
    lines.forEach((raw, i) => {
      if (!/^delete \w+\.created_by;/.test(raw.trim())) return;
      const pin = AUTHOR_REMOVALS.find((r) => r.file === file && r.line === raw.trim());
      const before = lines.slice(Math.max(0, i - 15), i).join('\n');
      out.push({ at: `${file}:${i + 1}`, checked: pin !== undefined && pin.check.test(before) });
    });
  }
  return out;
}

describe('saves that change a profile\'s author (A7)', () => {
  const files = sourceFiles(SRC);

  it('every save of a profile is counted with what it does to the author', () => {
    expect(profileSaves(files).sort()).toEqual(Object.keys(PROFILE_SAVES).sort());
  });

  it('each removal of the author stands behind its check', () => {
    const found = authorRemovals(files);
    expect(found).toHaveLength(AUTHOR_REMOVALS.length);
    expect(found.filter((r) => !r.checked)).toEqual([]);
  });

  it('mutant: the owner-save check taken out leaves its removal unchecked', () => {
    const mutated = new Map(files);
    mutated.set('tools/builtin/api-setup.ts', files.get('tools/builtin/api-setup.ts')!.replace('isMandateConnection(storedForSave)', 'false'));
    expect(authorRemovals(mutated).filter((r) => !r.checked)).toHaveLength(1);
  });

  it('mutant: a new removal elsewhere is caught', () => {
    const mutated = new Map(files);
    mutated.set('server/http-api.ts', `${files.get('server/http-api.ts')!}\n    delete fresh.created_by;\n`);
    expect(authorRemovals(mutated).filter((r) => !r.checked)).toHaveLength(1);
  });
});
