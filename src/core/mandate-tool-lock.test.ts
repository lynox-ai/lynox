import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { INSTANCE_WRITE_SITES, MANDATE_INSIDE_NON_WRITERS, MANDATE_INSIDE_WRITERS, MANDATE_OUTWARD_READERS, MANDATE_PATTERN_WRITE_TOOLS, MANDATE_TOOL_SURFACE, MANDATE_WITHHELD_TOOLS, mandateWithheldReason, toolLockFor } from './mandate-tool-lock.js';
import type { MailRegistry } from '../integrations/mail/tools/registry.js';
import type { SearchProvider } from '../integrations/search/search-provider.js';
import type { ToolEntry } from '../types/index.js';
import { createMailReadTool } from '../integrations/mail/tools/mail-read.js';
import { createMailSearchTool } from '../integrations/mail/tools/mail-search.js';
import { createMailTriageTool } from '../integrations/mail/tools/mail-triage.js';
import { createMailSendTool } from '../integrations/mail/tools/mail-send.js';
import { createMailReplyTool } from '../integrations/mail/tools/mail-reply.js';
import { createMailConnectTool } from '../integrations/mail/tools/mail-connect.js';
import { createSheetsTool } from '../integrations/google/google-sheets.js';
import { createDocsTool } from '../integrations/google/google-docs.js';
import { createDriveTool } from '../integrations/google/google-drive.js';
import { createCalendarTool } from '../integrations/google/google-calendar.js';
import { createWebSearchTool } from '../integrations/search/web-search-tool.js';
import { calendarReadTool } from '../tools/builtin/calendar.js';
import { NO_WEB_SEARCH_PROMPT_SUFFIX } from './prompts.js';
import * as builtinTools from '../tools/builtin/index.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import type { LynoxConfig } from '../types/index.js';

describe('toolLockFor', () => {
  it('locks a mandate to the surface without the pattern writers and leaves the owner unlocked', () => {
    const lock = toolLockFor({ kind: 'mandate', email: 'setup@example.org' });
    const pattern = Object.keys(MANDATE_PATTERN_WRITE_TOOLS);
    expect([...lock!].sort()).toEqual([...MANDATE_TOOL_SURFACE].filter(n => !pattern.includes(n)).sort());
    expect(toolLockFor(OWNER_PRINCIPAL)).toBeNull();
  });

  // 660a-2: the sign-in refuses a mandate on an engine with the legacy memory, but its plan
  // runs later under the mandate — the lock is the one place every turn of it passes.
  it('holds back the three pattern writers from a mandate, each with its reason, though they stay on the surface', () => {
    const lock = toolLockFor({ kind: 'mandate', email: 'setup@example.org' })!;
    expect(Object.keys(MANDATE_PATTERN_WRITE_TOOLS).sort()).toEqual(['memory_delete', 'memory_promote', 'memory_update']);
    for (const name of ['memory_delete', 'memory_update', 'memory_promote']) {
      expect(lock.has(name), name).toBe(false);
      expect(MANDATE_TOOL_SURFACE.has(name), name).toBe(true);
      expect(mandateWithheldReason(name), name).toBe(MANDATE_PATTERN_WRITE_TOOLS[name]);
    }
    // control: the other memory tools stay, and a withheld tool keeps its own reason
    for (const name of ['memory_store', 'memory_recall', 'memory_list']) expect(lock.has(name), name).toBe(true);
    expect(mandateWithheldReason('bash')).toBe(MANDATE_WITHHELD_TOOLS['bash']);
    expect(mandateWithheldReason('memory_store')).toBeUndefined();
  });

  it('withholds what D1 names: the shell and every tool that reads or writes the process filesystem', () => {
    for (const name of ['bash', 'read_file', 'write_file', 'edit_file', 'batch_files']) {
      expect(MANDATE_TOOL_SURFACE.has(name), name).toBe(false);
      expect(MANDATE_WITHHELD_TOOLS[name], name).toBeDefined();
    }
  });

  it('places no tool on both lists', () => {
    for (const name of Object.keys(MANDATE_WITHHELD_TOOLS)) expect(MANDATE_TOOL_SURFACE.has(name), name).toBe(false);
  });

  // The focus override holds for every session of the instance, the owner's included,
  // so a mandate does not get the tool; the owner keeps it (no lock).
  it('withholds memory_focus from a mandate, with its reason, and leaves it to the owner', () => {
    expect(MANDATE_TOOL_SURFACE.has('memory_focus')).toBe(false);
    expect(toolLockFor({ kind: 'mandate', email: 'setup@example.org' })?.has('memory_focus')).toBe(false);
    expect(MANDATE_WITHHELD_TOOLS['memory_focus']).toBe('sets the knowledge focus for every session of the instance');
    expect(toolLockFor(OWNER_PRINCIPAL)).toBeNull();
  });
});

/**
 * Measured against the REAL registry of a booted engine (the shape of
 * read-only-role-surface-boot.test.ts): every tool the engine registers is either on the
 * surface or withheld with a reason. A tool the engine starts registering tomorrow fails
 * here until someone places it — the allowlist keeps it from mandates meanwhile, and this
 * makes that a decision rather than an accident.
 */
