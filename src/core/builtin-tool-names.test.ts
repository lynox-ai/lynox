import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { BUILTIN_TOOL_NAMES, RESERVED_TOOL_NAMES } from './builtin-tool-names.js';
import { PluginManager } from './plugins.js';
import type { MailRegistry } from '../integrations/mail/tools/registry.js';
import type { SearchProvider } from '../integrations/search/search-provider.js';
import type { LynoxConfig, ToolEntry } from '../types/index.js';
import { createMailTools } from '../integrations/mail/tools/index.js';
import { createSheetsTool } from '../integrations/google/google-sheets.js';
import { createDocsTool } from '../integrations/google/google-docs.js';
import { createDriveTool } from '../integrations/google/google-drive.js';
import { createCalendarTool } from '../integrations/google/google-calendar.js';
import { createWebSearchTool } from '../integrations/search/web-search-tool.js';
import * as builtinTools from '../tools/builtin/index.js';

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
  vi.restoreAllMocks();
});

/** A data directory with one installed plugin whose tools carry `names`, enabled in config.json. */
function dataDirWithPlugin(names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-plugin-names-'));
  dirs.push(dir);
  const pkg = join(dir, 'plugins', 'node_modules', 'lynox-test-names');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'lynox-test-names', type: 'module', main: 'index.js', exports: './index.js' }));
  writeFileSync(join(pkg, 'index.js'), [
    `const names = ${JSON.stringify(names)};`,
    'export default () => ({ tools: names.map((name) => ({',
    "  definition: { name, description: 'plugin tool', input_schema: { type: 'object', properties: {} } },",
    "  handler: async () => 'from the plugin',",
    '})) });',
  ].join('\n'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ plugins: { 'lynox-test-names': true } }));
  return dir;
}

async function boot(dir: string): Promise<Engine> {
  for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_SERVICE_ACCOUNT_KEY']) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('LYNOX_FEATURE_PLUGINS', '1');
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  return engine;
}

describe('a plugin tool never takes a name of the engine\'s own', () => {
  it('leaves out a tool under a built-in\'s name, registered or switched off, and loads the plugin\'s other tools', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // bash: registered before the plugins. calendar_read: a built-in this instance has switched
    // off. web_search: reserved, defined by no tool. acme_lookup: a free name.
    const engine = await boot(dataDirWithPlugin(['bash', 'calendar_read', 'web_search', 'acme_lookup']));
    const registry = engine.getRegistry();

    const free = registry.find('acme_lookup');
    expect(free, 'positive control: the plugin loaded and its free tool is registered').toBeDefined();
    expect(await free!.handler({}, {} as never)).toBe('from the plugin');

    expect(registry.find('bash')!.definition.description, 'the built-in bash stays').not.toBe('plugin tool');
    expect(registry.find('calendar_read'), 'the switched-off built-in keeps its name').toBeUndefined();
    expect(registry.find('web_search')).toBeUndefined();

    const said = warn.mock.calls.map(c => String(c[0]));
    for (const name of ['bash', 'calendar_read', 'web_search']) {
      expect(said.some(m => m.includes('"lynox-test-names"') && m.includes(`"${name}"`)), name).toBe(true);
    }
    expect(said.some(m => m.includes('"acme_lookup"'))).toBe(false);
  });
});

describe('PluginManager.admitTools', () => {
  it('leaves out exactly the reserved names, plugin by plugin, and names plugin and tool', async () => {
    const tool = (name: string): ToolEntry => ({ definition: { name, input_schema: { type: 'object', properties: {} } }, handler: async () => name } as unknown as ToolEntry);
    const pm = new PluginManager({});
    const loaded = (pm as unknown as { loaded: Array<{ name: string; tools: ToolEntry[]; hooks: object }> }).loaded;
    loaded.push({ name: 'one', tools: [tool('mail_send'), tool('one_free')], hooks: {} }, { name: 'two', tools: [tool('two_free')], hooks: {} });
    const warn = vi.fn();
    expect(pm.admitTools(new Set(['mail_send']), warn).map(t => t.definition.name)).toEqual(['one_free', 'two_free']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('"one"');
    expect(warn.mock.calls[0]![0]).toContain('"mail_send"');
    // Nothing reserved: everything loads, as before.
    expect(pm.admitTools(new Set(), warn).map(t => t.definition.name)).toEqual(['mail_send', 'one_free', 'two_free']);
  });
});

describe('BUILTIN_TOOL_NAMES', () => {
  it('holds every tool the engine can build, switched on or not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-builtin-names-'));
    dirs.push(dir);
    setEnv('LYNOX_FEATURE_PLUGINS', '0');
    const engine = await boot(dir);
    const noAuth = (): null => null;
    const provider = { name: 'test', search: async () => [] } as unknown as SearchProvider;
    const catalog = Object.values(builtinTools).filter((v): v is ToolEntry =>
      typeof v === 'object' && v !== null && typeof (v as { definition?: { name?: unknown } }).definition?.name === 'string');
    const all = [
      ...engine.getRegistry().getEntries(), ...catalog,
      ...createMailTools({} as MailRegistry),
      createSheetsTool(noAuth), createDocsTool(noAuth), createDriveTool(noAuth), createCalendarTool(noAuth),
      createWebSearchTool(provider),
    ].map(t => (t as ToolEntry).definition.name);
    // A real catalog, or the check proves nothing.
    expect(new Set(all).size).toBeGreaterThan(55);
    expect(all.filter(n => !BUILTIN_TOOL_NAMES.has(n))).toEqual([]);
  });

  it('reserves the names the engine decides by although no tool defines them', () => {
    for (const name of Object.keys(RESERVED_TOOL_NAMES)) expect(BUILTIN_TOOL_NAMES.has(name), name).toBe(true);
    expect(BUILTIN_TOOL_NAMES.has('mail_send')).toBe(true);
    expect(BUILTIN_TOOL_NAMES.has('bash')).toBe(true);
  });
});
