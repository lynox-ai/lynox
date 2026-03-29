/**
 * Tool + MCP CLI commands: /tools, /mcp
 */

import type { Session } from '../../core/session.js';
import type { CLICtx } from './types.js';

export async function handleTools(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const reg = session.getRegistry();
  const entries = reg.getEntries();
  const servers = reg.getMCPServers();
  ctx.stdout.write('Builtin tools:\n');
  for (const e of entries) {
    ctx.stdout.write(`  - ${e.definition.name}: ${e.definition.description ?? ''}\n`);
  }
  ctx.stdout.write(`  - web_search (native)\n`);
  if (servers.length > 0) {
    ctx.stdout.write('MCP servers:\n');
    for (const s of servers) {
      ctx.stdout.write(`  - ${s.name}: ${s.url}\n`);
    }
  }
  return true;
}

export async function handleMcp(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];

  // /mcp list
  if (!sub || sub === 'list') {
    const config = session.getUserConfig();
    const servers = config.mcp_servers ?? [];
    if (servers.length === 0) {
      ctx.stdout.write('No persistent MCP servers configured.\nUsage: /mcp add <name> <url>\n');
      return true;
    }
    ctx.stdout.write('MCP Servers:\n');
    for (const s of servers) {
      ctx.stdout.write(`  ${s.name} — ${s.url}\n`);
    }
    return true;
  }

  // /mcp add <name> <url>
  if (sub === 'add') {
    const name = parts[2];
    const url = parts[3];
    if (!name || !url) {
      ctx.stdout.write('Usage: /mcp add <name> <url>\n');
      return true;
    }
    // Register in session
    session.addMCP({ type: 'url', name, url });
    // Persist to config
    const { readUserConfig, saveUserConfig } = await import('../../core/config.js');
    const config = readUserConfig();
    const servers = config.mcp_servers ?? [];
    if (!servers.some(s => s.name === name)) {
      servers.push({ name, url });
      config.mcp_servers = servers;
      saveUserConfig(config);
    }
    ctx.stdout.write(`MCP server "${name}" registered and saved.\n`);
    return true;
  }

  // /mcp remove <name>
  if (sub === 'remove') {
    const name = parts[2];
    if (!name) {
      ctx.stdout.write('Usage: /mcp remove <name>\n');
      return true;
    }
    const { readUserConfig, saveUserConfig } = await import('../../core/config.js');
    const config = readUserConfig();
    const servers = config.mcp_servers ?? [];
    const filtered = servers.filter(s => s.name !== name);
    if (filtered.length === servers.length) {
      ctx.stdout.write(`MCP server "${name}" not found.\n`);
      return true;
    }
    config.mcp_servers = filtered.length > 0 ? filtered : undefined;
    saveUserConfig(config);
    ctx.stdout.write(`MCP server "${name}" removed. Restart to disconnect.\n`);
    return true;
  }

  // Legacy: /mcp <name> <url> (backwards compat)
  const url = parts[2];
  if (sub && url) {
    session.addMCP({ type: 'url', name: sub, url });
    const { readUserConfig, saveUserConfig } = await import('../../core/config.js');
    const config = readUserConfig();
    const servers = config.mcp_servers ?? [];
    if (!servers.some(s => s.name === sub)) {
      servers.push({ name: sub, url });
      config.mcp_servers = servers;
      saveUserConfig(config);
    }
    ctx.stdout.write(`MCP server "${sub}" registered and saved.\n`);
    return true;
  }

  ctx.stdout.write('Usage:\n  /mcp              List MCP servers\n  /mcp add <name> <url>   Add and persist\n  /mcp remove <name>      Remove\n');
  return true;
}
