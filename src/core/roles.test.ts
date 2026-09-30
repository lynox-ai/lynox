import { describe, it, expect } from 'vitest';
import { BUILTIN_ROLES, getRole, applyTierGate, READ_ONLY_TOOL_SURFACE, roleToolProfile, statedToolGrant, type RoleConfig } from './roles.js';
import { resolveTools } from '../tools/resolve-tools.js';
import type { ToolEntry } from '../types/index.js';

describe('BUILTIN_ROLES', () => {
  it('researcher defaults to balanced — deep is an opt-in override', () => {
    // The 2026-04-21 rebalance moved researcher off Opus-by-default.
    // Bench (see project_bench_phase_1_verdict) showed Sonnet with
    // adaptive-thinking matches Opus on deep-research at a fraction of
    // the cost. Any tenant can still pass `model: 'deep'` — the capability
    // gate was retired (D8); the budget controls cost, not a tier lock.
    expect(BUILTIN_ROLES['researcher']!.model).toBe('balanced');
    expect(BUILTIN_ROLES['researcher']!.effort).toBe('max');
    expect(BUILTIN_ROLES['researcher']!.denyTools).toContain('write_file');
    expect(BUILTIN_ROLES['researcher']!.denyTools).toContain('bash');
  });

  it('creator/operator/collector defaults unchanged', () => {
    expect(BUILTIN_ROLES['creator']!.model).toBe('balanced');
    expect(BUILTIN_ROLES['operator']!.model).toBe('fast');
    expect(BUILTIN_ROLES['collector']!.model).toBe('fast');
  });

  it('collector can fetch + read — the engine recommends it to work large payloads in isolation', () => {
    // The truncation hints in fs.ts (large files), http.ts (large API responses)
    // and the web-fetch path actively tell the model to spawn role='collector' to
    // work a payload too big for the main context in isolation. allowTools is
    // hard-enforced as a whitelist (resolve-tools.ts), so a missing entry is a
    // silent hole — a collector without the tool a hint recommends cannot do the
    // job it was spawned for.
    const allow = BUILTIN_ROLES['collector']!.allowTools!;
    expect(allow).toContain('read_file');
    expect(allow).toContain('http_request');
    expect(allow).toContain('web_research');
    // Stays read-only — none of the destructive or system tools.
    expect(allow).not.toContain('write_file');
    expect(allow).not.toContain('edit_file');
    expect(allow).not.toContain('bash');
  });

  it('getRole returns the named role, undefined on miss', () => {
    expect(getRole('researcher')?.model).toBe('balanced');
    expect(getRole('nonexistent')).toBeUndefined();
    // Inherited keys are a miss too. They were not: a bracket read on an object literal
    // reaches `Object.prototype`, so these three came back truthy and every guard of the
    // form `!getRole(name)` let them through as KNOWN roles.
    for (const inherited of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(getRole(inherited), inherited).toBeUndefined();
    }
    // The control for the line above: a real name still resolves, so this is a
    // prototype test and not `getRole` returning undefined for everything.
    expect(getRole('collector')).toBeDefined();
  });
});

describe('applyTierGate (retired to a pass-through — D8 2026-06-17)', () => {
  // The deep-tier capability gate is RETIRED: no tier-band gating, the included
  // budget + per-model cost transparency control spend. Every account now gets
  // its requested tier unchanged; only an absent override falls through.
  it('passes deep through for a pro account', () => {
    expect(applyTierGate('deep', 'pro')).toBe('deep');
  });

  it('passes deep through for a standard account (gate retired — no downgrade)', () => {
    expect(applyTierGate('deep', 'standard')).toBe('deep');
  });

  it('passes deep through when account_tier is unset (self-host / BYOK)', () => {
    expect(applyTierGate('deep', undefined)).toBe('deep');
  });

  it('passes balanced and fast through untouched for any tier', () => {
    expect(applyTierGate('balanced', 'standard')).toBe('balanced');
    expect(applyTierGate('balanced', 'pro')).toBe('balanced');
    expect(applyTierGate('fast', 'standard')).toBe('fast');
    expect(applyTierGate('fast', 'pro')).toBe('fast');
  });

  it('returns undefined when no override was requested (use the role default)', () => {
    expect(applyTierGate(undefined, 'standard')).toBeUndefined();
    expect(applyTierGate(undefined, 'pro')).toBeUndefined();
  });
});

