/**
 * Identity CLI commands: /alias, /google, /vault, /secret, /plugin
 */

import { stderr } from 'node:process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { Nodyn } from '../../core/orchestrator.js';
import { getErrorMessage } from '../../core/utils.js';
import { SecretVault } from '../../core/secret-vault.js';
import { RunHistory } from '../../core/run-history.js';
import { PluginManager } from '../../core/plugins.js';
import { writeFileAtomicSync } from '../../core/atomic-write.js';
import { renderError, BOLD, DIM, BLUE, GREEN, RED, YELLOW, RESET } from '../ui.js';
import { spinner } from '../cli-state.js';
import { loadAliases, saveAliases } from '../cli-helpers.js';
import type { CLICtx } from './types.js';

export async function handleAlias(parts: string[], _nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const aliasSub = parts[1];

  // /alias list (or no args)
  if (!aliasSub || aliasSub === 'list') {
    const aliases = loadAliases();
    const keys = Object.keys(aliases);
    if (keys.length === 0) {
      ctx.stdout.write('No aliases defined. Use /alias create <name> <command>\n');
    } else {
      ctx.stdout.write(`${BOLD}Aliases:${RESET}\n`);
      for (const k of keys) {
        ctx.stdout.write(`  ${BLUE}${k}${RESET} → ${DIM}${aliases[k]}${RESET}\n`);
      }
    }
    return true;
  }

  // /alias delete <name>
  if (aliasSub === 'delete') {
    const name = parts[2];
    if (!name) { ctx.stdout.write('Usage: /alias delete <name>\n'); return true; }
    const aliases = loadAliases();
    if (aliases[name] === undefined) {
      ctx.stdout.write(`Alias "${name}" not found.\n`);
    } else {
      delete aliases[name];
      saveAliases(aliases);
      ctx.stdout.write(`${GREEN}✓${RESET} Alias "${name}" deleted.\n`);
    }
    return true;
  }

  // /alias create <name> <cmd> or /alias <name> <cmd> (shorthand)
  const aliasName = aliasSub === 'create' ? parts[2] : aliasSub;
  const aliasCmd = aliasSub === 'create' ? parts.slice(3).join(' ') : parts.slice(2).join(' ');
  if (!aliasName || !aliasCmd) {
    ctx.stdout.write('Usage: /alias create <name> <command text>\n');
    return true;
  }
  const aliases = loadAliases();
  aliases[aliasName] = aliasCmd;
  saveAliases(aliases);
  ctx.stdout.write(`${GREEN}✓${RESET} Alias "${aliasName}" → "${aliasCmd}"\n`);
  return true;
}

export async function handleGoogle(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const googleSub = parts[1];
  if (googleSub === 'auth') {
    const googleAuth = nodyn.getGoogleAuth();
    if (!googleAuth) {
      ctx.stdout.write(`${RED}Google Workspace not configured.${RESET}\n`);
      ctx.stdout.write(`${DIM}Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env or ~/.nodyn/config.json${RESET}\n`);
      ctx.stdout.write(`${DIM}See: https://console.cloud.google.com/apis/credentials${RESET}\n`);
      return true;
    }
    try {
      ctx.stdout.write(`${BOLD}Starting Google OAuth...${RESET}\n`);
      const { authUrl, waitForCode } = await googleAuth.startLocalAuth();
      ctx.stdout.write(`\n${BOLD}Open in browser:${RESET}\n${BLUE}${authUrl}${RESET}\n\n`);
      try {
        const { spawn: spawnProc } = await import('node:child_process');
        spawnProc('open', [authUrl], { stdio: 'ignore', detached: true }).unref();
      } catch { /* manual open */ }
      ctx.stdout.write(`${DIM}Waiting for authorization (2 min timeout)...${RESET}\n`);
      await waitForCode();
      ctx.stdout.write(`${GREEN}${BOLD}Google account connected.${RESET}\n`);
      const info = googleAuth.getAccountInfo();
      ctx.stdout.write(`${DIM}Scopes: ${info.scopes.length}${RESET}\n`);
    } catch (e: unknown) {
      ctx.stdout.write(`${RED}Auth failed: ${getErrorMessage(e)}${RESET}\n`);
    }
  } else if (googleSub === 'status') {
    const googleAuth = nodyn.getGoogleAuth();
    if (!googleAuth) {
      ctx.stdout.write(`${DIM}Google Workspace not configured.${RESET}\n`);
      return true;
    }
    const info = googleAuth.getAccountInfo();
    ctx.stdout.write(`${BOLD}Google Workspace Status${RESET}\n`);
    ctx.stdout.write(`  Connected: ${googleAuth.isAuthenticated() ? `${GREEN}yes${RESET}` : `${RED}no${RESET}`}\n`);
    if (info.expiresAt) {
      ctx.stdout.write(`  Token expires: ${info.expiresAt.toISOString()}\n`);
    }
    ctx.stdout.write(`  Refresh token: ${info.hasRefreshToken ? 'yes' : 'no'}\n`);
    if (info.scopes.length > 0) {
      ctx.stdout.write(`  Scopes:\n`);
      for (const s of info.scopes) {
        ctx.stdout.write(`    ${DIM}${s}${RESET}\n`);
      }
    }
  } else if (googleSub === 'disconnect') {
    const googleAuth = nodyn.getGoogleAuth();
    if (!googleAuth) {
      ctx.stdout.write(`${DIM}Google Workspace not configured.${RESET}\n`);
      return true;
    }
    await googleAuth.revoke();
    ctx.stdout.write(`${GREEN}Google account disconnected. Tokens removed.${RESET}\n`);
  } else {
    ctx.stdout.write(`Usage: /google [auth|status|disconnect]\n`);
    ctx.stdout.write(`  auth        — Connect your Google account (OAuth)\n`);
    ctx.stdout.write(`  status      — Show connection status and scopes\n`);
    ctx.stdout.write(`  disconnect  — Revoke tokens and disconnect\n`);
  }
  return true;
}

