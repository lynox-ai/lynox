import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  LynoxUserConfig,
  PluginContext,
  PluginExport,
  PluginHooks,
  ToolEntry,
} from '../types/index.js';
import { ensureDirSync, writeFileAtomicSync } from './atomic-write.js';
import { getErrorMessage } from './utils.js';

const PLUGINS_DIR = join(homedir(), '.lynox', 'plugins');
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function ensurePluginsDir(): void {
  ensureDirSync(PLUGINS_DIR);
  const pkgPath = join(PLUGINS_DIR, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileAtomicSync(
      pkgPath,
      JSON.stringify({ name: 'lynox-plugins', private: true, type: 'module' }, null, 2) + '\n',
    );
  }
}

function getConfigPath(): string {
  return join(homedir(), '.lynox', 'config.json');
}

function writeConfigAtomic(configPath: string, config: Record<string, unknown>): void {
  writeFileAtomicSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function readPluginsConfig(): Record<string, boolean> {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'plugins' in parsed) {
      const plugins = (parsed as { plugins: unknown }).plugins;
      if (typeof plugins === 'object' && plugins !== null) {
        return plugins as Record<string, boolean>;
      }
    }
  } catch {
    // config does not exist or is invalid
  }
  return {};
}

interface LoadedPlugin {
  name: string;
  tools: ToolEntry[];
  hooks: PluginHooks;
}

export class PluginManager {
  private readonly config: LynoxUserConfig;
  private readonly loaded: LoadedPlugin[] = [];
  private readonly log: (msg: string) => void;

  constructor(config: LynoxUserConfig, log?: ((msg: string) => void) | undefined) {
    this.config = config;
    this.log = log ?? (() => {});
  }

  async loadPlugins(): Promise<void> {
    const plugins = this.config.plugins ?? readPluginsConfig();
    const enabledNames = Object.entries(plugins)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);

    if (enabledNames.length === 0) return;

    // Strip secrets before passing config to plugins
    const { api_key: _api_key, api_base_url: _api_base_url, ...safeConfig } = this.config;
    const ctx: PluginContext = {
      projectDir: process.cwd(),
      config: safeConfig as LynoxUserConfig,
      log: this.log,
    };

