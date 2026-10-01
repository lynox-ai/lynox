import { describe, it, expect, vi } from 'vitest';
import type { SecretStoreLike } from '../types/security.js';
import {
  scopeSecretStore,
  defaultVaultScope,
  narrowVaultScope,
  vaultScopeOf,
  VAULT_SCOPE_ALL,
  providerKeySlotReader,
} from './secret-scope.js';

vi.mock('./observability.js', () => ({
  channels: { secretAccess: { publish: vi.fn() } },
}));
import { channels } from './observability.js';

/** A minimal store over a plain map — enough to answer every method the scoped
 *  view delegates to, so a test failure points at the view and not at a stub. */
function makeStore(entries: Record<string, string>): SecretStoreLike {
  const map = new Map(Object.entries(entries));
  return {
    getMasked: (n) => (map.has(n) ? `${map.get(n)!.slice(0, 2)}…` : null),
    resolve: (n) => map.get(n) ?? null,
    listNames: () => [...map.keys()],
    listAgentVisibleNames: () => [...map.keys()],
    findNameMatches: (requested) => [...map.keys()].filter((n) => n !== requested),
    containsSecret: (text) => [...map.values()].some((v) => text.includes(v)),
    maskSecrets: (text) => [...map.values()].reduce((t, v) => t.split(v).join('***'), text),
    maskAll: (text) => [...map.values()].reduce((t, v) => t.split(v).join('***'), text),
    recordConsent: () => {},
    hasConsent: (n) => map.has(n),
    isExpired: () => false,
    extractSecretNames: (input) => {
      const found = JSON.stringify(input).match(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g) ?? [];
      return [...new Set(found.map((m) => m.slice('secret:'.length)))];
    },
    resolveSecretRefs: (input) => input,
    findUnresolvedSecretRefs: () => [],
    set: (n, v) => { map.set(n, v); },
    deleteSecret: (n) => map.delete(n),
  };
}

const VAULT = { STRIPE_KEY: 'sk_live_stripe', NOTION_KEY: 'ntn_notion', HR_PAYROLL: 'pay_secret' };

describe('defaultVaultScope', () => {
  it('is exactly the keys the spawn order names', () => {
    expect(defaultVaultScope({ name: 'a', task: 'call secret:STRIPE_KEY' })).toEqual(['STRIPE_KEY']);
  });

  it('is EMPTY for an order that names none — the default is nothing, not the parent vault', () => {
    expect(defaultVaultScope({ name: 'a', task: 'summarise this file' })).toEqual([]);
  });

  it('scans whatever object it is handed — the CALLER decides which fields count', () => {
    // spawn.ts hands it `task` + `system_prompt` only, on purpose: see the
    // `context` test in spawn.test.ts. This function stays field-agnostic so
    // that decision lives at the call site rather than being buried here.
    expect(defaultVaultScope({ task: 'go', system_prompt: 'secret:STRIPE_KEY' })).toEqual(['STRIPE_KEY']);
  });
});

describe('scopeSecretStore — reach', () => {
  it('resolves a key the scope names (the scope is not too tight)', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    expect(scoped.resolve('STRIPE_KEY')).toBe('sk_live_stripe');
  });

  it('refuses a key the scope does not name, and reports it as denied', () => {
    const denied: string[] = [];
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY'], (n) => denied.push(n));
    expect(scoped.resolve('HR_PAYROLL')).toBeNull();
    expect(denied).toEqual(['HR_PAYROLL']);
  });

  it('an EMPTY scope reaches nothing at all', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), []);
    expect(scoped.resolve('STRIPE_KEY')).toBeNull();
    expect(scoped.resolve('NOTION_KEY')).toBeNull();
    expect(scoped.listNames()).toEqual([]);
  });

  it('stops enumerating the names it cannot read — the briefing is half the exfil surface', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['NOTION_KEY']);
    expect(scoped.listAgentVisibleNames?.()).toEqual(['NOTION_KEY']);
    expect(scoped.getMasked('HR_PAYROLL')).toBeNull();
    // The claim is not "no matches" — an in-scope key may legitimately match.
    // It is that the near-identical-name reconciliation never offers a key the
    // child cannot read, which would hand it the name without the value.
    const matches = scoped.findNameMatches?.('HR_PAYROL') ?? [];
    expect(matches).not.toContain('HR_PAYROLL');
    expect(matches).not.toContain('STRIPE_KEY');
  });
});

