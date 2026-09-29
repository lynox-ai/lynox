import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { BUILTIN_ROLES, READ_ONLY_TOOL_SURFACE, roleToolProfile } from './roles.js';
import { resolveTools } from '../tools/resolve-tools.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * What a `readOnly` role resolves to, measured against the REAL registry.
 *
 * `roles.test.ts` pins the surface and the mapping; `spawn.test.ts` and
 * `runtime-adapter.test.ts` pin the two grant paths against a handful of stub tools.
 * None of them can see the registry, and the registry is where the tools a role must
 * not receive actually come from — a unit test handed a three-tool parent set proves
 * nothing about the ~40 a booted engine registers. So: a real Engine against a tmp
 * data dir, `init()` called directly, the shape of `datastore-tools-boot.test.ts`.
 */

/** Registered unconditionally in `Engine.init()` — no flag, no integration. */
const ALWAYS_REGISTERED_SURFACE_MEMBERS = [
  'read_file', 'recall_tool_result', 'task_list', 'ask_user', 'suggest_follow_ups',
  'diagnose_workflow_run', 'export_workflow', 'data_store_query', 'data_store_list',
] as const;

describe('Engine boot — a readOnly role resolves inside the read-only surface', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function boot(): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-roboot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('grants operator nothing outside the surface, out of the whole registry', async () => {
    const engine = await boot();
    const registry = engine.getRegistry().getEntries();
    // A real registry, not a stub: the assert below is only worth its line if the
    // parent set is large enough to contain something a subtraction would miss.
    expect(registry.length).toBeGreaterThan(20);

    const operator = BUILTIN_ROLES['operator']!;
    expect(operator.readOnly, 'the autonomous role must be granted by allowlist').toBe(true);
    const granted = resolveTools(undefined, roleToolProfile(operator), registry)
      .map(t => t.definition.name);

    const outside = granted.filter(n => !READ_ONLY_TOOL_SURFACE.includes(n));
    expect(outside, `operator was granted tools outside the read-only surface: ${outside.join(', ')}`)
      .toEqual([]);
    // Not vacuous by emptiness: the grant still carries the read side.
    expect(granted).toContain('read_file');
    expect(granted.length).toBeGreaterThan(4);
  });

  it('a subtractive grant over the same registry carries a shell', async () => {
    // The CONTROL for the assert above, and it has to come from the real registry:
    // "no tool outside the surface" means nothing unless such tools are reachable at all.
    // A grant expressed as `denyTools` alone, over a registry this size, is how.
    const engine = await boot();
    const registry = engine.getRegistry().getEntries();
    const subtractive = resolveTools(
      undefined,
      { deniedTools: [...(BUILTIN_ROLES['operator']!.denyTools ?? [])] },
      registry,
    ).map(t => t.definition.name);

    expect(subtractive).toContain('bash');
    expect(subtractive).toContain('edit_file');
    expect(subtractive).toContain('batch_files');
    // …and the allowlist grant of the same role holds none of them.
    const granted = resolveTools(undefined, roleToolProfile(BUILTIN_ROLES['operator']!), registry)
      .map(t => t.definition.name);
    // The three above plus the outward-facing ones. These are negative asserts, so a
    // configuration where an integration does not register simply makes them vacuous —
    // never false. The positive control above stays on the three unconditional tools.
    for (const t of [
      'bash', 'edit_file', 'batch_files', 'ask_secret', 'api_setup',
      'mail_send', 'mail_reply', 'google_docs', 'google_sheets',
      'artifact_save', 'contacts_save', 'run_workflow', 'memory_store',
    ]) {
      expect(granted, `${t} must not reach a readOnly role`).not.toContain(t);
    }
    expect(subtractive.length).toBeGreaterThan(granted.length);
  });

  it('every unconditionally-registered surface member is spelled like a real tool', async () => {
    // The surface is an allowlist, so a typo is inert rather than loud — it silently
    // withholds a tool instead of granting one. These nine carry no flag and no
    // integration, so their absence from a booted registry can only be a misspelling.
    const engine = await boot();
    const names = new Set(engine.getRegistry().getEntries().map(e => e.definition.name));
    for (const t of ALWAYS_REGISTERED_SURFACE_MEMBERS) {
      expect(READ_ONLY_TOOL_SURFACE, `${t} must be in the surface`).toContain(t);
      expect([...names], `${t} is in the surface but is not a registered tool name`).toContain(t);
    }
  });

  it('researcher, the other readOnly role, resolves the same way', async () => {
    const engine = await boot();
    const registry = engine.getRegistry().getEntries();
    const granted = resolveTools(undefined, roleToolProfile(BUILTIN_ROLES['researcher']!), registry)
      .map(t => t.definition.name);
    const outside = granted.filter(n => !READ_ONLY_TOOL_SURFACE.includes(n));
    expect(outside, `researcher was granted: ${outside.join(', ')}`).toEqual([]);
    expect(granted).toContain('web_research');
    expect(granted).toContain('read_file');
  });
});
