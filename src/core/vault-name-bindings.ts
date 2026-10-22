/**
 * Where each of the owner's vault secrets may go: a vault name, bound to the destinations the
 * owner allowed for it (`profile-secret-view.ts`, {@link credentialEndpoints}: the origin of a
 * profile's `base_url` and its whole token endpoint).
 *
 * A name that is not a token slot carried no destination of its own before: whatever profile
 * named it, the engine sent it to that profile's hosts. A profile is the model's to write, so a
 * second profile naming the owner's secret on a host of its choosing took the secret there. A
 * binding says where the value goes, and only a person widens it:
 *
 * - once, at the first boot with this table, every name exactly one kind of destination is named
 *   for is bound to it ({@link migrateVaultNameBindings}); a name two profiles send to different
 *   places stays unbound, since which one the owner meant cannot be told;
 * - after that, only the owner's interactive save of a profile adds to it, after a question that
 *   names the vault name and the new destinations ({@link VaultNameBindings.extend}).
 *
 * Nothing shrinks a binding, and writing a new value under a name (`PUT /api/secrets/:name`,
 * `ask_secret`) leaves it as it is: a new value is not a new destination.
 */
import type Database from 'better-sqlite3';
import type { ApiProfile, ApiStore } from './api-store.js';
import { isMandateAuthored } from './api-store.js';
import { credentialEndpoints, secretBearingNames } from './profile-secret-view.js';
import { OAUTH_PRESETS, isPresetClientSecretName, presetClientKeys, presetStoreHost } from './oauth-presets.js';
import type { PromptText } from '../types/index.js';
import { pv } from './prompt-value.js';
import type { OwnerPrincipal } from './secret-releases.js';
import { shapedForLog, VAULT_NAME_SHAPE } from './profile-value-shape.js';

/** How a binding came about: the one-time boot migration, or the owner's answer at a save. */
export type BindingOrigin = 'migration' | 'confirmed';

export class VaultNameBindings {
  private readonly db: Database.Database;
  private readonly selectOne: Database.Statement;
  private readonly upsert: Database.Statement;
  private readonly insertIfAbsent: Database.Statement;
  private readonly selectMarker: Database.Statement;
  private readonly insertMarker: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.selectOne = db.prepare('SELECT endpoints FROM vault_name_bindings WHERE name = ?');
    this.upsert = db.prepare(
      `INSERT INTO vault_name_bindings (name, endpoints, origin, bound_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET endpoints = excluded.endpoints, origin = excluded.origin, bound_at = excluded.bound_at`,
    );
    this.insertIfAbsent = db.prepare(
      'INSERT OR IGNORE INTO vault_name_bindings (name, endpoints, origin, bound_at) VALUES (?, ?, ?, ?)',
    );
    this.selectMarker = db.prepare('SELECT 1 FROM vault_name_binding_migration LIMIT 1');
    this.insertMarker = db.prepare('INSERT INTO vault_name_binding_migration (migrated_at) VALUES (?)');
  }

  /** The destinations `name` is bound to, sorted; empty when it is bound to none. */
  boundOf(name: string): string[] {
    const row = this.selectOne.get(name) as { endpoints: string } | undefined;
    if (row === undefined) return [];
    const parsed: unknown = JSON.parse(row.endpoints);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  }

  /**
   * The owner allows `name` to go to `endpoints` as well, having been asked with exactly these.
   * Takes the owner's principal and nothing else, like a release (`secret-releases.ts`).
   */
  extend(_owner: OwnerPrincipal, name: string, endpoints: readonly string[]): void {
    this.db.transaction(() => {
      const merged = [...new Set([...this.boundOf(name), ...endpoints])].sort();
      this.upsert.run(name, JSON.stringify(merged), 'confirmed' satisfies BindingOrigin, new Date().toISOString());
    })();
  }

  /** Whether the boot migration ran on this database. */
  migrated(): boolean {
    return this.selectMarker.get() !== undefined;
  }

  /**
   * Bind every name of `binds` that has no binding yet, and record that the migration ran, in one
   * transaction: a boot that fails half way binds nothing and runs it again.
   */
  recordMigration(binds: ReadonlyMap<string, readonly string[]>): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const [name, endpoints] of binds) {
        this.insertIfAbsent.run(name, JSON.stringify([...endpoints].sort()), 'migration' satisfies BindingOrigin, now);
      }
      this.insertMarker.run(now);
    })();
  }
}

/** A profile's destinations as one comparable key: the sorted list, as JSON. */
function destinationKey(profile: ApiProfile): string {
  return JSON.stringify([...credentialEndpoints(profile)].sort());
}

/**
 * The different destinations `name` is named for among `profiles`, each as its sorted list: one
 * entry per distinct {@link credentialEndpoints} of a stored profile that names `name` in a
 * secret-bearing role ({@link secretBearingNames}). Profiles a mandate wrote are not counted:
 * what they send is decided by the owner's releases, and a mandate's save must not be able to
 * make the owner's name one nobody may send.
 */
export function namerDestinations(profiles: readonly ApiProfile[], name: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of profiles) {
    if (isMandateAuthored(p) || !secretBearingNames(p).includes(name)) continue;
    const key = destinationKey(p);
    if (!out.has(key)) out.set(key, [...credentialEndpoints(p)].sort());
  }
  return out;
}

