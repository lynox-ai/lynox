/**
 * Config-related CLI commands: /config, /status, /hooks, /approvals
 */

import { createRequire } from 'node:module';

import type { Session } from '../../core/session.js';
import { MODEL_MAP } from '../../types/index.js';
import { BOLD, DIM, BLUE, GREEN, RED, YELLOW, RESET } from '../ui.js';
import { state } from '../cli-state.js';
import type { CLICtx } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { version: string };

export { pkg };

export async function handleConfig(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const configKey = parts[1];
  const configValue = parts.slice(2).join(' ');

  // Direct key=value setter: /config key value
  if (configKey && configValue) {
    const { readUserConfig: readCfg, saveUserConfig: saveCfg, reloadConfig } = await import('../../core/config.js');
    const current = readCfg();
    let parsed: unknown;
    try {
      parsed = JSON.parse(configValue);
    } catch {
      parsed = configValue;
    }
    (current as Record<string, unknown>)[configKey] = parsed;
    saveCfg(current);
    reloadConfig();
    session.reloadUserConfig();
    ctx.stdout.write(`${GREEN}✓${RESET} ${configKey} = ${JSON.stringify(parsed)}\n`);
    const RESTART_KEYS = new Set(['api_key', 'api_base_url']);
    if (RESTART_KEYS.has(configKey)) {
      ctx.stdout.write(`${YELLOW}⚠${RESET} ${DIM}Restart lynox for the new API credentials to take effect.${RESET}\n`);
    }
    return true;
  }

  // Direct key query: /config key
  if (configKey) {
    const cfg = session.getUserConfig();
    const SENSITIVE = new Set(['api_key', 'voyage_api_key', 'search_api_key', 'telegram_bot_token', 'google_client_id', 'google_client_secret']);
    const val = (cfg as Record<string, unknown>)[configKey];
    if (val === undefined) {
      ctx.stdout.write(`${DIM}${configKey} is not set.${RESET}\n`);
    } else if (SENSITIVE.has(configKey) && typeof val === 'string') {
      ctx.stdout.write(`${configKey}: ${val.slice(0, 8)}...\n`);
    } else {
      ctx.stdout.write(`${configKey}: ${JSON.stringify(val)}\n`);
    }
    return true;
  }

  // Interactive settings pane
  const SENSITIVE_KEYS = new Set([
    'api_key', 'voyage_api_key', 'search_api_key',
    'telegram_bot_token', 'google_client_id', 'google_client_secret',
  ]);

  type SettingDef = {
    key: string;
    label: string;
    options?: string[];
    type: 'select' | 'toggle' | 'text' | 'number';
    /** Map user-friendly value to internal value on save */
    toInternal?: Record<string, string>;
    /** Map internal value to user-friendly value for display */
    toDisplay?: Record<string, string>;
  };

  const settings: SettingDef[] = [
    { key: 'default_tier', label: 'Default model', options: ['opus', 'sonnet', 'haiku'], type: 'select' },
    { key: 'thinking_mode', label: 'Thinking mode', options: ['adaptive', 'disabled'], type: 'select' },
    { key: 'effort_level', label: 'Accuracy', options: ['low', 'medium', 'high', 'max'], type: 'select' },
    { key: 'changeset_review', label: 'Changeset review', type: 'toggle' },
    { key: 'greeting', label: 'Greeting on start', type: 'toggle' },
    { key: 'memory_auto_scope', label: 'Memory auto-scope', type: 'toggle' },
    { key: 'max_session_cost_usd', label: 'Cost limit (USD)', type: 'number' },
    { key: 'embedding_provider', label: 'Embedding provider', options: ['onnx', 'voyage', 'local'], type: 'select' },
    { key: 'search_provider', label: 'Search provider', options: ['tavily', 'brave'], type: 'select' },
    { key: 'api_base_url', label: 'API endpoint', type: 'text' },
    { key: 'api_key', label: 'API key', type: 'text' },
    { key: 'voyage_api_key', label: 'Voyage API key', type: 'text' },
    { key: 'search_api_key', label: 'Search API key', type: 'text' },
    { key: 'telegram_bot_token', label: 'Telegram bot token', type: 'text' },
    { key: 'google_client_id', label: 'Google client ID', type: 'text' },
    { key: 'google_client_secret', label: 'Google client secret', type: 'text' },
  ];

  const formatValue = (setting: SettingDef, val: unknown): string => {
    if (val === undefined || val === null) return `${DIM}not set${RESET}`;
    if (SENSITIVE_KEYS.has(setting.key) && typeof val === 'string' && val.length > 0) {
      return `${DIM}${val.slice(0, 8)}...${RESET}`;
    }
    if (typeof val === 'boolean') return val ? `${GREEN}true${RESET}` : `${DIM}false${RESET}`;
    const display = setting.toDisplay && typeof val === 'string' ? (setting.toDisplay[val] ?? val) : val;
    return `${DIM}${String(display)}${RESET}`;
  };

  if (!ctx.cliPrompt) {
    // Non-TTY fallback: show settings list
    const cfg = session.getUserConfig();
    ctx.stdout.write(`${BOLD}Settings${RESET}\n`);
    for (const s of settings) {
      const val = (cfg as Record<string, unknown>)[s.key];
      const pad = ' '.repeat(Math.max(1, 36 - s.label.length));
      ctx.stdout.write(`  ${s.label}${pad}${formatValue(s, val)}\n`);
    }
    return true;
  }

  // Interactive loop
  const { readUserConfig: readCfg, saveUserConfig: saveCfg, reloadConfig } = await import('../../core/config.js');

   
  while (true) {
    const cfg = session.getUserConfig();
    const settingsOptions = settings.map(s => {
      const val = (cfg as Record<string, unknown>)[s.key];
      const display = formatValue(s, val);
      const pad = ' '.repeat(Math.max(1, 36 - s.label.length));
      return `${s.label}${pad}${display}`;
    });

    const answer = await ctx.cliPrompt('Settings', [...settingsOptions, '\x00']);
    if (!answer) break; // ESC exits

    const idx = settingsOptions.indexOf(answer);
    if (idx < 0) continue;
    const setting = settings[idx]!;
    const currentVal = (cfg as Record<string, unknown>)[setting.key];

    let newVal: unknown;

    if (setting.type === 'toggle') {
      // Toggle directly
      newVal = !currentVal;
    } else if (setting.type === 'select' && setting.options) {
      const selectAnswer = await ctx.cliPrompt(`${setting.label}:`, [...setting.options, '\x00']);
      if (!selectAnswer || !setting.options.includes(selectAnswer)) continue;
      newVal = selectAnswer;
    } else if (setting.type === 'number') {
      const numAnswer = await ctx.cliPrompt(`${setting.label} (current: ${currentVal ?? 'not set'}):`);
      if (!numAnswer) continue;
      const parsedNum = parseFloat(numAnswer);
      if (isNaN(parsedNum)) {
        ctx.stdout.write(`${RED}Invalid number.${RESET}\n`);
        continue;
      }
      newVal = parsedNum;
    } else {
      // text
      const textAnswer = await ctx.cliPrompt(`${setting.label}:`);
      if (!textAnswer) continue;
      newVal = textAnswer;
    }

    // Read only user config (not merged), modify, save
    const current = readCfg();
    const internalVal = setting.toInternal && typeof newVal === 'string' ? (setting.toInternal[newVal] ?? newVal) : newVal;
    (current as Record<string, unknown>)[setting.key] = internalVal;
    saveCfg(current);
    reloadConfig();
    session.reloadUserConfig();
    ctx.stdout.write(`${GREEN}✓${RESET} ${setting.label} updated\n`);
    if (setting.key === 'api_key' || setting.key === 'api_base_url') {
      ctx.stdout.write(`${YELLOW}⚠${RESET} ${DIM}Restart lynox for the new API credentials to take effect.${RESET}\n`);
    }
  }
  return true;
}