describe('scopeSecretStore — resolveSecretRefs is the path tool input travels', () => {
  it('resolves an in-scope ref and leaves an out-of-scope one literal', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    const out = scoped.resolveSecretRefs({ a: 'secret:STRIPE_KEY', b: 'secret:HR_PAYROLL' }) as Record<string, string>;
    expect(out.a).toBe('sk_live_stripe');
    expect(out.b).toBe('secret:HR_PAYROLL');
  });

  it('an out-of-scope ref stays visible to the fail-loud gate', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    expect(scoped.findUnresolvedSecretRefs({ b: 'secret:HR_PAYROLL' })).toEqual(['HR_PAYROLL']);
    expect(scoped.findUnresolvedSecretRefs({ a: 'secret:STRIPE_KEY' })).toEqual([]);
  });
});

describe('scopeSecretStore — infra secrets are not the scope\'s business', () => {
  // `MAIL_ACCOUNT_*` matches INFRA_SECRET_PATTERNS, so the real `isInfraSecret`
  // governs it. The fixture's own listAgentVisibleNames must exclude it, as the
  // real store's does.
  function infraStore() {
    const store = makeStore({ ...VAULT, MAIL_ACCOUNT_1: 'imap-pw' });
    store.listAgentVisibleNames = () => Object.keys(VAULT);
    return store;
  }

  it('does NOT report an infra ref as unresolved — the view must agree with the resolver', () => {
    // `resolveSecretRefsWith` leaves an infra ref literal regardless of scope.
    // A view that called it unresolved made `agent.ts` answer "the vault doesn't
    // have it — call ask_secret to store its value", i.e. instruct the model to
    // ask the user for their mail password, through the very branch this piece
    // added to stop a wrong remedy.
    const scoped = scopeSecretStore(infraStore(), ['STRIPE_KEY']);
    expect(scoped.findUnresolvedSecretRefs({ a: 'secret:MAIL_ACCOUNT_1' })).toEqual([]);
    expect(scoped.explainUnresolved?.('MAIL_ACCOUNT_1')).toBeUndefined();
  });

  it('REFUSES to delete one — the read exception must not carry to a write', () => {
    // The reason infra names pass the scope check is that the view has to agree
    // with the resolver about what a REF means. None of that argues for letting
    // a scoped child destroy the mail or OAuth credentials it may not read —
    // which is exactly what an earlier version, bypassing on every operation, did.
    const inner = infraStore();
    const scoped = scopeSecretStore(inner, ['STRIPE_KEY']);
    expect(scoped.deleteSecret?.('MAIL_ACCOUNT_1')).toBe(false);
    expect(inner.resolve('MAIL_ACCOUNT_1')).toBe('imap-pw');
  });

  it('answers consent for one as the unscoped store would', () => {
    // `agent.ts` prompts the user for anything it reads as unconsented. Vault
    // entries are auto-consented at load, so answering false here would make a
    // scoped child ask the user to approve a credential the engine resolves on
    // its behalf — a dialog an unscoped agent never raises.
    const scoped = scopeSecretStore(infraStore(), ['STRIPE_KEY']);
    expect(scoped.hasConsent('MAIL_ACCOUNT_1')).toBe(true);
    expect(scoped.hasConsent('HR_PAYROLL')).toBe(false);
  });

  it('still resolves it for engine code, which reads it on the agent\'s behalf', () => {
    // calendar_read and the mail tools resolve an infra key internally; a scope
    // that denied them would break every such tool for a scoped child.
    const scoped = scopeSecretStore(infraStore(), ['STRIPE_KEY']);
    expect(scoped.resolve('MAIL_ACCOUNT_1')).toBe('imap-pw');
  });

  it('never advertises it, and never lets it into tool input', () => {
    const scoped = scopeSecretStore(infraStore(), ['STRIPE_KEY']);
    expect(scoped.listNames()).not.toContain('MAIL_ACCOUNT_1');
    expect(scoped.listAgentVisibleNames?.()).not.toContain('MAIL_ACCOUNT_1');
    const out = scoped.resolveSecretRefs({ a: 'secret:MAIL_ACCOUNT_1' }) as Record<string, string>;
    expect(out.a).toBe('secret:MAIL_ACCOUNT_1');
  });
});