    for (const name of enabledNames) {
      try {
        await this._loadPlugin(name, ctx);
      } catch (err: unknown) {
        this.log(`Plugin "${name}" failed to load: ${getErrorMessage(err)}`);
      }
    }
  }

  private async _loadPlugin(name: string, ctx: PluginContext): Promise<void> {
    if (!NPM_NAME_RE.test(name)) {
      throw new Error(`Invalid plugin name "${name}"`);
    }

    // Only import from the plugins directory — no arbitrary import() fallback
    const modulePath = join(PLUGINS_DIR, 'node_modules', name);
    if (!existsSync(modulePath)) {
      throw new Error(`Plugin "${name}" not installed. Run /plugin add ${name}`);
    }

    const mod: unknown = await import(modulePath);
    const exportFn = typeof mod === 'function'
      ? mod as PluginExport
      : (typeof mod === 'object' && mod !== null && 'default' in mod && typeof (mod as { default: unknown }).default === 'function')
        ? (mod as { default: PluginExport }).default
        : undefined;

    if (!exportFn) {
      throw new Error(`Plugin "${name}" does not export a function`);
    }

    const result = exportFn(ctx);
    this.loaded.push({
      name,
      tools: result.tools ?? [],
      hooks: result.hooks ?? {},
    });
    this.log(`Plugin "${name}" loaded (${result.tools?.length ?? 0} tools)`);
  }

  getTools(): ToolEntry[] {
    return this.loaded.flatMap(p => p.tools);
  }

  getHooks(): PluginHooks[] {
    return this.loaded.map(p => p.hooks);
  }

  async fireSessionStart(): Promise<void> {
    for (const plugin of this.loaded) {
      if (plugin.hooks.onSessionStart) {
        try {
          await plugin.hooks.onSessionStart();
        } catch (err: unknown) {
          this.log(`Plugin "${plugin.name}" onSessionStart error: ${getErrorMessage(err)}`);
        }
      }
    }
  }

  async fireRunComplete(result: string): Promise<void> {
    for (const plugin of this.loaded) {
      if (plugin.hooks.onRunComplete) {
        try {
          await plugin.hooks.onRunComplete(result);
        } catch (err: unknown) {
          this.log(`Plugin "${plugin.name}" onRunComplete error: ${getErrorMessage(err)}`);
        }
      }
    }
  }

  async fireToolGate(toolName: string, input: unknown): Promise<boolean | undefined> {
    for (const plugin of this.loaded) {
      if (plugin.hooks.onToolGate) {
        try {
          const result = await plugin.hooks.onToolGate(toolName, input);
          if (result === false) return false;
        } catch (err: unknown) {
          this.log(`Plugin "${plugin.name}" onToolGate error: ${getErrorMessage(err)}`);
        }
      }
    }
    return undefined;
  }

  getLoadedPluginNames(): string[] {
    return this.loaded.map(p => p.name);
  }

  static getPluginsDir(): string {
    return PLUGINS_DIR;
  }

  static install(packageName: string): string {
    if (!NPM_NAME_RE.test(packageName)) {
      throw new Error(`Invalid package name "${packageName}"`);
    }
    ensurePluginsDir();
    try {
      const output = execFileSync('npm', ['install', packageName], {
        cwd: PLUGINS_DIR,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      return output.trim();
    } catch (err: unknown) {
      if (err instanceof Error && 'stderr' in err) {
        throw new Error(`npm install failed: ${String((err as { stderr: unknown }).stderr).trim()}`);
      }
      throw err;
    }
  }

  static uninstall(packageName: string): string {
    if (!NPM_NAME_RE.test(packageName)) {
      throw new Error(`Invalid package name "${packageName}"`);
    }
    ensurePluginsDir();
    try {
      const output = execFileSync('npm', ['uninstall', packageName], {
        cwd: PLUGINS_DIR,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      return output.trim();
    } catch (err: unknown) {
      if (err instanceof Error && 'stderr' in err) {
        throw new Error(`npm uninstall failed: ${String((err as { stderr: unknown }).stderr).trim()}`);
      }
      throw err;
    }
  }

  static listInstalled(): string[] {
    const nodeModulesDir = join(PLUGINS_DIR, 'node_modules');
    if (!existsSync(nodeModulesDir)) return [];
    try {
      const output = execFileSync('npm', ['ls', '--json', '--depth=0'], {
        cwd: PLUGINS_DIR,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      const parsed: unknown = JSON.parse(output);
      if (typeof parsed === 'object' && parsed !== null && 'dependencies' in parsed) {
        const deps = (parsed as { dependencies: Record<string, unknown> }).dependencies;
        return Object.keys(deps);
      }
    } catch {
      // npm ls returns non-zero when there are issues — just return empty
    }
    return [];
  }

  static enablePlugin(name: string): void {
    const configPath = getConfigPath();
    let config: Record<string, unknown> = {};
    try {
      const raw = readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // new config
    }
    const plugins = (typeof config['plugins'] === 'object' && config['plugins'] !== null)
      ? config['plugins'] as Record<string, boolean>
      : {};
    plugins[name] = true;
    config['plugins'] = plugins;
    writeConfigAtomic(configPath, config);
  }

  static disablePlugin(name: string): void {
    const configPath = getConfigPath();
    let config: Record<string, unknown> = {};
    try {
      const raw = readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // nothing to disable
    }
    if (typeof config['plugins'] === 'object' && config['plugins'] !== null) {
      const plugins = config['plugins'] as Record<string, boolean>;
      delete plugins[name];
      config['plugins'] = plugins;
      writeConfigAtomic(configPath, config);
    }
  }
}