export async function handleStatus(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const model = MODEL_MAP[session.getModelTier()];
  const tier = session.getModelTier();
  const reg = session.getRegistry();
  const servers = reg.getMCPServers();
  const mem = session.getMemory();
  const scopes = session.getActiveScopes();
  const secretStore = session.getSecretStore();
  const cfg = session.getUserConfig();

  ctx.stdout.write(`${BOLD}LYNOX${RESET} v${pkg.version}\n\n`);
  ctx.stdout.write(`  ${DIM}Model:${RESET}      ${BLUE}${model}${RESET} (${tier})\n`);
  ctx.stdout.write(`  ${DIM}Mode:${RESET}       interactive\n`);
  ctx.stdout.write(`  ${DIM}Effort:${RESET}     ${session.getEffort()}\n`);
  ctx.stdout.write(`  ${DIM}Tools:${RESET}      ${reg.getEntries().length} builtin\n`);
  ctx.stdout.write(`  ${DIM}MCP:${RESET}        ${servers.length > 0 ? `${servers.length} server${servers.length > 1 ? 's' : ''} (${servers.map(s => s.name).join(', ')})` : 'none'}\n`);
  ctx.stdout.write(`  ${DIM}Memory:${RESET}     ${mem ? 'active' : 'off'}\n`);
  ctx.stdout.write(`  ${DIM}Scopes:${RESET}     ${scopes.length > 0 ? scopes.map(s => s.type === 'global' ? 'global' : `${s.type}:${s.id}`).join(', ') : 'none'}\n`);
  ctx.stdout.write(`  ${DIM}Secrets:${RESET}    ${secretStore ? `${secretStore.listNames().length} loaded` : 'off'}\n`);
  ctx.stdout.write(`  ${DIM}Changeset:${RESET}  ${cfg.changeset_review !== false ? 'enabled' : 'disabled'}\n`);
  // Session stats
  const u = session.usage;
  if (u.input_tokens > 0 || u.output_tokens > 0) {
    ctx.stdout.write(`\n  ${DIM}Session:${RESET}    ${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out (${state.turnCount} turns)\n`);
  }
  return true;
}

