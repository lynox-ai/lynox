/**
 * Vault scoping for spawned agents.
 *
 * Until this module existed, a child agent always shared the parent's SecretStore
 * object outright (`spawn.ts`), and with `secret_scope: 'all'` it still does —
 * `scopeSecretStore` returns `inner` unchanged for the full vault. Sharing is what
 * lets a sub-agent authenticate without its own key management, and it is
 * right while a sub-agent is ephemeral and spawned by the person who owns the
 * vault. It stops being right the moment an agent is set up to run FOR someone:
 * the tool whitelist bounds what it can DO, the inherited vault does not bound
 * what it can REACH.
 *
 * This module is the bound. `scopeSecretStore` returns a narrowed VIEW of a
 * store — same interface, fewer keys — and `spawn.ts` hands the child that view
 * instead of the parent's own store.
 *
 * ⚠ Name collision, deliberate: `SecretScope` in `types/security.ts` is a
 * different axis — WHERE a secret may be used (`http_header` | `bash_env` | …).
 * This one is WHICH secrets a given agent may see at all, so it is `VaultScope`.
 */

import type { SecretStoreLike, SecretScope } from '../types/security.js';
import { resolveSecretRefsWith, extractSecretRefNames, isInfraSecret } from './secret-store.js';
import { channels } from './observability.js';

/** Explicit, never inferred: the full vault. Only an agent that itself holds the
 *  full vault may hand it on — see {@link narrowVaultScope}. */
export const VAULT_SCOPE_ALL = 'all';

/** Either an explicit list of vault key names, or the whole vault. */
export type VaultScope = readonly string[] | typeof VAULT_SCOPE_ALL;

/** Marker carried by a scoped view so {@link vaultScopeOf} can read a store's
 *  current scope back out. A plain `SecretStore` carries none and counts as
 *  unscoped — which is correct: the root agent's store IS the full vault. */
const SCOPE_MARKER = Symbol.for('lynox.vaultScope');

interface ScopedStore extends SecretStoreLike {
  readonly [SCOPE_MARKER]?: VaultScope;
}

/**
 * The scope a store was BUILT with. An unwrapped store is `'all'`.
 *
 * A snapshot, not a live reading: `set` widens the live `allowed` set for a name
 * the child stored itself, and the marker does not follow. That direction is
 * fail-closed — a grandchild would be offered the narrower spawn-time scope — and
 * no grandchild can exist today anyway, since `spawn_agent` is stripped from
 * every child. Said plainly here because the word "current" was doing work the
 * code does not.
 */
export function vaultScopeOf(store: SecretStoreLike | undefined): VaultScope {
  if (!store) return VAULT_SCOPE_ALL;
  return (store as ScopedStore)[SCOPE_MARKER] ?? VAULT_SCOPE_ALL;
}

function isFullVault(scope: VaultScope): scope is typeof VAULT_SCOPE_ALL {
  return scope === VAULT_SCOPE_ALL;
}

/**
 * The scope a child may actually get, given what its parent holds.
 *
 * The invariant is one-directional: a scope never widens going down a spawn
 * chain. `all` is therefore not a keyword a child can simply write — it is only
 * grantable by an agent that already holds the full vault. That is what makes
 * "`all` only explicitly, admin scope" a property of the code rather than a
 * convention: a scoped agent cannot re-open the vault for a grandchild, and it
 * cannot do it in two steps either, because each step is checked against the
 * scope the step above actually has.
 *
 * Returns the effective scope, or a refusal naming exactly which keys were
 * refused — a refusal that says only "denied" sends the reader to the wrong
 * repair.
 *
 * Defence in depth, and today ONLY that: `SPAWN_EXCLUDED` (`spawn.ts`) and
 * `INLINE_EXCLUDED_TOOLS` (`runtime-adapter.ts`) both strip `spawn_agent` from
 * every child and every workflow step, so no scoped agent can spawn and the
 * chain this guards cannot form. It is here so that the day one of those lists
 * changes, the widening is already refused rather than newly possible.
 */