describe('scopeSecretStore — masking must NOT narrow', () => {
  // The EMPTY scope is the default — an order naming no key — so it is the case
  // that runs most often and the one a mask-narrowing bug would hit first. A
  // masking test written only against a non-empty scope leaves it uncovered:
  // measured here as a surviving mutant that narrowed masking for `allowed.size
  // === 0` alone and killed nothing.
  it('a child with the EMPTY default scope still masks the whole vault', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), []);
    const leak = `${VAULT.HR_PAYROLL} and ${VAULT.STRIPE_KEY}`;
    expect(scoped.maskSecrets(leak)).toBe('*** and ***');
    expect(scoped.maskAll(leak)).toBe('*** and ***');
    expect(scoped.containsSecret(leak)).toBe(true);
  });

  it('still masks a value the scope cannot read', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    const leak = `payroll is ${VAULT.HR_PAYROLL}`;
    expect(scoped.maskSecrets(leak)).toBe('payroll is ***');
    expect(scoped.containsSecret(leak)).toBe(true);
    expect(scoped.maskAll(leak)).toBe('payroll is ***');
  });
});

describe('scopeSecretStore — a refusal is recorded, not just returned', () => {
  it('publishes a denial to the audit channel', () => {
    // The row this closes asks for two things — the access FAILS and it is
    // LOGGED. The failing half is covered from every angle; the logging half
    // was asserted nowhere, so deleting the publish call left the suite green.
    vi.mocked(channels.secretAccess.publish).mockClear();
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    scoped.resolve('HR_PAYROLL');
    expect(vi.mocked(channels.secretAccess.publish)).toHaveBeenCalledWith({
      name: 'HR_PAYROLL', action: 'denied', op: 'resolve',
    });
  });

  it('records WHICH operation was refused, so a destruction is not read as a lookup', () => {
    vi.mocked(channels.secretAccess.publish).mockClear();
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    scoped.deleteSecret?.('HR_PAYROLL');
    expect(vi.mocked(channels.secretAccess.publish)).toHaveBeenCalledWith({
      name: 'HR_PAYROLL', action: 'denied', op: 'delete',
    });
  });

  it('reports a refused delete to the parent as well', () => {
    const denied: string[] = [];
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY'], (n) => denied.push(n));
    scoped.deleteSecret?.('HR_PAYROLL');
    expect(denied).toEqual(['HR_PAYROLL']);
  });

  it('does not record a denial for a key inside the scope', () => {
    vi.mocked(channels.secretAccess.publish).mockClear();
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    scoped.resolve('STRIPE_KEY');
    expect(vi.mocked(channels.secretAccess.publish)).not.toHaveBeenCalled();
  });

  it('answers isExpired fail-closed for a key outside the scope', () => {
    // No live caller reads this today. The test pins the DIRECTION so that the
    // day one appears, the out-of-scope answer is the refusing one rather than
    // whatever the inner store happens to say about a key it can see.
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    expect(scoped.isExpired('HR_PAYROLL')).toBe(true);
    expect(scoped.isExpired('STRIPE_KEY')).toBe(false);
  });
});