export async function handleHooks(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const pm = session.getPluginManager();
  const loadedPlugins = pm ? pm.getLoadedPluginNames() : [];
  ctx.stdout.write(`${BOLD}Hooks${RESET}\n`);
  if (loadedPlugins.length === 0) {
    ctx.stdout.write(`  ${DIM}No plugins with hooks loaded.${RESET}\n`);
  } else {
    ctx.stdout.write(`  ${DIM}Plugin hooks from:${RESET}\n`);
    for (const name of loadedPlugins) {
      ctx.stdout.write(`    ${BLUE}${name}${RESET}\n`);
    }
  }
  return true;
}

export async function handleApprovals(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];
  const history = session.getRunHistory();

  if (!history) {
    ctx.stdout.write(`${DIM}No run history available.${RESET}\n`);
    return true;
  }

  const sets = history.getPreApprovalSets(20);
  if (sets.length === 0) {
    ctx.stdout.write(`${DIM}No pre-approval sets recorded.${RESET}\n`);
    return true;
  }

  if (sub === 'audit' || sub === 'show') {
    // Show detailed audit for the most recent set
    const set = sets[0]!;
    const summary = history.getPreApprovalSummary(set.id);
    const events = history.getPreApprovalEvents(set.id);
    ctx.stdout.write(`${BOLD}Pre-Approval Audit${RESET}  ${DIM}${set.id.slice(0, 8)}${RESET}\n`);
    ctx.stdout.write(`  Task:     ${set.task_summary}\n`);
    ctx.stdout.write(`  Created:  ${set.created_at}\n`);
    const patterns: unknown[] = JSON.parse(set.patterns_json) as unknown[];
    ctx.stdout.write(`  Patterns: ${patterns.length}\n`);
    if (summary) {
      ctx.stdout.write(`  Matches:  ${GREEN}${summary.total_matches}${RESET}  Exhausted: ${YELLOW}${summary.total_exhausted}${RESET}  Expired: ${DIM}${summary.total_expired}${RESET}\n`);
    }
    if (events.length > 0) {
      ctx.stdout.write(`\n${BOLD}Recent Events${RESET}\n`);
      for (const e of events.slice(0, 20)) {
        const color = e.decision === 'approved' ? GREEN : e.decision === 'exhausted' ? YELLOW : DIM;
        ctx.stdout.write(`  ${color}${e.decision}${RESET}  ${e.tool_name}  ${DIM}${e.pattern}${RESET}\n`);
      }
    }
  } else if (sub === 'export') {
    const data = JSON.stringify(sets, null, 2);
    ctx.stdout.write(`${data}\n`);
  } else {
    // Default: list sets
    ctx.stdout.write(`${BOLD}Pre-Approval Sets${RESET}  ${DIM}(${sets.length})${RESET}\n`);
    for (const s of sets) {
      const summary = history.getPreApprovalSummary(s.id);
      const matches = summary?.total_matches ?? 0;
      ctx.stdout.write(`  ${DIM}${s.id.slice(0, 8)}${RESET}  ${s.task_summary.slice(0, 40)}  ${GREEN}${matches} matches${RESET}  ${DIM}${s.created_at}${RESET}\n`);
    }
  }
  return true;
}