/**
 * A role that promises read-only must be granted by an ALLOWLIST.
 *
 * `description` is not model-facing — nothing in src reads `RoleConfig.description`
 * (swept 2026-09-30), so these tests are not about a string the model is shown. The
 * description is what the next author reads when they decide what a role is for, and
 * a role whose stated shape and enforced shape disagree is how the enforced one drifts.
 */
describe('read-only roles are granted by an allowlist', () => {
  const UNQUALIFIED_READ_ONLY = /read[\s-]?only/i;

  it('every role whose description claims read-only carries readOnly: true', () => {
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      if (!UNQUALIFIED_READ_ONLY.test(role.description)) continue;
      expect(
        role.readOnly,
        `role "${name}" says read-only in its description but is granted by subtraction`,
      ).toBe(true);
    }
    // Not vacuous — and `>=` rather than `=== 2`, because a third role that correctly
    // states read-only AND carries the flag is the wanted outcome, not a failure. What
    // must not drop to zero is the number of roles that reach the assert at all.
    const claiming = Object.entries(BUILTIN_ROLES)
      .filter(([, r]) => UNQUALIFIED_READ_ONLY.test(r.description))
      .map(([name]) => name);
    expect(claiming.length).toBeGreaterThanOrEqual(2);
    expect(claiming).toContain('researcher');
    expect(claiming).toContain('operator');
  });

  it('the description check can fail — a violating role is detected', () => {
    // The guard above is only worth its line if it rejects something. Same predicate,
    // a role shaped exactly like the mistake it exists to catch.
    const violator: RoleConfig = {
      model: 'fast', effort: 'low', autonomy: 'guided',
      denyTools: ['write_file', 'bash'],
      description: 'Looks around and reports. Read-only.',
    };
    expect(UNQUALIFIED_READ_ONLY.test(violator.description)).toBe(true);
    expect(violator.readOnly).toBeUndefined();
  });

  it('collector claims no more than it keeps — it writes to memory and calls out', () => {
    const collector = BUILTIN_ROLES['collector']!;
    expect(collector.readOnly).toBeUndefined();
    expect(UNQUALIFIED_READ_ONLY.test(collector.description)).toBe(false);
    // The three named exceptions are the reason it cannot carry the flag.
    for (const t of ['memory_store', 'remember', 'http_request']) {
      expect(collector.allowTools).toContain(t);
      expect(READ_ONLY_TOOL_SURFACE).not.toContain(t);
    }
  });

  it('the surface holds no tool that changes what a later run sees', () => {
    // One per shape, not an exhaustive list: filesystem, shell, vault, durable memory,
    // records, thread state, workflow mutation, media output, arbitrary HTTP verbs.
    for (const t of [
      'write_file', 'edit_file', 'batch_files', 'bash',
      'ask_secret', 'api_setup',
      'remember', 'memory_store', 'memory_block_edit', 'memory_retire', 'memory_update',
      'memory_delete', 'memory_promote',
      'contacts_save', 'data_store_insert', 'data_store_create', 'data_store_drop',
      'data_store_delete',
      // Both were candidates that read as pure and are not: `memory_focus` sets the
      // engine-scoped focus every later render falls back to, `ask_user` parks a
      // trigger and pushes a notification on the worker-loop path.
      'memory_focus', 'ask_user',
      'artifact_save', 'artifact_restore', 'artifact_delete',
      'task_create', 'task_update', 'plan_task',
      'set_thread_context', 'subjects_merge',
      'run_workflow', 'save_workflow', 'import_workflow', 'update_workflow_steps',
      'media_process', 'http_request', 'spawn_agent',
    ]) {
      expect(READ_ONLY_TOOL_SURFACE, `${t} must not be in the read-only surface`).not.toContain(t);
    }
  });

  it('a readOnly role never resolves to an EMPTY ceiling', () => {
    // `resolveTools` fails closed on `readOnly` with no `allowedTools` — it grants
    // nothing. That is the right direction for an unfilled ceiling and the wrong
    // outcome for a real role, so the two must not be confusable: every readOnly role
    // has to arrive with a non-empty one.
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      if (role.readOnly !== true) continue;
      const profile = roleToolProfile(role);
      expect(profile.allowedTools, `role "${name}" would resolve to no tools at all`)
        .not.toHaveLength(0);
    }
    expect(READ_ONLY_TOOL_SURFACE.length).toBeGreaterThan(5);
  });

  it('a readOnly role that also names allowTools is narrowed to the intersection', () => {
    // No built-in role has this shape, which is why the direction matters more than
    // the occurrence: widening to the whole surface would hand a role more than its
    // own list asks for, and the ceiling would still hold while the role's stated
    // grant no longer did.
    const both = roleToolProfile({
      model: 'fast', effort: 'high', autonomy: 'guided', readOnly: true,
      allowTools: ['read_file', 'bash'],
      description: 'Narrow reader. Read-only.',
    });
    expect(both.allowedTools).toEqual(['read_file']);
    // `bash` is dropped because it is not in the surface, `read_file` survives because
    // it is in both — so the assert above is an intersection, not either input.
    expect(READ_ONLY_TOOL_SURFACE).toContain('read_file');
    expect(READ_ONLY_TOOL_SURFACE).not.toContain('bash');
  });

  it('roleToolProfile turns readOnly into the surface, and leaves other roles alone', () => {
    const operator = roleToolProfile(BUILTIN_ROLES['operator']!);
    expect(operator.allowedTools).toEqual([...READ_ONLY_TOOL_SURFACE]);
    // Carried, not just derived: `resolveTools` reads this to treat the allowlist as a
    // ceiling an explicit tool list cannot step around.
    expect(operator.readOnly).toBe(true);
    // denyTools survives the switch — it applies after the allowlist, as a second cut.
    expect(operator.deniedTools).toEqual(['write_file']);

    const researcher = roleToolProfile(BUILTIN_ROLES['researcher']!);
    expect(researcher.allowedTools).toEqual([...READ_ONLY_TOOL_SURFACE]);

    // A role with an explicit list keeps it verbatim — the surface does not leak in.
    const collector = roleToolProfile(BUILTIN_ROLES['collector']!);
    expect(collector.allowedTools).toEqual([...BUILTIN_ROLES['collector']!.allowTools!]);

    // A role with neither gets no allowlist at all (still a denylist role).
    const creator = roleToolProfile(BUILTIN_ROLES['creator']!);
    expect(creator.allowedTools).toBeUndefined();
    expect(creator.deniedTools).toEqual(['bash']);
  });
});

