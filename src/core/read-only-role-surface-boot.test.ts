import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { BUILTIN_ROLES, READ_ONLY_TOOL_SURFACE, roleToolProfile } from './roles.js';
import { resolveTools } from '../tools/resolve-tools.js';
import type { LynoxConfig, ToolEntry } from '../types/index.js';

/**
 * What a `readOnly` role resolves to, measured against the REAL registry.
 *
 * `roles.test.ts` pins the surface and the mapping; `spawn.test.ts` and
 * `runtime-adapter.test.ts` pin the grant paths against a handful of stub tools.
 * None of them can see the registry, and the registry is where the tools a role must
 * not receive actually come from — a unit test handed a three-tool parent set proves
 * nothing about the ~50 a booted engine registers. So: a real Engine against a tmp
 * data dir, `init()` called directly, the shape of `datastore-tools-boot.test.ts`.
 */

/**
 * Registered with no flag, no integration and no best-effort guard around them:
 * `engine.ts` registers the first five in the opening chain and the last two from
 * `registerPipelineTools()`. `data_store_query`/`data_store_list` are deliberately
 * NOT here — they come from `registerDataStoreTools()` inside the DataStore's
 * best-effort try, so a store that fails to initialise legitimately has neither.
 */
const ALWAYS_REGISTERED_SURFACE_MEMBERS = [
  'read_file', 'recall_tool_result', 'task_list', 'suggest_follow_ups',
  'diagnose_workflow_run', 'export_workflow',
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

  async function bootRegistry(): Promise<ToolEntry[]> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-roboot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine.getRegistry().getEntries();
  }

  const grantOf = (roleName: string, registry: ToolEntry[]): string[] =>
    resolveTools(undefined, roleToolProfile(BUILTIN_ROLES[roleName]!), registry)
      .map(t => t.definition.name);

  it('grants operator nothing outside the surface, out of the whole registry', async () => {
    const registry = await bootRegistry();
    // A real registry, not a stub: the assert below is only worth its line if the
    // parent set is large enough to contain something a subtraction would miss.
    expect(registry.length).toBeGreaterThan(20);

    expect(BUILTIN_ROLES['operator']!.readOnly, 'the autonomous role is granted by allowlist')
      .toBe(true);
    const granted = grantOf('operator', registry);
    const outside = granted.filter(n => !READ_ONLY_TOOL_SURFACE.includes(n));
    expect(outside, `operator was granted tools outside the read-only surface: ${outside.join(', ')}`)
      .toEqual([]);
    // Not vacuous by emptiness: the grant still carries the read side.
    expect(granted).toContain('read_file');
    expect(granted.length).toBeGreaterThan(4);
  });

  it('grants no tool the registry itself marks destructive or confirmation-worthy', async () => {
    // The SECOND reference, and the reason it exists: the assert above measures the
    // grant against READ_ONLY_TOOL_SURFACE, so an edit to that list satisfies it — the
    // reference is computed from the thing under test. These flags are not. Each one is
    // set by its own tool's author, in that tool's file, with no knowledge of this
    // surface, so adding a name to the surface cannot make this pass.
    //
    // It is NOT a complete net — `bash` and `write_file` carry neither flag, which is
    // why the enumerated list in `roles.test.ts` stays. Two partial references that
    // cannot be satisfied from the same place beat one that can.
    const registry = await bootRegistry();
    const flagged = registry.filter(
      e => e.destructive !== undefined || e.requiresConfirmation !== undefined,
    );
    expect(flagged.length, 'no tool carries the flags — this control is not measuring anything')
      .toBeGreaterThan(5);

    for (const role of ['operator', 'researcher']) {
      const granted = grantOf(role, registry);
      for (const e of flagged) {
        expect(granted, `${role} must not be granted ${e.definition.name}, which declares itself destructive`)
          .not.toContain(e.definition.name);
      }
    }
  });

  it('a grant expressed as a denylist over the same registry carries a shell', async () => {
    // The CONTROL for the subset assert, and it has to come from the real registry:
    // "no tool outside the surface" means nothing unless such tools are reachable at
    // all. The denylist here is written in this test rather than read off a role, so
    // what it demonstrates is a property of that SHAPE over a registry this size.
    const registry = await bootRegistry();
    const subtractive = resolveTools(undefined, { deniedTools: ['write_file'] }, registry)
      .map(t => t.definition.name);
    expect(subtractive).toContain('bash');
    expect(subtractive).toContain('edit_file');
    expect(subtractive).toContain('batch_files');
    expect(subtractive).not.toContain('write_file');

    const granted = grantOf('operator', registry);
    // Negative asserts, so a configuration where an integration does not register
    // makes them vacuous rather than false. The positive control above stays on the
    // three tools that carry no condition.
    for (const t of [
      'bash', 'edit_file', 'batch_files', 'ask_secret', 'api_setup', 'ask_user',
      'mail_send', 'mail_reply', 'google_docs', 'google_sheets',
      'artifact_save', 'contacts_save', 'run_workflow', 'memory_store', 'memory_focus',
      'data_store_insert', 'data_store_delete', 'data_store_drop',
    ]) {
      expect(granted, `${t} must not reach a readOnly role`).not.toContain(t);
    }
    expect(subtractive.length).toBeGreaterThan(granted.length);
  });

  it('every unconditionally-registered surface member is spelled like a real tool', async () => {
    // The surface is an allowlist, so a typo is inert rather than loud — it silently
    // withholds a tool instead of granting one. These six carry no flag, no
    // integration and no best-effort guard, so their absence from a booted registry
    // can only be a misspelling.
    const registry = await bootRegistry();
    const names = registry.map(e => e.definition.name);
    for (const t of ALWAYS_REGISTERED_SURFACE_MEMBERS) {
      expect(READ_ONLY_TOOL_SURFACE, `${t} must be in the surface`).toContain(t);
      expect(names, `${t} is in the surface but is not a registered tool name`).toContain(t);
    }
  });

  it('researcher, the other readOnly role, resolves the same way', async () => {
    const registry = await bootRegistry();
    const granted = grantOf('researcher', registry);
    const outside = granted.filter(n => !READ_ONLY_TOOL_SURFACE.includes(n));
    expect(outside, `researcher was granted: ${outside.join(', ')}`).toEqual([]);
    expect(granted).toContain('web_research');
    expect(granted).toContain('read_file');
  });
});