/**
 * Why the boot migration must not bind `name`, or null. The migration binds silently, once, and
 * nothing shrinks a binding, so it binds only what it can attribute to the owner:
 * - while the import of stored profile files waits on an unreadable file, the profiles it would
 *   import are not in the store yet, so who names a name cannot be counted: nothing is bound;
 * - a name a stored entry the boot could not read names ({@link ApiStore.unreadableHolds}): whose
 *   it is cannot be told, and the profile that names it beside the entry may be the only one read.
 *   An entry that could not be read at all names every name, so then nothing is bound;
 * - a built-in provider's client secret ({@link isPresetClientSecretName}) named by any profile
 *   that is not a profile of that provider on that provider's API host: the owner enters it in
 *   that provider's connection form, so another profile naming it was not the owner's doing.
 * The migration runs once, held names included: each of these stays unbound until the owner
 * allows it at a save (the binding question), also after the cause is gone. Until then no
 * profile of the owner's sends it, since an unbound name has no destination to go to
 * (`nameMayGo`); a `secret:` reference to it is decided as for any unbound name.
 */
function migrationHold(apiStore: Pick<ApiStore, 'unreadableHolds' | 'importWaitsOn'>, profiles: readonly ApiProfile[], name: string): string | null {
  if (apiStore.importWaitsOn().length > 0) return 'the import of stored profile files waits on an unreadable file';
  if (apiStore.unreadableHolds(name)) return 'also named by a stored entry that could not be read';
  if (isPresetClientSecretName(name)) {
    for (const p of profiles) {
      if (isMandateAuthored(p) || !secretBearingNames(p).includes(name)) continue;
      const presetId: unknown = p.auth?.type === 'oauth2' ? p.auth.oauth?.preset_id : undefined;
      // The register's own id, not a string that only spells the same vault name, and a base on
      // the provider's API host, not one the profile chose.
      const preset = typeof presetId === 'string' ? OAUTH_PRESETS.get(presetId) : undefined;
      if (preset === undefined || presetClientKeys(preset.id).secret !== name || !onPresetApiHost(p, preset)) {
        return "a built-in provider's client secret named by a profile that is not that provider's";
      }
    }
  }
  return null;
}

/** Whether `profile`'s base is https on one of `preset`'s API hosts, or on the host it derives. */
function onPresetApiHost(profile: ApiProfile, preset: NonNullable<ReturnType<typeof OAUTH_PRESETS.get>>): boolean {
  if (preset.apiOnDerivedHost === true) return presetStoreHost(profile) !== null;
  let base: URL;
  try {
    base = new URL(profile.base_url);
  } catch {
    return false;
  }
  return base.protocol === 'https:' && base.port === '' && base.username === '' && base.password === '' && preset.apiHosts.includes(base.hostname);
}

/**
 * Whether `name` is contested: the stored profiles (registered or held back) that name it in a
 * secret-bearing role, mandates' aside, send it to two or more different sets of destinations.
 * Anything that throws counts as contested.
 */
export function isContestedName(apiStore: Pick<ApiStore, 'knownProfiles'>, name: string): boolean {
  try {
    return namerDestinations(apiStore.knownProfiles(), name).size >= 2;
  } catch {
    return true;
  }
}

/**
 * The one-time boot migration: every secret-bearing name whose namers agree on one set of
 * destinations is bound to it; a contested name is left unbound. Runs once per database, and
 * says per name what it counted and what it decided — names only, never a value.
 */
export function migrateVaultNameBindings(
  bindings: VaultNameBindings,
  apiStore: Pick<ApiStore, 'knownProfiles' | 'unreadableHolds' | 'importWaitsOn'>,
  log: (line: string) => void = (line) => { process.stderr.write(`${line}\n`); },
): void {
  if (bindings.migrated()) return;
  const profiles = apiStore.knownProfiles();
  const names = new Set<string>();
  for (const p of profiles) if (!isMandateAuthored(p)) for (const n of secretBearingNames(p)) names.add(n);
  const binds = new Map<string, string[]>();
  for (const name of [...names].sort()) {
    const dests = namerDestinations(profiles, name);
    const shown = shapedForLog(name, VAULT_NAME_SHAPE, 80);
    const [only] = [...dests.values()];
    const hold = migrationHold(apiStore, profiles, name);
    if (hold !== null) {
      log(`[lynox:vault-bindings] ${shown}: ${hold}, left unbound`);
    } else if (dests.size === 1 && only !== undefined && only.length > 0) {
      binds.set(name, only);
      log(`[lynox:vault-bindings] ${shown}: 1 destination set counted, bound`);
    } else if (dests.size === 1) {
      log(`[lynox:vault-bindings] ${shown}: 1 destination set counted, empty, left unbound`);
    } else {
      log(`[lynox:vault-bindings] ${shown}: ${String(dests.size)} destination sets counted, left unbound`);
    }
  }
  bindings.recordMigration(binds);
}

/**
 * Characters a person cannot see, or that reorder what they see: format characters (zero-width,
 * bidi controls, the tag block U+E0000–U+E007F) and control characters. A binding question
 * holding one is not asked: the person would approve something other than what is stored.
 */
export function hasInvisibleCharacters(value: string): boolean {
  return /[\p{Cf}\p{Cc}\u{E0000}-\u{E007F}]/u.test(value);
}

/**
 * The question the owner answers before `name` may go to more destinations. Built only from
 * stored and validated state: the vault name from the profile being saved, `bound` from the
 * stored binding, `added` from {@link credentialEndpoints} of that profile.
 *
 * Customer-visible copy, approved by the business owner.
 */
export function bindingQuestion(name: string, bound: readonly string[], added: readonly string[]): PromptText {
  if (bound.length === 0) {
    return pv`${name} is stored in your vault and is not yet limited to any address.\n\nThis profile would send it to: ${added.join(', ')}.\n\nAllow ${name} to be sent there? From then on it goes only to the addresses you have allowed.`;
  }
  return pv`${name} is sent only to: ${bound.join(', ')}.\n\nThis profile would also send it to: ${added.join(', ')}.\n\nAllow ${name} to be sent there as well?`;
}