/**
 * The grant is a promise in the text the NEXT AUTHOR reads — `description` is not
 * model-facing, per the dated sweep above — and the route it is kept on is
 * `resolveTools`. A role whose stated shape and enforced shape disagree is how the
 * enforced one drifts, which is why the two are asserted together.
 *
 * The claim is asserted over the SET of built-in roles rather than at the role the
 * finding named: keyed on `denyTools` the set would be three roles and would miss
 * `collector`, which states its grant as an allowlist and denies nothing.
 */
describe("a role's stated grant binds whether or not the caller names the tool", () => {
  /**
   * The parent surface, derived from the roles themselves plus the three tools a role
   * withholds by name — so a role that starts naming a new tool is covered here without
   * this list being edited.
   */
  const PARENT_NAMES: string[] = [...new Set([
    ...Object.values(BUILTIN_ROLES).flatMap(r => [...(r.allowTools ?? []), ...(r.denyTools ?? [])]),
    ...READ_ONLY_TOOL_SURFACE,
    'bash', 'write_file', 'task_list',
  ])];

  const parentTools: ToolEntry[] = PARENT_NAMES.map(name => ({
    definition: { name, description: name, input_schema: { type: 'object' as const, properties: {} } },
    handler: async () => name,
  }));
  const names = (entries: ToolEntry[]): string[] => entries.map(t => t.definition.name);

  /** What the role's own grant shape says the child does not get. */
  const withheldBy = (role: RoleConfig): string[] => {
    const outsideAllowlist = role.allowTools
      ? PARENT_NAMES.filter(n => !role.allowTools!.includes(n))
      : role.readOnly === true
        ? PARENT_NAMES.filter(n => !READ_ONLY_TOOL_SURFACE.includes(n))
        : [];
    return [...new Set([...(role.denyTools ?? []), ...outsideAllowlist])];
  };

  it.each(Object.keys(BUILTIN_ROLES))('%s', (name) => {
    const role = BUILTIN_ROLES[name]!;
    const withheld = withheldBy(role);
    // The case has to exist for this role, or the two asserts below pass on an empty
    // set and say nothing at all.
    expect(withheld.length, `role "${name}" withholds nothing — nothing to bind`)
      .toBeGreaterThan(0);

    const profile = roleToolProfile(role);
    const viaProfile = names(resolveTools(undefined, profile, parentTools));
    expect(viaProfile.filter(n => withheld.includes(n))).toEqual([]);
    // The route the finding was about: the caller names exactly what the role withholds.
    expect(names(resolveTools(withheld, profile, parentTools))).toEqual([]);

    // Positive control on the same route, because an empty result is also what a
    // resolver that grants nothing at all returns: what the role DOES grant still
    // arrives when the caller asks for it.
    const granted = viaProfile[0];
    expect(granted, `role "${name}" resolves to no tools at all`).toBeDefined();
    expect(names(resolveTools([granted!], profile, parentTools))).toEqual([granted]);
  });

  it('creator keeps the sentence its description makes', () => {
    const creator = BUILTIN_ROLES['creator']!;
    // The sentence is read by the next author, not by the model (see the sweep above),
    // and that is exactly why it is pinned to the behaviour: prose nobody enforces drifts
    // from the code, and here the drift would be a role that reads stricter than it is.
    expect(creator.description).toContain('No system commands');
    expect(creator.denyTools).toContain('bash');

    const profile = roleToolProfile(creator);
    expect(names(resolveTools(['bash'], profile, parentTools))).toEqual([]);
    // Same call shape, a tool the role does not withhold — so the line above is the
    // denylist holding and not the call failing.
    expect(names(resolveTools(['read_file'], profile, parentTools))).toEqual(['read_file']);
  });
});

