import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { stdin, stdout } from 'node:process';
import { saveUserConfig, getLynoxDir, ensureLynoxDir, reloadConfig } from '../core/config.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import type { LynoxUserConfig, ModelTier } from '../types/index.js';
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

  // 2. Check ~/.lynox directory is writable
  try {
    ensureLynoxDir();
  } catch {
    const dir = getLynoxDir();
    errors.push(
      `Cannot create ${dir} directory.\n` +
      `    Fix: mkdir -p ${dir} && chmod 700 ${dir}\n` +
      `    If on a shared system, check disk quota: df -h ~`,
    );
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

const SHELL_PROFILE_MARKER = '# lynox vault key';
const SHELL_PROFILE_SOURCE = '[ -f "$HOME/.lynox/.env" ] && . "$HOME/.lynox/.env"';

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
    return content.includes('.lynox/.env') || content.includes('LYNOX_VAULT_KEY');
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
      ? `\n${SHELL_PROFILE_MARKER}\nif test -f $HOME/.lynox/.env; source $HOME/.lynox/.env; end\n`
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
    if (msg.includes('429') || msg.includes('rate')) {
      return { valid: false, error: 'Rate limited — wait a moment and try again' };
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
      return { valid: false, error: 'Anthropic API is temporarily unavailable — try again shortly' };
    }
    // Only connectivity failures get the benefit of the doubt
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch') || msg.includes('network')) {
      return { valid: true, error: `Could not verify (${msg.slice(0, 60)}) — will validate on first use` };
    }
    return { valid: false, error: `Verification failed: ${msg.slice(0, 80)}` };
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
    const progressHint = setTimeout(() => {
      stdout.write(`\r  ${DIM}Still waiting... make sure you sent a message to your bot in Telegram.${RESET}`);
    }, 30_000);
    const timeout = setTimeout(() => {
      clearTimeout(progressHint);
      stdout.write(`\r  ${YELLOW}⚠${RESET} Timeout (2 min). Enter your chat ID manually below.              \n`);
      stdout.write(`  ${DIM}To find it: open https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates${RESET}\n`);
      stdout.write(`  ${DIM}after messaging your bot. Look for "chat":{"id": YOUR_NUMBER }${RESET}\n`);
      bot.stop('timeout');
      resolve(null);
    }, 120_000);

    bot.on('message', (ctx) => {
      clearTimeout(timeout);
      clearTimeout(progressHint);
      stdout.write(`\r  ${GREEN}✓${RESET} Chat ID: ${BOLD}${ctx.chat.id}${RESET}                    \n`);
      void ctx.reply('✓ Connected! Setup continues in the terminal.').catch(() => {});
      // Small delay so the reply is sent before the bot stops
      setTimeout(() => { bot.stop('detected'); resolve(ctx.chat.id); }, 500);
    });

    bot.launch().catch((err: unknown) => {
      clearTimeout(timeout);
      clearTimeout(progressHint);
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
export async function runSetupWizard(rl?: ReadlineInterface): Promise<LynoxUserConfig | null> {
  const ownRl = !rl;
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  }

  try {
    stdout.write('\n' + renderGradientArt());
    stdout.write(`  ${BOLD}Setup${RESET}  ${DIM}Let's get you up and running.${RESET}\n`);

    // ── Prerequisites (with retry) ──────────────────────────────
    const MAX_PREREQ_RETRIES = 3;
    for (let prereqAttempt = 1; prereqAttempt <= MAX_PREREQ_RETRIES; prereqAttempt++) {
      stdout.write(`\n${DIM}  Checking prerequisites...${RESET}`);
      const prereq = await checkPrerequisites();
      if (prereq.ok) {
        stdout.write(`\r  ${GREEN}✓${RESET} Prerequisites OK.     \n`);
        for (const warn of prereq.warnings) {
          stdout.write(`  ${YELLOW}⚠${RESET} ${warn}\n`);
        }
        break;
      }
      stdout.write(`\r${RED}✗${RESET} Prerequisites failed:\n`);
      for (const err of prereq.errors) {
        stdout.write(`  ${RED}✗${RESET} ${err}\n`);
      }
      if (prereqAttempt >= MAX_PREREQ_RETRIES) {
        stdout.write(`\n  ${RED}✗${RESET} Could not resolve prerequisites after ${MAX_PREREQ_RETRIES} attempts.\n`);
        return null;
      }
      stdout.write(`\n  ${DIM}Fix the issues above, then press Enter to retry (${prereqAttempt}/${MAX_PREREQ_RETRIES})...${RESET}`);
      await rl.question('');
    }

    // ── API Key ─────────────────────────────────────────────────
    stdout.write(`\n  ${BOLD}API Key${RESET}\n`);
    stdout.write(`${DIM}  console.anthropic.com → API Keys → Create Key${RESET}\n`);
    let apiKey = '';
    const MAX_KEY_ATTEMPTS = 5;
    for (let keyAttempt = 1; keyAttempt <= MAX_KEY_ATTEMPTS; keyAttempt++) {
      const input = await rl.question(`  ${BOLD}Key:${RESET} `);
      if (!input.trim()) {
        stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
        return null;
      }
      if (!input.trim().startsWith('sk-') || input.trim().length < 20) {
        stdout.write(`  ${YELLOW}⚠${RESET} Should start with "sk-" (20+ chars).\n`);
        if (keyAttempt >= 3) {
          stdout.write(`  ${DIM}Get a key at: https://console.anthropic.com/settings/keys${RESET}\n`);
        }
        continue;
      }
      stdout.write(`  ${DIM}Verifying...${RESET}`);
      const result = await validateApiKey(input.trim());
      if (!result.valid) {
        stdout.write(`\r  ${RED}✗${RESET} ${result.error}.\n`);
        if (keyAttempt >= 3) {
          stdout.write(`  ${DIM}Hint: check for trailing spaces or line breaks in the copied key.${RESET}\n`);
        }
        if (keyAttempt >= MAX_KEY_ATTEMPTS) {
          stdout.write(`  ${YELLOW}⚠${RESET} Max attempts reached. Run ${BOLD}lynox --init${RESET} to try again.\n`);
          return null;
        }
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
    const envPath = join(getLynoxDir(), '.env');
    try {
      writeFileAtomicSync(envPath, `LYNOX_VAULT_KEY=${vaultKey}\n`);
      process.env['LYNOX_VAULT_KEY'] = vaultKey;
      stdout.write(`  ${GREEN}✓${RESET} Encryption enabled.\n`);

      // Close readline before raw-mode prompts (confirm, multiSelect use stdin raw mode)
      if (stdin.isTTY) rl.close();
      await offerShellProfileInjection(rl);
    } catch {
      process.env['LYNOX_VAULT_KEY'] = vaultKey;
      stdout.write(`  ${GREEN}✓${RESET} Encryption enabled. Add to your shell profile:\n`);
      stdout.write(`  ${BOLD}export LYNOX_VAULT_KEY='${vaultKey}'${RESET}\n`);
      if (stdin.isTTY) rl.close();
    }

    const tier: ModelTier = 'sonnet';

    // ── Integrations (checklist) ────────────────────────────────
    stdout.write(`\n  ${BOLD}Connect integrations${RESET}\n`);

    type Integration = 'google' | 'telegram' | 'websearch';
    const selected = await multiSelect<Integration>([
      { label: 'Google Workspace', value: 'google',    hint: 'Gmail, Sheets, Calendar' },
      { label: 'Telegram',         value: 'telegram',  hint: 'use lynox from your phone' },
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
          stdout.write(`  ${GREEN}✓${RESET} Telegram ready.\n`);
        } else {
          const manual = (await rl.question(`  ${BOLD}Chat ID:${RESET} `)).trim();
          if (manual) {
            const parsed = parseInt(manual, 10);
            if (Number.isFinite(parsed)) {
              telegramChatIds = [parsed];
            }
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
    const config: LynoxUserConfig = {
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