describe('scopeSecretStore — writes are NOT narrowed, on purpose', () => {
  it('passes a write through, in scope or out', () => {
    const inner = makeStore(VAULT);
    const scoped = scopeSecretStore(inner, ['STRIPE_KEY']);
    scoped.set?.('STRIPE_KEY', 'sk_rotated');
    scoped.set?.('HR_PAYROLL', 'rotated_too');
    expect(inner.resolve('STRIPE_KEY')).toBe('sk_rotated');
    // Out of scope for READING and still writable. That is the stated boundary
    // of this piece: it bounds what a child can reach, not what it can store.
    // An earlier draft threw here — which fires inside api_setup's token
    // exchange AFTER the single-use authorization code is already spent, at a
    // call site with no catch, turning a scope decision into an unrecoverable one.
    expect(inner.resolve('HR_PAYROLL')).toBe('rotated_too');
    // And it CAN read back what it wrote. Refusing that made a child's own
    // `api_setup fetch_token` store an access_token it was then denied forever,
    // after the single-use authorization code was already spent. It grants
    // nothing pre-existing — the value under that name is the one it just wrote.
    expect(scoped.resolve('HR_PAYROLL')).toBe('rotated_too');
  });

  it('REFUSES a delete outside the scope — destruction is not a write exception', () => {
    // An earlier version of this test asserted the opposite and called it the
    // contract. The rationale for leaving writes open is about `set` and a spent
    // authorization code; no delete path is unrecoverable that way, so carrying
    // the exception across to delete would have made "a child scoped to one key
    // may destroy every other" a guarantee of this piece.
    const inner = makeStore(VAULT);
    const scoped = scopeSecretStore(inner, ['STRIPE_KEY']);
    expect(scoped.deleteSecret?.('HR_PAYROLL')).toBe(false);
    expect(inner.resolve('HR_PAYROLL')).toBe('pay_secret');
  });

  it('allows a delete inside the scope', () => {
    const inner = makeStore(VAULT);
    const scoped = scopeSecretStore(inner, ['STRIPE_KEY']);
    expect(scoped.deleteSecret?.('STRIPE_KEY')).toBe(true);
    expect(inner.resolve('STRIPE_KEY')).toBeNull();
  });

  it('does not invent a delete path the inner store lacks', () => {
    const readOnly = makeStore(VAULT);
    delete (readOnly as { deleteSecret?: unknown }).deleteSecret;
    expect(scopeSecretStore(readOnly, ['STRIPE_KEY']).deleteSecret).toBeUndefined();
  });

  it('does not invent a write path the inner store lacks', () => {
    const readOnly = makeStore(VAULT);
    delete (readOnly as { set?: unknown }).set;
    const scoped = scopeSecretStore(readOnly, ['STRIPE_KEY']);
    // `api-setup.ts` probes `if (!secretStore.set)` before a token exchange. The
    // probe is store-level, so the view has to answer at store level too.
    expect(scoped.set).toBeUndefined();
  });
});

describe('scopeSecretStore — out-of-scope is distinguishable from absent', () => {
  it('names the scope as the reason for a key that IS stored', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    expect(scoped.explainUnresolved?.('HR_PAYROLL')).toBe('out-of-scope');
  });

  it('still names the scope for a key that is out of scope AND unresolvable', () => {
    // `resolve` answers null for absent, expired and unconsented alike, so a
    // predicate built on it sends an expired out-of-scope key down the "go
    // collect it" branch — the one remedy that cannot work for it.
    const store = makeStore(VAULT);
    store.resolve = () => null;
    const scoped = scopeSecretStore(store, ['STRIPE_KEY']);
    expect(scoped.explainUnresolved?.('HR_PAYROLL')).toBe('out-of-scope');
  });

  it('does not consult the vault at all — the verdict comes from the scope', () => {
    // The store cannot influence this answer, because the answer must not carry
    // information about the store. A store that knows nothing gives the same
    // verdict as one holding the key.
    const empty = makeStore({});
    expect(scopeSecretStore(empty, ['STRIPE_KEY']).explainUnresolved?.('HR_PAYROLL')).toBe('out-of-scope');
    expect(scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']).explainUnresolved?.('HR_PAYROLL')).toBe('out-of-scope');
  });

  it('says nothing about an INFRA secret, which the agent may never learn exists', () => {
    // The verdict is echoed back to the model by agent.ts. Asked of every name
    // the store holds rather than of the agent-visible ones, this method would
    // confirm the existence of a mail or OAuth credential to any child that
    // guessed its name.
    const store = makeStore({ ...VAULT, MAIL_ACCOUNT_7: 'imap_pw' });
    store.listAgentVisibleNames = () => Object.keys(VAULT);
    const scoped = scopeSecretStore(store, ['STRIPE_KEY']);
    expect(scoped.explainUnresolved?.('MAIL_ACCOUNT_7')).toBeUndefined();
    expect(scoped.explainUnresolved?.('HR_PAYROLL')).toBe('out-of-scope');
  });

  it('does NOT distinguish a stored key from an absent one — that is the point', () => {
    // An earlier version answered from existence, which let a child scoped to
    // nothing guess names and be told which ones the vault holds — an oracle
    // over the tenant's whole credential inventory, reportable out through the
    // child's own result. A name outside the scope is refused either way, and a
    // key that really is absent gets the absent message on the next attempt,
    // once it is in scope.
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    expect(scoped.explainUnresolved?.('NEVER_STORED')).toBe('out-of-scope');
    expect(scoped.explainUnresolved?.('HR_PAYROLL')).toBe('out-of-scope');
  });

  it('says nothing about a key inside the scope', () => {
    const scoped = scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']);
    expect(scoped.explainUnresolved?.('STRIPE_KEY')).toBeUndefined();
  });
});

