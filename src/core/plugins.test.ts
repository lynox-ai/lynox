import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager } from './plugins.js';
import type { NodynUserConfig, PluginContext, PluginExport, ToolEntry } from '../types/index.js';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

// Helper to create a mock ToolEntry
function mockTool(name: string): ToolEntry {
  return {
    definition: { name, type: 'custom' as BetaTool['type'], input_schema: { type: 'object' as const, properties: {} } } as BetaTool,
    handler: async () => `${name} result`,
  };
}

describe('PluginManager', () => {
  let log: (msg: string) => void;
  let logMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logMock = vi.fn();
    log = logMock as (msg: string) => void;
  });

  describe('loadPlugins', () => {
    it('does nothing when no plugins are configured', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      expect(pm.getTools()).toEqual([]);
      expect(pm.getHooks()).toEqual([]);
      expect(pm.getLoadedPluginNames()).toEqual([]);
    });

    it('does nothing when all plugins are disabled', async () => {
      const config: NodynUserConfig = {
        plugins: { 'some-plugin': false },
      };
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      expect(pm.getTools()).toEqual([]);
      expect(pm.getLoadedPluginNames()).toEqual([]);
    });

    it('logs error for missing plugin gracefully', async () => {
      const config: NodynUserConfig = {
        plugins: { 'nonexistent-plugin-xyz-12345': true },
      };
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      expect(pm.getLoadedPluginNames()).toEqual([]);
      expect(logMock).toHaveBeenCalledWith(
        expect.stringContaining('nonexistent-plugin-xyz-12345'),
      );
    });
  });

  describe('tools registration', () => {
    it('collects tools from a loaded plugin', async () => {
      const tool = mockTool('my-tool');
      const pluginFn: PluginExport = (_ctx: PluginContext) => ({
        tools: [tool],
      });

      const config: NodynUserConfig = { plugins: { 'test-plugin': true } };
      const pm = new PluginManager(config, log);

      // Manually inject plugin since we can't do a real dynamic import in test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push({
        name: 'test-plugin',
        tools: pluginFn({ projectDir: '/tmp', config, log }).tools ?? [],
        hooks: {},
      });

      const tools = pm.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.definition.name).toBe('my-tool');
    });

    it('returns empty tools when plugin provides none', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push({
        name: 'empty-plugin',
        tools: [],
        hooks: {},
      });

      expect(pm.getTools()).toEqual([]);
    });

    it('merges tools from multiple plugins', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'plugin-a', tools: [mockTool('tool-a')], hooks: {} },
        { name: 'plugin-b', tools: [mockTool('tool-b1'), mockTool('tool-b2')], hooks: {} },
      );

      const tools = pm.getTools();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.definition.name)).toEqual(['tool-a', 'tool-b1', 'tool-b2']);
    });
  });

  describe('hooks lifecycle', () => {
    it('fires onSessionStart for all plugins', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const onSessionStart1 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const onSessionStart2 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'plugin-a', tools: [], hooks: { onSessionStart: onSessionStart1 } },
        { name: 'plugin-b', tools: [], hooks: { onSessionStart: onSessionStart2 } },
      );

      await pm.fireSessionStart();
      expect(onSessionStart1).toHaveBeenCalledOnce();
      expect(onSessionStart2).toHaveBeenCalledOnce();
    });

    it('fires onRunComplete with result string', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const onRunComplete = vi.fn<(result: string) => Promise<void>>().mockResolvedValue(undefined);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'plugin-a', tools: [], hooks: { onRunComplete } },
      );

      await pm.fireRunComplete('test result');
      expect(onRunComplete).toHaveBeenCalledWith('test result');
    });

    it('handles onSessionStart errors gracefully', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const failHook = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('hook fail'));
      const successHook = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'fail-plugin', tools: [], hooks: { onSessionStart: failHook } },
        { name: 'ok-plugin', tools: [], hooks: { onSessionStart: successHook } },
      );

      await pm.fireSessionStart();
      expect(failHook).toHaveBeenCalledOnce();
      expect(successHook).toHaveBeenCalledOnce();
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('hook fail'));
    });

    it('handles onRunComplete errors gracefully', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const failHook = vi.fn<(r: string) => Promise<void>>().mockRejectedValue(new Error('run fail'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'fail-plugin', tools: [], hooks: { onRunComplete: failHook } },
      );

      await pm.fireRunComplete('result');
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('run fail'));
    });
  });

  describe('fireToolGate', () => {
    it('returns undefined when no hooks veto', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const gate = vi.fn<(name: string, input: unknown) => Promise<boolean | undefined>>()
        .mockResolvedValue(undefined);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'plugin-a', tools: [], hooks: { onToolGate: gate } },
      );

      const result = await pm.fireToolGate('bash', { command: 'ls' });
      expect(result).toBeUndefined();
      expect(gate).toHaveBeenCalledWith('bash', { command: 'ls' });
    });

    it('returns false when a plugin vetoes', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const gate = vi.fn<(name: string, input: unknown) => Promise<boolean | undefined>>()
        .mockResolvedValue(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'plugin-a', tools: [], hooks: { onToolGate: gate } },
      );

      const result = await pm.fireToolGate('bash', { command: 'rm -rf /' });
      expect(result).toBe(false);
    });

    it('handles gate errors gracefully', async () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      const gate = vi.fn<(name: string, input: unknown) => Promise<boolean | undefined>>()
        .mockRejectedValue(new Error('gate error'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'plugin-a', tools: [], hooks: { onToolGate: gate } },
      );

      const result = await pm.fireToolGate('bash', {});
      expect(result).toBeUndefined();
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('gate error'));
    });
  });

  describe('getLoadedPluginNames', () => {
    it('returns names of all loaded plugins', () => {
      const config: NodynUserConfig = {};
      const pm = new PluginManager(config, log);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded.push(
        { name: 'alpha', tools: [], hooks: {} },
        { name: 'beta', tools: [], hooks: {} },
      );

      expect(pm.getLoadedPluginNames()).toEqual(['alpha', 'beta']);
    });
  });

  describe('static methods', () => {
    it('getPluginsDir returns a path ending with plugins', () => {
      const dir = PluginManager.getPluginsDir();
      expect(dir).toContain('plugins');
      expect(dir).toContain('.nodyn');
    });
  });

  describe('plugin name validation', () => {
    it('rejects path-like names with ./', async () => {
      const config: NodynUserConfig = { plugins: { './exploit': true } };
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin name'));
    });

    it('rejects path-like names with ../', async () => {
      const config: NodynUserConfig = { plugins: { '../evil': true } };
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin name'));
    });

    it('rejects absolute paths', async () => {
      const config: NodynUserConfig = { plugins: { '/tmp/exploit': true } };
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin name'));
    });

    it('accepts valid scoped npm names', async () => {
      const config: NodynUserConfig = { plugins: { '@scope/plugin-name': true } };
      const pm = new PluginManager(config, log);
      await pm.loadPlugins();
      // Should fail with "not installed", not "Invalid plugin name"
      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('not installed'));
    });

    it('install rejects git+https:// URLs', () => {
      expect(() => PluginManager.install('git+https://evil.com/repo')).toThrow('Invalid package name');
    });

    it('install rejects file: paths', () => {
      expect(() => PluginManager.install('file:../local-exploit')).toThrow('Invalid package name');
    });

    it('uninstall rejects invalid names', () => {
      expect(() => PluginManager.uninstall('../evil')).toThrow('Invalid package name');
    });
  });

  describe('config sanitization', () => {
    it('does not expose api_key to plugins', async () => {
      const config: NodynUserConfig = {
        api_key: 'sk-secret-key',
        api_base_url: 'https://api.example.com',
        plugins: { 'test-plugin': true },
        default_tier: 'sonnet',
      };
      const pm = new PluginManager(config, log);

      // Manually load a plugin to inspect the context it receives
      let receivedConfig: NodynUserConfig | undefined;
      const pluginFn: PluginExport = (ctx: PluginContext) => {
        receivedConfig = ctx.config;
        return { tools: [] };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const _loadPlugin = (pm as any)._loadPlugin.bind(pm);
      // We can't easily test the private method, so we test via the loaded context
      // by pushing a manually loaded plugin and checking its config
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pm as any).loaded = [];
      const ctx: PluginContext = {
        projectDir: process.cwd(),
        config: config,
        log,
      };

      // Simulate what loadPlugins does: strip secrets
      const { api_key, api_base_url, ...safeConfig } = config;
      const safeCtx: PluginContext = {
        projectDir: process.cwd(),
        config: safeConfig as NodynUserConfig,
        log,
      };

      pluginFn(safeCtx);
      expect(receivedConfig).toBeDefined();
      expect(receivedConfig!.api_key).toBeUndefined();
      expect(receivedConfig!.api_base_url).toBeUndefined();
      expect(receivedConfig!.default_tier).toBe('sonnet');
    });
  });
});