export function narrowVaultScope(
  parent: VaultScope,
  requested: VaultScope,
): { scope: VaultScope } | { refusal: string } {
  if (isFullVault(requested)) {
    return isFullVault(parent)
      ? { scope: VAULT_SCOPE_ALL }
      : {
          refusal:
            `secret_scope: "all" is not available here — this agent holds a scoped vault itself `
            + `(${parent.length === 0 ? 'no keys' : parent.join(', ')}), and a scope never widens when it is passed on. `
            + `Name the keys the child needs instead; they must be among the ones this agent holds.`,
        };
  }
  if (isFullVault(parent)) return { scope: [...requested] };

  const allowed = new Set(parent);
  const refused = requested.filter((n) => !allowed.has(n));
  if (refused.length > 0) {
    return {
      refusal:
        `secret_scope names ${refused.length === 1 ? 'a key' : 'keys'} this agent does not itself hold: `
        + `${refused.join(', ')}. A scope never widens when it is passed on. `
        + `This agent holds: ${parent.length === 0 ? 'no keys' : parent.join(', ')}.`,
    };
  }
  return { scope: [...requested] };
}

/**
 * The default scope for a spawn: the vault keys the spawn order itself names.
 *
 * `extractSecretRefNames` is a pure text scan over the order — no value is read —
 * so this asks exactly the question the decision asks: which sources did the
 * caller write down? Everything else is out, including keys the parent holds.
 * An empty order therefore yields an EMPTY scope, not the parent's vault; the
 * default is "nothing", and that is the point of it.
 */
export function defaultVaultScope(spawnOrder: unknown): readonly string[] {
  return extractSecretRefNames(spawnOrder);
}

/**
 * A reader that can answer for LLM provider key slots and nothing else.
 *
 * `spawn.ts` resolves the child's own wire credential outside the child's scope —
 * it has to, or a child could not run at all wherever the key lives in the vault
 * rather than the environment, which is every BYOK tenant. That read is legitimate
 * and the value never becomes a name the child can address; what was not
 * legitimate was doing it through a handle that carried the WHOLE parent vault,
 * which made the exception unbounded in what it could have read even though it
 * only ever read one slot.
 *
 * Exported and taken as a unit on purpose. Inlined at the call site, the bound is
 * invisible to a test: the closure asks for exactly one slot either way, so what
 * changes when the bound is removed is what the handle COULD reach, and a test
 * that watches behaviour cannot see that. Here it is a function with a refusal
 * that can be asserted.
 */
export function providerKeySlotReader(
  inner: SecretStoreLike,
  slots: ReadonlySet<string>,
): { resolve(name: string): string | null } {
  return { resolve: (name) => (slots.has(name) ? inner.resolve(name) : null) };
}

type DeniedOp = 'resolve' | 'getMasked' | 'consent' | 'delete';

/**
 * A narrowed view of `inner`.
 *
 * What is narrowed is the object literal below, and it is not restated here.
 * Two attempts at a category sentence were both false — the members share no
 * predicate: `recordConsent` and `deleteSecret` are writes, and
 * `findUnresolvedSecretRefs` must ENUMERATE out-of-scope names to do its job.
 * A prose roll-call sixty lines above the literal only moves the same problem
 * one revision further out.
 *
 * `set` is NOT narrowed; see the note above it. `explainUnresolved` is not
 * narrowed by the scope either, and deliberately: its whole job is to answer
 * ABOUT a name outside the scope. It is bounded by answering from scope
 * membership alone — it never consults the vault, because its verdict reaches
 * the model and a verdict drawn from existence is an oracle over the vault.
 *
 * What is deliberately NOT narrowed: `containsSecret`, `maskSecrets` and
 * `maskAll`. They are what stops a value from reaching a log, a tool result or
 * an outbound request. Keeping them whole is not free — `containsSecret` stays
 * a one-bit oracle over the full vault, so a child holding a fully guessed value
 * can confirm the guess. That is a worse trade than the alternative by a wide
 * margin but it is a trade, not a clean win. Narrowing them would
 * mean a child scoped to one key stops masking every other key in the vault, so the
 * scoping meant to contain secrets would be the thing that spilled them. They
 * stay wired to the full store on purpose.
 *
 * `extractSecretNames` also stays full: it reads no values, and narrowing it
 * would hide an out-of-scope reference from `findUnresolvedSecretRefs`, whose
 * whole job is to fail loudly on one.
 */
