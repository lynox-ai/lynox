/**
 * Vault CLI command: /vault rotate
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import { SecretVault } from '../../core/secret-vault.js';
import { GREEN, RED, YELLOW, DIM, RESET } from '../ui.js';
import type { CLICtx } from './types.js';
import type { Session } from '../../core/session.js';

const VAULT_PATH = resolve(homedir(), '.lynox', 'vault.db');

export async function handleVault(parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  const subCommand = parts[1];

  if (subCommand === 'rotate') {
    return handleRotate(ctx);
  }

  ctx.stdout.write(`Usage: /vault rotate\n`);
  ctx.stdout.write(`${DIM}Rotate the vault master key (re-encrypts all secrets).${RESET}\n`);
  return true;
}

async function handleRotate(ctx: CLICtx): Promise<boolean> {
  if (!existsSync(VAULT_PATH)) {
    ctx.stdout.write(`${RED}No vault found at ${VAULT_PATH}${RESET}\n`);
    return true;
  }

  const currentKey = process.env['LYNOX_VAULT_KEY'];
  if (!currentKey) {
    ctx.stdout.write(`${RED}LYNOX_VAULT_KEY not set — cannot decrypt current vault.${RESET}\n`);
    return true;
  }

  if (!ctx.cliPrompt) {
    ctx.stdout.write(`${RED}Interactive mode required for key rotation.${RESET}\n`);
    return true;
  }

  ctx.stdout.write(`${YELLOW}⚠${RESET} This will re-encrypt all vault secrets with a new key.\n`);
  ctx.stdout.write(`${DIM}Current vault: ${VAULT_PATH}${RESET}\n\n`);

  const newKey = await ctx.cliPrompt('New master key (min 16 chars):');
  if (!newKey || newKey.length < 16) {
    ctx.stdout.write(`${RED}Aborted — key must be at least 16 characters.${RESET}\n`);
    return true;
  }

  const confirm = await ctx.cliPrompt('Confirm new key:');
  if (confirm !== newKey) {
    ctx.stdout.write(`${RED}Keys do not match. Aborted.${RESET}\n`);
    return true;
  }

  try {
    const count = SecretVault.rotateVault(VAULT_PATH, currentKey, newKey);
    ctx.stdout.write(`\n${GREEN}✓${RESET} Vault rotated — ${count} secret${count !== 1 ? 's' : ''} re-encrypted.\n`);
    ctx.stdout.write(`${YELLOW}⚠${RESET} Update LYNOX_VAULT_KEY in your environment to the new key.\n`);
    ctx.stdout.write(`${DIM}Restart lynox after updating the environment variable.${RESET}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.stdout.write(`${RED}Rotation failed: ${msg}${RESET}\n`);
  }

  return true;
}
