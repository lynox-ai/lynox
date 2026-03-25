import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { stdin, stdout } from 'node:process';
import { saveUserConfig, getNodynDir, ensureNodynDir, reloadConfig } from '../core/config.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import type { NodynUserConfig, ModelTier } from '../types/index.js';
import { BOLD, DIM, GREEN, RED, YELLOW, RESET } from './ansi.js';
import { confirm, multiSelect } from './interactive.js';
import { renderGradientArt } from './ui.js';
import Anthropic from '@anthropic-ai/sdk';
import { getErrorMessage } from '../core/utils.js';

// ---------------------------------------------------------------------------
// Prerequisites check
// ---------------------------------------------------------------------------

interface PrereqResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

async function checkPrerequisites(): Promise<PrereqResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check Node.js version
  const nodeVersion = parseInt(process.versions.node.split('.')[0]!, 10);
  if (nodeVersion < 22) {
    errors.push(`Node.js 22+ required (found ${process.versions.node}). Update at nodejs.org`);
  }

  // 2. Check ~/.nodyn directory is writable
  try {
    ensureNodynDir();
  } catch {
    errors.push('Cannot create ~/.nodyn directory — check permissions');
  }

  // 3. Check network connectivity (Anthropic API reachable)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    await fetch('https://api.anthropic.com/', { signal: controller.signal, method: 'HEAD' }).catch(() => {
      // HEAD may fail, try a simple GET
      return fetch('https://api.anthropic.com/', { signal: controller.signal, method: 'GET' });
    });
    clearTimeout(timeout);
  } catch {
    warnings.push('Cannot reach api.anthropic.com — API key verification may fail');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Shell profile injection (secure: append-only, with guard check)
// ---------------------------------------------------------------------------

const SHELL_PROFILE_MARKER = '# nodyn vault key';
const SHELL_PROFILE_SOURCE = '[ -f "$HOME/.nodyn/.env" ] && . "$HOME/.nodyn/.env"';

function getShellProfile(): string {
  const shell = process.env['SHELL'] ?? '/bin/bash';
  const shellName = basename(shell);
  switch (shellName) {
    case 'zsh': return join(homedir(), '.zshrc');
    case 'fish': return join(homedir(), '.config', 'fish', 'config.fish');
    default: return join(homedir(), '.bashrc');
  }
}

function isShellProfileConfigured(): boolean {
  const profilePath = getShellProfile();
  try {
    const content = readFileSync(profilePath, 'utf-8');
    return content.includes('.nodyn/.env') || content.includes('NODYN_VAULT_KEY');
  } catch {
    return false;
  }
}

async function offerShellProfileInjection(rl: ReadlineInterface): Promise<void> {
  if (isShellProfileConfigured()) {
    stdout.write(`  ${DIM}Shell profile already configured.${RESET}\n`);
    return;
  }

  const profilePath = getShellProfile();
  const profileName = basename(profilePath);
  const isFish = profilePath.includes('fish');

  // TTY: raw mode (single keypress Y/n). Non-TTY: readline fallback.
  const wantInject = await confirm(`Add to ~/${profileName} (auto-load on shell start)?`, true, stdin.isTTY ? undefined : rl);
  if (!wantInject) {
    stdout.write(`  ${DIM}Manual: add to your shell profile:${RESET}\n`);
    stdout.write(`  ${BOLD}${SHELL_PROFILE_SOURCE}${RESET}\n`);
    return;
  }

  try {
    const snippet = isFish
      ? `\n${SHELL_PROFILE_MARKER}\nif test -f $HOME/.nodyn/.env; source $HOME/.nodyn/.env; end\n`
      : `\n${SHELL_PROFILE_MARKER}\n${SHELL_PROFILE_SOURCE}\n`;
    appendFileSync(profilePath, snippet);
    stdout.write(`  ${GREEN}✓${RESET} Added to ~/${profileName}\n`);
  } catch {
    stdout.write(`  ${YELLOW}⚠${RESET} Could not write to ~/${profileName}. Add manually:\n`);
    stdout.write(`  ${BOLD}${SHELL_PROFILE_SOURCE}${RESET}\n`);
  }
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

async function validateApiKey(key: string): Promise<{ valid: boolean; error?: string | undefined }> {
  try {
    const client = new Anthropic({ apiKey: key });
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { valid: true };
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    if (msg.includes('authentication') || msg.includes('invalid') || msg.includes('401')) {
      return { valid: false, error: 'Invalid API key' };
    }
    return { valid: true, error: `Could not verify (${msg.slice(0, 60)})` };
  }
}

// ---------------------------------------------------------------------------
// Telegram chat ID detection
// ---------------------------------------------------------------------------

async function detectTelegramChatId(token: string): Promise<number | null> {
  let Telegraf: typeof import('telegraf').Telegraf;
  try {
    const telegrafMod = await import('telegraf');
    Telegraf = telegrafMod.Telegraf;
  } catch {
    return null;
  }

  stdout.write(`  ${DIM}Waiting for your Telegram message...${RESET}`);

  return new Promise<number | null>((resolve) => {
    const bot = new Telegraf(token);
    const timeout = setTimeout(() => {
      stdout.write(`\r  ${YELLOW}⚠${RESET} Timeout (2 min). Enter manually below.\n`);
      bot.stop('timeout');
      resolve(null);
    }, 120_000);

    bot.on('message', (ctx) => {
      clearTimeout(timeout);
      stdout.write(`\r  ${GREEN}✓${RESET} Chat ID: ${BOLD}${ctx.chat.id}${RESET}                    \n`);
      bot.stop('detected');
      resolve(ctx.chat.id);
    });

    bot.launch().catch((err: unknown) => {
      clearTimeout(timeout);
      stdout.write(`\r  ${RED}✗${RESET} ${getErrorMessage(err)}\n`);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

/**
 * Run the interactive setup wizard.
 * Accepts a readline interface for testability; creates one from stdin/stdout if not provided.
 * Returns the config that was saved, or null if the user aborted.
 */
export async function runSetupWizard(rl?: ReadlineInterface): Promise<NodynUserConfig | null> {
  const ownRl = !rl;
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  }

  try {
    stdout.write('\n' + renderGradientArt());
    stdout.write(`  ${BOLD}Setup${RESET}  ${DIM}Let's get you up and running.${RESET}\n`);

    // ── Prerequisites ────────────────────────────────────────────
    stdout.write(`\n${DIM}  Checking prerequisites...${RESET}`);
    const prereq = await checkPrerequisites();
    if (!prereq.ok) {
      stdout.write(`\r${RED}✗${RESET} Prerequisites failed:\n`);
      for (const err of prereq.errors) {
        stdout.write(`  ${RED}✗${RESET} ${err}\n`);
      }
      return null;
    }
    stdout.write(`\r  ${GREEN}✓${RESET} Prerequisites OK.     \n`);
    for (const warn of prereq.warnings) {
      stdout.write(`  ${YELLOW}⚠${RESET} ${warn}\n`);
    }

    // ── API Key ─────────────────────────────────────────────────
    stdout.write(`\n  ${BOLD}API Key${RESET}\n`);
    stdout.write(`${DIM}  console.anthropic.com → API Keys → Create Key${RESET}\n`);
    let apiKey = '';
    for (;;) {
      const input = await rl.question(`  ${BOLD}Key:${RESET} `);
      if (!input.trim()) {
        stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
        return null;
      }
      if (!input.trim().startsWith('sk-') || input.trim().length < 20) {
        stdout.write(`  ${YELLOW}⚠${RESET} Should start with "sk-" (20+ chars).\n`);
        continue;
      }
      stdout.write(`  ${DIM}Verifying...${RESET}`);
      const result = await validateApiKey(input.trim());
      if (!result.valid) {
        stdout.write(`\r  ${RED}✗${RESET} ${result.error}. Try again.\n`);
        continue;
      }
      stdout.write(result.error
        ? `\r  ${YELLOW}⚠${RESET} ${result.error}\n`
        : `\r  ${GREEN}✓${RESET} Verified.           \n`);
      apiKey = input.trim();
      break;
    }

    // ── Encryption (always on, no prompt) ────────────────────────
    const vaultKey = randomBytes(36).toString('base64');
    const envPath = join(getNodynDir(), '.env');
    try {
      writeFileAtomicSync(envPath, `NODYN_VAULT_KEY=${vaultKey}\n`);
      process.env['NODYN_VAULT_KEY'] = vaultKey;
      stdout.write(`  ${GREEN}✓${RESET} Encryption enabled.\n`);

      // Close readline before raw-mode prompts (confirm, multiSelect use stdin raw mode)
      if (stdin.isTTY) rl.close();
      await offerShellProfileInjection(rl);
    } catch {
      process.env['NODYN_VAULT_KEY'] = vaultKey;
      stdout.write(`  ${GREEN}✓${RESET} Encryption enabled. Add to your shell profile:\n`);
      stdout.write(`  ${BOLD}export NODYN_VAULT_KEY='${vaultKey}'${RESET}\n`);
      if (stdin.isTTY) rl.close();
    }

    const tier: ModelTier = 'sonnet';

    // ── Integrations (checklist) ────────────────────────────────
    stdout.write(`\n  ${BOLD}Connect integrations${RESET}\n`);

    type Integration = 'google' | 'telegram' | 'websearch';
    const selected = await multiSelect<Integration>([
      { label: 'Google Workspace', value: 'google',    hint: 'Gmail, Sheets, Calendar' },
      { label: 'Telegram',         value: 'telegram',  hint: 'use nodyn from your phone' },
      { label: 'Web Research',     value: 'websearch', hint: 'live research via Tavily' },
    ], stdin.isTTY ? undefined : { rl });

    const wantGoogle = selected.includes('google');
    const wantTelegram = selected.includes('telegram');
    const wantSearch = selected.includes('websearch');

    // Re-open readline for credential text input
    if (stdin.isTTY && (wantGoogle || wantTelegram || wantSearch)) {
      rl = createInterface({ input: stdin, output: stdout, terminal: true });
    }

    // ── Collect credentials for selected integrations ───────────
    let googleClientId = '';
    let googleClientSecret = '';
    if (wantGoogle) {
      stdout.write(`\n  ${BOLD}Google Workspace${RESET}\n`);
      stdout.write(`${DIM}  GCP Console → APIs & Services → Credentials → OAuth 2.0${RESET}\n`);
      googleClientId = (await rl.question(`  ${BOLD}Client ID:${RESET} `)).trim();
      if (googleClientId) {
        googleClientSecret = (await rl.question(`  ${BOLD}Client Secret:${RESET} `)).trim();
        stdout.write(`  ${GREEN}✓${RESET} Run ${BOLD}/google auth${RESET} after setup to connect.\n`);
      }
    }

    let telegramToken = '';
    let telegramChatIds: number[] | undefined;
    if (wantTelegram) {
      stdout.write(`\n  ${BOLD}Telegram${RESET}\n`);
      stdout.write(`${DIM}  Create a bot: open Telegram → @BotFather → /newbot${RESET}\n`);
      telegramToken = (await rl.question(`  ${BOLD}Bot token:${RESET} `)).trim();
      if (telegramToken) {
        stdout.write(`  ${DIM}Now send any message to your bot in Telegram.${RESET}\n`);
        const chatId = await detectTelegramChatId(telegramToken);
        if (chatId !== null) {
          telegramChatIds = [chatId];
          const moreIds = await rl.question(`  ${DIM}More chat IDs? (comma-separated, or Enter):${RESET} `);
          if (moreIds.trim()) {
            telegramChatIds.push(...moreIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n)));
          }
          stdout.write(`  ${GREEN}✓${RESET} Telegram ready.\n`);
        } else {
          const manual = await rl.question(`  ${BOLD}Chat ID:${RESET} `);
          if (manual.trim()) {
            telegramChatIds = manual.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
          }
          stdout.write(telegramChatIds?.length
            ? `  ${GREEN}✓${RESET} Telegram ready.\n`
            : `  ${YELLOW}⚠${RESET} No chat ID — bot starts in setup mode.\n`);
        }
      }
    }

    let searchKey = '';
    if (wantSearch) {
      stdout.write(`\n  ${BOLD}Web Research${RESET}\n`);
      stdout.write(`${DIM}  Free: tavily.com (1K requests/month)${RESET}\n`);
      searchKey = (await rl.question(`  ${BOLD}Tavily key:${RESET} `)).trim();
      if (searchKey) stdout.write(`  ${GREEN}✓${RESET} Enabled.\n`);
    }

    // ── Save ────────────────────────────────────────────────────
    const config: NodynUserConfig = {
      api_key: apiKey,
      default_tier: tier,
    };
    if (telegramToken) {
      config.telegram_bot_token = telegramToken;
      if (telegramChatIds && telegramChatIds.length > 0) {
        config.telegram_allowed_chat_ids = telegramChatIds;
      }
    }
    if (searchKey) {
      config.search_api_key = searchKey;
      config.search_provider = 'tavily';
    }
    if (googleClientId && googleClientSecret) {
      config.google_client_id = googleClientId;
      config.google_client_secret = googleClientSecret;
    }
    saveUserConfig(config);
    reloadConfig();

    // ── Summary ─────────────────────────────────────────────────
    stdout.write(`\n  ${GREEN}${BOLD}✓ Setup complete${RESET}\n\n`);
    stdout.write(`  API Key        ${GREEN}✓${RESET}\n`);
    stdout.write(`  Encryption     ${GREEN}✓${RESET}\n`);
    if (googleClientId) stdout.write(`  Google         ${GREEN}✓${RESET} ${DIM}/google auth${RESET}\n`);
    if (telegramToken) stdout.write(`  Telegram       ${telegramChatIds?.length ? `${GREEN}✓${RESET}` : `${YELLOW}setup mode${RESET}`}\n`);
    if (searchKey) stdout.write(`  Web Research   ${GREEN}✓${RESET}\n`);
    if (!googleClientId && !telegramToken && !searchKey) {
      stdout.write(`${DIM}  Add integrations anytime: /google, /telegram, /config${RESET}\n`);
    }
    stdout.write('\n');

    return config;
  } finally {
    if (ownRl) {
      rl.close();
    }
  }
}
