import { describe, it, expect } from 'vitest';
import { BUILTIN_ROLES, getRole, applyTierGate, READ_ONLY_TOOL_SURFACE, roleToolProfile, type RoleConfig } from './roles.js';

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
    // Not vacuous: two roles reach the assert above.
    const claiming = Object.values(BUILTIN_ROLES).filter(r => UNQUALIFIED_READ_ONLY.test(r.description));
    expect(claiming.length).toBe(2);
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
      'artifact_save', 'artifact_restore', 'artifact_delete',
      'task_create', 'task_update', 'plan_task',
      'set_thread_context', 'subjects_merge',
      'run_workflow', 'save_workflow', 'import_workflow', 'update_workflow_steps',
      'media_process', 'http_request', 'spawn_agent',
    ]) {
      expect(READ_ONLY_TOOL_SURFACE, `${t} must not be in the read-only surface`).not.toContain(t);
    }
  });

  it('roleToolProfile turns readOnly into the surface, and leaves other roles alone', () => {
    const operator = roleToolProfile(BUILTIN_ROLES['operator']!);
    expect(operator.allowedTools).toEqual([...READ_ONLY_TOOL_SURFACE]);
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