export function scopeSecretStore(
  inner: SecretStoreLike,
  scope: VaultScope,
  onDenied?: (name: string) => void,
): SecretStoreLike {
  // Identity for the full vault: no wrapper, so an unscoped spawn is byte-for-byte
  // the behaviour it had before this module existed.
  if (isFullVault(scope)) return inner;

  const allowed = new Set(scope);
  // The operation travels with the denial. `secret-store.ts` publishes distinct
  // actions for resolve / consent / store / delete, and a trail in which a
  // refused DESTRUCTION cannot be told from a refused read answers the wrong
  // question for whoever reads it after an incident.
  const deny = (name: string, op: DeniedOp): void => {
    channels.secretAccess.publish({ name, action: 'denied', op });
    onDenied?.(name);
  };
  const permits = (name: string, op: DeniedOp): boolean => {
    if (allowed.has(name)) return true;
    // Infrastructure secrets are not this mechanism's business ON A READ, and
    // denying them there made the view DISAGREE with the resolver it wraps. `resolveSecretRefsWith`
    // never resolves an infra ref into tool input, scope or no scope; the store
    // never advertises one; and engine code resolves them on the agent's behalf
    // (a calendar feed URL, a mail account) without the model ever holding the
    // value. Denied here, such a ref came back from `findUnresolvedSecretRefs` as
    // UNRESOLVED — which `agent.ts` reads as "the vault doesn't have it" and
    // answers with "call ask_secret to store its value". That instructs the model
    // to ask the user for their IMAP password, through the very branch this piece
    // added to stop a wrong remedy. It also broke every tool that resolves an
    // infra key for a scoped child.
    //
    // READ ops only. An earlier version let infra names past on EVERY operation,
    // which handed a scoped child the power to DELETE the mail and OAuth
    // credentials it is not even allowed to read — precisely what the note above
    // `deleteSecret` claims narrowing it bounds. The argument for letting them
    // through is that the reader must agree with the resolver; none of it
    // reaches a write.
    if (isInfraSecret(name) && (op === 'resolve' || op === 'getMasked')) return true;
    deny(name, op);
    return false;
  };

  const view: ScopedStore = {
    [SCOPE_MARKER]: [...scope],

    resolve: (name) => (permits(name, 'resolve') ? inner.resolve(name) : null),
    getMasked: (name) => (permits(name, 'getMasked') ? inner.getMasked(name) : null),

    listNames: () => inner.listNames().filter((n) => allowed.has(n)),
    listAgentVisibleNames: () =>
      // `?? []` rather than `?? inner.listNames()`: `listNames` on the real
      // store includes infrastructure secrets, so a store that cannot say what
      // the agent may see must answer "nothing", not "everything".
      (inner.listAgentVisibleNames?.() ?? []).filter((n) => allowed.has(n)),
    findNameMatches: (requested) =>
      (inner.findNameMatches?.(requested) ?? []).filter((n) => allowed.has(n)),

    // Unnarrowed on purpose — see the doc comment above.
    containsSecret: (text) => inner.containsSecret(text),
    maskSecrets: (text) => inner.maskSecrets(text),
    maskAll: (text, opts) => inner.maskAll(text, opts),
    extractSecretNames: (input) => inner.extractSecretNames(input),

    // Infra included for the same reason `resolve` includes it: `agent.ts` asks
    // this before a tool call and prompts the user for anything unconsented.
    // Vault entries are auto-consented at load, so an unscoped agent never
    // prompts for one — a scoped child answering `false` would ask the user to
    // approve a mail credential the engine resolves on its behalf.
    hasConsent: (name) => (allowed.has(name) || isInfraSecret(name) ? inner.hasConsent(name) : false),
    // Fail-closed for an unknown key. Nothing in src/ reads `isExpired` today
    // outside the stores themselves, so this is a choice about which way an
    // unused seam should point if something starts reading it, not a claim
    // about a caller that exists.
    isExpired: (name) => (allowed.has(name) || isInfraSecret(name) ? inner.isExpired(name) : true),
    recordConsent: (name) => {
      if (permits(name, 'consent')) inner.recordConsent(name);
    },

    // The same walk the store itself runs, with THIS view's resolver. Delegating
    // to `inner.resolveSecretRefs` here would resolve every key and undo the scope.
    resolveSecretRefs: (input) => resolveSecretRefsWith(input, (name) => view.resolve(name)),
    findUnresolvedSecretRefs: (input) =>
      inner.extractSecretNames(input).filter((n) => view.resolve(n) === null),
    // Out-of-scope and absent look identical to every caller of `resolve`, and
    // the remedy for the two is opposite: one is "name it in secret_scope", the
    // other "store it". Without this the agent is told to collect a credential
    // the vault already holds, which it cannot then read either — a loop.
    // Answered from SCOPE MEMBERSHIP, never from existence. `agent.ts` echoes
    // this verdict to the model, so a version that checked whether the name is
    // really in the vault turned the refusal into a confirm-oracle: a child
    // scoped to nothing could name `secret:STRIPE_API_KEY`, read "it IS in the
    // vault but outside your scope", and report the answer out through its own
    // result. Whether an out-of-scope key exists is not the child's business,
    // and the remedy does not need it — "outside your scope" is the true and
    // complete answer either way, and a name that turns out not to exist gets
    // the absent message on the next attempt, once it IS in scope.
    //
    // Infra names excluded: reads pass the scope check for them, so an
    // unresolved infra ref really is absent.
    explainUnresolved: (name) =>
      (!allowed.has(name) && !isInfraSecret(name) ? 'out-of-scope' : undefined),

    // Writes are NOT narrowed, and this is a stated limit of this piece rather
    // than an oversight. The row this closes is about what a child can REACH;
    // bounding what it can STORE is a different seam with a different failure
    // mode, and an earlier draft of this file found it the hard way: a throwing
    // `set` fires inside `api_setup fetch_token` AFTER the token exchange has
    // already spent a single-use authorization code, at a call site with no
    // catch — turning a scope decision into an unrecoverable one.
    //
    // The presence gate below survives that rewrite, and it is worth saying what
    // it does and does not buy. On the real `SecretStore` both write verbs are
    // prototype methods, so in production this branch never takes the other path.
    // It is kept because the interface marks both write verbs OPTIONAL and
    // `api-setup.ts` probes `if (!secretStore.set)` at STORE level before a token
    // exchange: a view that answered that probe on behalf of a store which cannot
    // write would turn a clean refusal into a write that no-ops under a message
    // saying the token was stored. That is a bound on what this view may claim,
    // not a claim about a second production store — there is none.
    ...(inner.set
      ? {
          set: (n: string, v: string, sc?: SecretScope, ttl?: number) => {
            inner.set!(n, v, sc, ttl);
            // What a child stores, it may read. Without this, its own
            // `api_setup fetch_token` wrote an access_token it was then refused
            // forever — and that write lands AFTER the single-use authorization
            // code is spent, so a retry cannot recover it either. It grants
            // nothing pre-existing: the value under that name is now the one
            // this child just put there.
            //
            // It does NOT cover `ask_secret`, whose write goes through the HTTP
            // route to the ENGINE's store and never touches this view. A scoped
            // child that collects a secret from the user still cannot read it
            // back — registered as its own row rather than half-fixed here.
            allowed.add(n);
          },
        }
      : {}),
    // Delete IS narrowed, and the asymmetry with `set` above is the point rather
    // than an inconsistency. `set` stays open because refusing it fires inside
    // `api_setup fetch_token` after an authorization code is already spent. No
    // delete path is unrecoverable that way, and destroying a vault entry the
    // child may not even read is destruction beyond its reach — the exact thing
    // the scope exists to bound.
    //
    // What it does NOT buy, since the comment above it once implied otherwise:
    // immunity from destruction. `set` stays open and `api_setup fetch_token`
    // writes a model-chosen output name, so a scoped child can still destroy
    // another entry by overwriting it. Narrowing delete closes the direct verb,
    // not the class — the write side is its own seam and is registered as one.
    ...(inner.deleteSecret
      ? { deleteSecret: (n: string) => (permits(n, 'delete') ? inner.deleteSecret!(n) : false) }
      : {}),
  };

  return view;
}