/**
 * The predicate a runtime that cannot KEEP a role's tool grant refuses on. Asserted
 * here rather than through a step, because the refusal's effect is a throw and the
 * claim is about the reading: which roles state something about tools, and which field
 * the message will name.
 */
describe('statedToolGrant', () => {
  it('reads all three shapes as one promise, and names the field it read', () => {
    expect(statedToolGrant(BUILTIN_ROLES['operator']!)).toBe('is read-only');
    expect(statedToolGrant(BUILTIN_ROLES['creator']!)).toBe('denies bash');
    expect(statedToolGrant(BUILTIN_ROLES['collector']!))
      .toBe(`grants only ${BUILTIN_ROLES['collector']!.allowTools!.join(', ')}`);
  });

  it('says nothing for a role that states nothing about tools', () => {
    // The negative half, and the one that keeps a caller from reading the predicate as
    // "has a role": model, effort and autonomy are not a tool grant.
    expect(statedToolGrant({
      model: 'balanced', effort: 'high', autonomy: 'guided',
      description: 'A tier and an effort, and nothing about tools.',
    })).toBeNull();
  });

  it('prefers the flag, then the allowlist — a decision, not an accident', () => {
    // A role with more than one of the three gets ONE phrase, so the order is pinned:
    // `researcher` carries the flag AND a denylist, and the flag is the wider statement.
    expect(statedToolGrant(BUILTIN_ROLES['researcher']!)).toBe('is read-only');
    expect(statedToolGrant({
      model: 'fast', effort: 'low', autonomy: 'guided',
      allowTools: ['read_file'], denyTools: ['bash'],
      description: 'Both lists.',
    })).toBe('grants only read_file');
  });

  it('holds for EVERY built-in role — none of the four is keepable on a foreign namespace', () => {
    // The consequence, stated where it can go red: all four built-ins state a grant, so
    // a step on the agent runtime that declares any of them is refused. A fifth role
    // added without a tool grant would be legal there, and this assert would tell the
    // author which one it is.
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      expect(statedToolGrant(role), `role "${name}" states nothing about tools`).not.toBeNull();
    }
    expect(Object.keys(BUILTIN_ROLES)).toHaveLength(4);
  });
});