describe('Engine boot — every registered tool is classified for mandates', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('classifies the whole registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandate-lock-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const names = engine.getRegistry().getEntries().map(e => e.definition.name);
    // A real registry: the check is only worth its line if the set is large.
    expect(names.length).toBeGreaterThan(20);
    const unplaced = names.filter(n => !MANDATE_TOOL_SURFACE.has(n) && MANDATE_WITHHELD_TOOLS[n] === undefined);
    expect(unplaced, 'place each new tool on MANDATE_TOOL_SURFACE or MANDATE_WITHHELD_TOOLS').toEqual([]);
    // And the withheld ones are really there to withhold, so the list is not stale.
    for (const name of ['bash', 'read_file', 'write_file', 'edit_file', 'batch_files']) expect(names, name).toContain(name);
  });
});

/**
 * What a mandate's tools read outside the instance (PRD customer-granted-operator-access §3.9),
 * checked on the tools themselves: the booted registry, plus the integration tools a booted
 * engine registers only once an account is connected, built here as it builds them. Every name
 * on the surface must be a real tool, and a tool declares `outwardRead` exactly when it is on
 * `MANDATE_OUTWARD_READERS` — so a new reading tool is not placed by being named.
 */
describe('Engine boot — every tool a mandate may use is placed for what it reads outside', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function surfaceTools(): Promise<Map<string, ToolEntry<never>>> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandate-reach-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const noAuth = (): null => null;
    const mail = {} as MailRegistry;
    const provider = { name: 'test', search: async () => [] } as unknown as SearchProvider;
    const integrations = [
      createMailReadTool(mail), createMailSearchTool(mail), createMailTriageTool(mail), createMailSendTool(mail),
      createMailReplyTool(mail), createMailConnectTool(),
      createSheetsTool(noAuth), createDocsTool(noAuth), createDriveTool(noAuth), createCalendarTool(noAuth),
      createWebSearchTool(provider), calendarReadTool,
    ] as unknown as Array<ToolEntry<never>>;
    // The builtins a booted engine registers only behind a switch (durable memory, bulk runs,
    // the subject store), taken from the catalog itself.
    const catalog = Object.values(builtinTools).filter((v): v is ToolEntry<never> =>
      typeof v === 'object' && v !== null && typeof (v as { definition?: { name?: unknown } }).definition?.name === 'string');
    const all = new Map<string, ToolEntry<never>>();
    for (const t of [...engine.getRegistry().getEntries() as unknown as Array<ToolEntry<never>>, ...catalog, ...integrations]) all.set(t.definition.name, t);
    // A real registry: the check is only worth its line if the set is large.
    expect(all.size).toBeGreaterThan(40);
    return all;
  }

  it('names no tool on the surface that does not exist', async () => {
    const all = await surfaceTools();
    const phantom = [...MANDATE_TOOL_SURFACE].filter(n => !all.has(n));
    expect(phantom, 'a name on the surface must be a tool this engine builds').toEqual([]);
  });

  // What a mandate's tools write INSIDE the instance is a closed classification too.
  // Every tool on the surface is placed exactly once, every
  // placed name is a real tool, and every writer has a write site (and every site a writer).
  it('places every tool on the surface as writing inside or not, exactly once, a non-writer with its reason', async () => {
    const all = await surfaceTools();
    const nonWriters = Object.keys(MANDATE_INSIDE_NON_WRITERS);
    const both = [...MANDATE_INSIDE_WRITERS].filter(n => Object.hasOwn(MANDATE_INSIDE_NON_WRITERS, n));
    expect(both, 'a tool on both lists').toEqual([]);
    expect([...new Set([...MANDATE_INSIDE_WRITERS, ...nonWriters])].sort()).toEqual([...MANDATE_TOOL_SURFACE].sort());
    for (const n of [...MANDATE_INSIDE_WRITERS, ...nonWriters]) expect(all.has(n), `${n} is a tool this engine builds`).toBe(true);
    for (const n of nonWriters) expect(MANDATE_INSIDE_NON_WRITERS[n]!.length, n).toBeGreaterThan(10);
    const siteTools = new Set(INSTANCE_WRITE_SITES.map(s => s.slice(0, s.indexOf('#'))));
    expect([...MANDATE_INSIDE_WRITERS].filter(n => !siteTools.has(n)), 'a writer without a write site').toEqual([]);
    expect([...siteTools].filter(n => !MANDATE_INSIDE_WRITERS.has(n)), 'a write site of a tool that is no writer').toEqual([]);
  });

  it('declares outwardRead on exactly the tools placed as reading outside', async () => {
    const all = await surfaceTools();
    const declared = [...MANDATE_TOOL_SURFACE].filter(n => typeof all.get(n)?.outwardRead === 'function').sort();
    expect(declared).toEqual([...MANDATE_OUTWARD_READERS].sort());
    for (const n of MANDATE_OUTWARD_READERS) expect(MANDATE_TOOL_SURFACE.has(n), n).toBe(true);
  });
});

/**
 * A mandate's session has no provider-side search (the agent withholds `web_search`). When the
 * instance has no search provider either, the model must say it cannot search rather than act as
 * if it had: the session's prompt carries the honesty notice for a mandate as for the owner.
 */
describe('Engine boot — a mandate\'s session without any search', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let savedDataDir: string | undefined;
  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    if (savedDataDir === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = savedDataDir;
    reloadConfig();
  });

  it('tells the model it cannot search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandate-nosearch-'));
    dirs.push(dir);
    savedDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    // No SearXNG and no fallback: the state the notice is for.
    (engine as unknown as { _webSearchStatus: string })._webSearchStatus = 'none';
    const session = engine.createSession({ principal: { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' } });
    const prompt = (session as unknown as { agent: { systemPrompt?: string } }).agent.systemPrompt ?? '';
    expect(prompt).toContain(NO_WEB_SEARCH_PROMPT_SUFFIX.trim());
  });
});