export async function handleVault(parts: string[], _nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const vaultSub = parts[1];
  if (!vaultSub || vaultSub === 'status') {
    const hasKey = !!process.env['NODYN_VAULT_KEY'];
    ctx.stdout.write(`${BOLD}Vault Status${RESET}\n`);
    ctx.stdout.write(`  Key configured: ${hasKey ? `${GREEN}yes${RESET}` : `${RED}no${RESET} (set NODYN_VAULT_KEY)`}\n`);
    if (hasKey) {
      try {
        const vault = new SecretVault();
        ctx.stdout.write(`  Secrets stored: ${vault.size}\n`);
        vault.close();
      } catch (e: unknown) {
        ctx.stdout.write(`  ${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
      }
    }
  } else if (vaultSub === 'list') {
    try {
      const vault = new SecretVault();
      const entries = vault.list();
      if (entries.length === 0) {
        ctx.stdout.write(`${DIM}Vault is empty.${RESET}\n`);
      } else {
        for (const e of entries) {
          ctx.stdout.write(`  ${BOLD}${e.name}${RESET} (scope: ${e.scope}, ttl: ${e.ttlMs === 0 ? 'none' : `${e.ttlMs}ms`})\n`);
          ctx.stdout.write(`    ${DIM}created: ${e.createdAt}, updated: ${e.updatedAt}${RESET}\n`);
        }
      }
      vault.close();
    } catch (e: unknown) {
      ctx.stdout.write(`${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
    }
  } else if (vaultSub === 'set') {
    const name = parts[2];
    const value = parts[3];
    if (!name || !value) {
      ctx.stdout.write(`${RED}Usage: /vault set <NAME> <VALUE> [scope]${RESET}\n`);
    } else {
      try {
        const scope = (parts[4] ?? 'any') as import('../../types/index.js').SecretScope;
        const vault = new SecretVault();
        vault.set(name, value, scope);
        ctx.stdout.write(`${GREEN}Secret '${name}' stored in vault.${RESET}\n`);
        vault.close();
      } catch (e: unknown) {
        ctx.stdout.write(`${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
      }
    }
  } else if (vaultSub === 'delete') {
    const name = parts[2];
    if (!name) {
      ctx.stdout.write(`${RED}Usage: /vault delete <NAME>${RESET}\n`);
    } else {
      try {
        const vault = new SecretVault();
        const deleted = vault.delete(name);
        ctx.stdout.write(deleted ? `${GREEN}Secret '${name}' deleted.${RESET}\n` : `${DIM}Secret '${name}' not found.${RESET}\n`);
        vault.close();
      } catch (e: unknown) {
        ctx.stdout.write(`${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
      }
    }
  } else if (vaultSub === 'migrate') {
    try {
      const vault = new SecretVault();
      const count = vault.migrateFromFile();
      ctx.stdout.write(count > 0
        ? `${GREEN}Migrated ${count} secret(s) to vault. secrets.json renamed to .bak.${RESET}\n`
        : `${DIM}Nothing to migrate.${RESET}\n`);
      vault.close();
    } catch (e: unknown) {
      ctx.stdout.write(`${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
    }
  } else if (vaultSub === 'rotate') {
    const oldKey = process.env['NODYN_VAULT_KEY'];
    if (!oldKey) {
      ctx.stdout.write(`${RED}No vault key configured. Set NODYN_VAULT_KEY first.${RESET}\n`);
      return true;
    }

    // Confirmation prompt
    if (ctx.cliPrompt) {
      ctx.stdout.write(`${YELLOW}⚠${RESET} This will re-encrypt all vault secrets and run history with a new key.\n`);
      ctx.stdout.write(`${DIM}  The old key will stop working. Make sure you have no other processes using the vault.${RESET}\n`);
      const answer = await ctx.cliPrompt('Continue?', ['yes', 'no']);
      if (answer.trim().toLowerCase() !== 'yes' && answer.trim().toLowerCase() !== 'y') {
        ctx.stdout.write(`${DIM}Cancelled.${RESET}\n`);
        return true;
      }
    }

    try {
      spinner.start('Rotating vault key...');

      // Generate new key
      const newKey = randomBytes(36).toString('base64');
      const nodynDir = join(homedir(), '.nodyn');
      const vaultDbPath = join(nodynDir, 'vault.db');

      // Re-encrypt vault secrets
      const secretCount = SecretVault.rotateVault(vaultDbPath, oldKey, newKey);

      // Re-encrypt run history
      let historyCount = 0;
      try {
        const history = new RunHistory();
        historyCount = history.reEncryptAll(newKey);
        history.close();
      } catch {
        // History re-encryption is best-effort — may not have encrypted rows
      }

      // Save new key to ~/.nodyn/.env
      const envPath = join(nodynDir, '.env');
      writeFileAtomicSync(envPath, `NODYN_VAULT_KEY=${newKey}\n`);

      // Update current process
      process.env['NODYN_VAULT_KEY'] = newKey;

      spinner.stop();
      ctx.stdout.write(`${GREEN}✓${RESET} Vault key rotated successfully.\n`);
      ctx.stdout.write(`  Secrets re-encrypted: ${secretCount}\n`);
      ctx.stdout.write(`  History rows re-encrypted: ${historyCount}\n`);
      ctx.stdout.write(`  ${DIM}New key saved to ~/.nodyn/.env${RESET}\n`);
      ctx.stdout.write(`  ${YELLOW}⚠${RESET} Restart your shell to load the new key.\n`);
    } catch (e: unknown) {
      spinner.stop();
      ctx.stdout.write(`${RED}Rotation failed: ${getErrorMessage(e)}${RESET}\n`);
      ctx.stdout.write(`${DIM}Your original key is unchanged. No data was lost.${RESET}\n`);
    }
  } else {
    ctx.stdout.write(`${RED}Unknown subcommand. Try: status, list, set, delete, migrate, rotate${RESET}\n`);
  }
  return true;
}

export async function handleSecret(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const secretSub = parts[1];
  const store = nodyn.getSecretStore();
  if (!store) {
    ctx.stdout.write(`${RED}SecretStore not initialized.${RESET}\n`);
    return true;
  }
  if (!secretSub || secretSub === 'list') {
    const names = store.listNames();
    if (names.length === 0) {
      ctx.stdout.write(`${DIM}No secrets loaded.${RESET}\n`);
    } else {
      for (const name of names) {
        const masked = store.getMasked(name) ?? '***';
        const expired = store.isExpired(name) ? ` ${RED}(expired)${RESET}` : '';
        const consented = store.hasConsent(name) ? ` ${GREEN}(consented)${RESET}` : '';
        ctx.stdout.write(`  ${BOLD}${name}${RESET}: ${masked}${expired}${consented}\n`);
      }
      ctx.stdout.write(`\n${DIM}Vault: ${store.hasVault ? 'enabled' : 'disabled (set NODYN_VAULT_KEY)'}${RESET}\n`);
    }
  } else if (secretSub === 'set') {
    const name = parts[2];
    const value = parts[3];
    if (!name || !value) {
      ctx.stdout.write(`${RED}Usage: /secret set <NAME> <VALUE> [scope]${RESET}\n`);
    } else {
      try {
        const scope = (parts[4] ?? 'any') as import('../../types/index.js').SecretScope;
        store.set(name, value, scope);
        ctx.stdout.write(`${GREEN}Secret '${name}' stored.${RESET}\n`);
      } catch (e: unknown) {
        ctx.stdout.write(`${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
      }
    }
  } else if (secretSub === 'delete') {
    const name = parts[2];
    if (!name) {
      ctx.stdout.write(`${RED}Usage: /secret delete <NAME>${RESET}\n`);
    } else {
      const deleted = store.deleteSecret(name);
      ctx.stdout.write(deleted ? `${GREEN}Secret '${name}' deleted.${RESET}\n` : `${DIM}Secret '${name}' not found.${RESET}\n`);
    }
  } else if (secretSub === 'status') {
    const hasKey = !!process.env['NODYN_VAULT_KEY'];
    ctx.stdout.write(`${BOLD}Vault Status${RESET}\n`);
    ctx.stdout.write(`  Key configured: ${hasKey ? `${GREEN}yes${RESET}` : `${RED}no${RESET} (set NODYN_VAULT_KEY)`}\n`);
    if (hasKey) {
      try {
        const vault = new SecretVault();
        ctx.stdout.write(`  Secrets stored: ${vault.size}\n`);
        vault.close();
      } catch (e: unknown) {
        ctx.stdout.write(`  ${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
      }
    }
  } else if (secretSub === 'migrate') {
    try {
      const vault = new SecretVault();
      const count = vault.migrateFromFile();
      ctx.stdout.write(count > 0
        ? `${GREEN}Migrated ${count} secret(s) to vault. secrets.json renamed to .bak.${RESET}\n`
        : `${DIM}Nothing to migrate.${RESET}\n`);
      vault.close();
    } catch (e: unknown) {
      ctx.stdout.write(`${RED}Error: ${getErrorMessage(e)}${RESET}\n`);
    }
  } else {
    ctx.stdout.write(`${RED}Unknown subcommand. Try: list, set, delete, status, migrate${RESET}\n`);
  }
  return true;
}

export async function handlePlugin(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const pluginSub = parts[1];

  if (!pluginSub || pluginSub === 'list') {
    const installed = PluginManager.listInstalled();
    const pm = nodyn.getPluginManager();
    const loaded = pm ? pm.getLoadedPluginNames() : [];
    if (installed.length === 0 && loaded.length === 0) {
      ctx.stdout.write(`No plugins installed. Use ${BLUE}/plugin add <name>${RESET} to install one.\n`);
    } else {
      ctx.stdout.write(`${BOLD}Plugins:${RESET}\n`);
      for (const name of installed) {
        const active = loaded.includes(name);
        const status = active ? `${GREEN}active${RESET}` : `${DIM}installed${RESET}`;
        ctx.stdout.write(`  ${BLUE}${name}${RESET} — ${status}\n`);
      }
      // Show loaded plugins that might not be in the installed list (e.g. local paths)
      for (const name of loaded) {
        if (!installed.includes(name)) {
          ctx.stdout.write(`  ${BLUE}${name}${RESET} — ${GREEN}active${RESET}\n`);
        }
      }
    }
    return true;
  }

  if (pluginSub === 'add') {
    const pkgName = parts[2];
    if (!pkgName) {
      ctx.stdout.write('Usage: /plugin add <package-name>\n');
      return true;
    }
    ctx.stdout.write(`${DIM}Warning: Plugins run with full access. Only install trusted packages.${RESET}\n`);
    try {
      spinner.start(`Installing ${pkgName}...`);
      PluginManager.install(pkgName);
      spinner.stop();
      PluginManager.enablePlugin(pkgName);
      ctx.stdout.write(`${GREEN}\u2713${RESET} Plugin "${pkgName}" installed and enabled. Restart to activate.\n`);
    } catch (err: unknown) {
      spinner.stop();
      stderr.write(renderError(getErrorMessage(err)));
    }
    return true;
  }

  if (pluginSub === 'remove') {
    const pkgName = parts[2];
    if (!pkgName) {
      ctx.stdout.write('Usage: /plugin remove <package-name>\n');
      return true;
    }
    try {
      spinner.start(`Removing ${pkgName}...`);
      PluginManager.uninstall(pkgName);
      spinner.stop();
      PluginManager.disablePlugin(pkgName);
      ctx.stdout.write(`${GREEN}\u2713${RESET} Plugin "${pkgName}" removed.\n`);
    } catch (err: unknown) {
      spinner.stop();
      stderr.write(renderError(getErrorMessage(err)));
    }
    return true;
  }

  ctx.stdout.write(`Unknown subcommand: ${pluginSub}. Usage: /plugin <add|remove|list>\n`);
  return true;
}