describe('providerKeySlotReader — the one read outside the child scope, bounded', () => {
  const SLOTS = new Set(['ANTHROPIC_API_KEY']);

  it('answers for a provider slot, so a BYOK child can still run', () => {
    const reader = providerKeySlotReader(makeStore({ ANTHROPIC_API_KEY: 'sk-ant-x' }), SLOTS);
    expect(reader.resolve('ANTHROPIC_API_KEY')).toBe('sk-ant-x');
  });

  it('refuses every other name, including one the vault holds', () => {
    const reader = providerKeySlotReader(makeStore({ ANTHROPIC_API_KEY: 'sk', HR_PAYROLL: 'pay' }), SLOTS);
    expect(reader.resolve('HR_PAYROLL')).toBeNull();
  });

  it('bounds the REAL set spawn.ts passes, not just the closure', async () => {
    // The refused name is chosen independently of the set under test. A control
    // whose membership is derived from the subject — filtering asked-for names by
    // the same set the implementation filters by — is empty by construction and
    // passes against any implementation, including none.
    const { PROVIDER_KEY_SLOTS } = await import('../core/llm/provider-keys.js');
    const reader = providerKeySlotReader(
      makeStore({ ANTHROPIC_API_KEY: 'sk-ant-x', HR_PAYROLL: 'pay' }),
      PROVIDER_KEY_SLOTS,
    );
    expect(reader.resolve('ANTHROPIC_API_KEY')).toBe('sk-ant-x');
    expect(reader.resolve('HR_PAYROLL')).toBeNull();
  });

  // Residue, stated rather than glossed: that `spawn.ts` hands this reader to
  // `resolveProviderApiKey` instead of the parent's store is one line of wiring,
  // verified by reading. A test could only see it by mocking the provider-key
  // module, and the previous attempt to catch it by watching which names get
  // asked was vacuous twice over — the default routing path never calls the
  // closure at all, and the names it would ask for are members of the set either
  // way.
});

describe('narrowVaultScope — a scope never widens on the way down', () => {
  it('an unscoped agent may grant the full vault', () => {
    expect(narrowVaultScope(VAULT_SCOPE_ALL, VAULT_SCOPE_ALL)).toEqual({ scope: VAULT_SCOPE_ALL });
  });

  it('a SCOPED agent may not — and the refusal names why', () => {
    const r = narrowVaultScope(['STRIPE_KEY'], VAULT_SCOPE_ALL);
    expect(r).toHaveProperty('refusal');
    expect((r as { refusal: string }).refusal).toMatch(/never widens/);
    expect((r as { refusal: string }).refusal).toMatch(/STRIPE_KEY/);
  });

  it('a subset passes', () => {
    expect(narrowVaultScope(['A', 'B'], ['A'])).toEqual({ scope: ['A'] });
  });

  it('a superset is refused and the refusal names the offending key, not just "denied"', () => {
    const r = narrowVaultScope(['A'], ['A', 'B']) as { refusal: string };
    expect(r.refusal).toContain('B');
    expect(r.refusal).not.toContain('A, B');
  });

  it('two hops cannot launder what one hop is refused', () => {
    const first = narrowVaultScope(VAULT_SCOPE_ALL, ['A']) as { scope: readonly string[] };
    const second = narrowVaultScope(first.scope, ['A', 'B']);
    expect(second).toHaveProperty('refusal');
  });
});

describe('vaultScopeOf', () => {
  it('an unwrapped store is the full vault — the root agent owns it', () => {
    expect(vaultScopeOf(makeStore(VAULT))).toBe(VAULT_SCOPE_ALL);
    expect(vaultScopeOf(undefined)).toBe(VAULT_SCOPE_ALL);
  });

  it('a scoped view reports its own scope back, so the next hop can be checked', () => {
    expect(vaultScopeOf(scopeSecretStore(makeStore(VAULT), ['STRIPE_KEY']))).toEqual(['STRIPE_KEY']);
  });

  it('scoping to "all" is the identity — an unscoped spawn behaves exactly as before', () => {
    const inner = makeStore(VAULT);
    expect(scopeSecretStore(inner, VAULT_SCOPE_ALL)).toBe(inner);
  });
});
