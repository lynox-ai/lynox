#!/usr/bin/env node
/**
 * Suppress Node.js deprecation warnings (DEP0040 punycode) in CLI output.
 *
 * Why: Node.js has no API to selectively suppress specific deprecation warnings
 * without --no-deprecation (which hides all). The punycode warning comes from
 * transitive dependencies (@anthropic-ai/sdk → node-fetch → whatwg-url) and
 * cannot be fixed in user code.
 *
 * Scope: Only suppresses DeprecationWarning events. All other process warnings
 * (uncaughtException, unhandledRejection, etc.) pass through unchanged.
 *
 * Remove when: All transitive deps drop punycode usage.
 */
const _origEmit = process.emit;
process.emit = function (event: string, ...args: unknown[]) {
  if (event === 'warning' && args[0] && typeof args[0] === 'object' && (args[0] as { name?: string }).name === 'DeprecationWarning') {
    return false;
  }
  return _origEmit.call(process, event, ...args);
} as typeof process.emit;
// === Module exports ===
export { Agent } from './core/agent.js';
export { StreamProcessor } from './core/stream.js';
export { Memory } from './core/memory.js';
export { Engine } from './core/engine.js';
export { Session } from './core/session.js';
export { BatchIndex } from './core/batch-index.js';
export { SessionStore } from './core/session-store.js';
export { channels, measureTool } from './core/observability.js';
export { initDebugSubscriber, shutdownDebugSubscriber, parseDebugFilter } from './core/debug-subscriber.js';
export { ToolRegistry } from './tools/registry.js';
export { LynoxMCPServer } from './server/mcp-server.js';
export { CostGuard } from './core/cost-guard.js';
export { loadConfig, saveUserConfig, hasApiKey, getLynoxDir, ensureLynoxDir, setDataDir } from './core/config.js';
export { RunHistory, hashTask } from './core/run-history.js';
export { calculateCost, getPricing } from './core/pricing.js';
export { createEmbeddingProvider, cosineSimilarity } from './core/embedding.js';
export { temporalDecay, MEMORY_HALF_LIFE_DAYS } from './core/memory-gc.js';
export { PluginManager } from './core/plugins.js';
export { runManifest, loadManifestFile, validateManifest } from './orchestrator/runner.js';
export type {
  Manifest, ManifestStep, AgentDef, AgentOutput, RunState, RunHooks,
} from './orchestrator/types.js';
export { globToRegex, extractMatchString, matchesPreApproval, buildApprovalSet, isCriticalTool } from './core/pre-approve.js';

export { planDAG, estimatePipelineCost } from './core/dag-planner.js';
export type { DagPlanResult } from './core/dag-planner.js';
export { spawnInline, spawnPipeline, resolveModel } from './orchestrator/runtime-adapter.js';
export { retryManifest } from './orchestrator/runner.js';
export type { InlinePipelineStep, PipelineResult, PipelineStepResult, PlannedPipeline, SecretStoreLike, SecretEntry, SecretScope } from './types/index.js';
export { SecretStore, SECRET_REF_PATTERN } from './core/secret-store.js';
export { SecretVault, estimateKeyEntropy } from './core/secret-vault.js';
export type { VaultEntry, VaultOptions } from './core/secret-vault.js';
export { resolveActiveScopes, scopeWeight, scopeToDir, parseScopeString, formatScopeRef, isMoreSpecific, inferScopeFromContext, SCOPE_ORDER, SEMANTIC_OVERRIDE_THRESHOLD } from './core/scope-resolver.js';
export type { ScopeContext, ScopeOverride } from './core/scope-resolver.js';
export { classifyScope } from './core/scope-classifier.js';
export type { ScopeClassification } from './types/index.js';
export { runMemoryGc } from './core/memory-gc.js';
export { TaskManager } from './core/task-manager.js';
export type { TaskCreateParams, TaskUpdateParams, WeekSummary } from './core/task-manager.js';
export type { GcOptions, GcResult } from './core/memory-gc.js';
export { detectProjectRoot } from './core/project.js';
export type { ProjectInfo } from './core/project.js';
export { resolveContext } from './core/context.js';
export type { LynoxContext, ContextSource } from './types/index.js';
export { runSetupWizard } from './cli/setup-wizard.js';
export { startTelegramBot, stopTelegramBot, getTelegramBot } from './integrations/telegram/telegram-bot.js';
export { TelegramNotificationChannel } from './integrations/telegram/telegram-notification.js';
export { GoogleAuth, SCOPES, READ_ONLY_SCOPES, WRITE_SCOPES, createGoogleTools } from './integrations/google/index.js';
export type { GoogleAuthOptions, DeviceFlowPrompt, LocalAuthResult } from './integrations/google/index.js';
export { getRole, getRoleNames, BUILTIN_ROLES } from './core/roles.js';
export type { RoleConfig } from './core/roles.js';
export { isFeatureEnabled, getFeatureFlags, getFeatureEnvVar, registerFeature, clearDynamicFeatures } from './core/features.js';
export type { FeatureFlag } from './core/features.js';
export type { LynoxHooks, RunContext, AccumulatedUsage } from './core/engine.js';
export { NotificationRouter } from './core/notification-router.js';
export type { NotificationChannel, NotificationMessage } from './core/notification-router.js';
export { WorkerLoop } from './core/worker-loop.js';
export * from './types/index.js';

// === Error hierarchy ===
export { LynoxError, ValidationError, ConfigError, ExecutionError, ToolError, NotFoundError } from './core/errors.js';

// === Backup ===
export { BackupManager } from './core/backup.js';
export type { BackupManifest, BackupResult, RestoreResult, BackupConfig } from './core/backup.js';
export type { VerifyResult, BackupFileEntry } from './core/backup-verify.js';
export { GDriveBackupUploader } from './core/backup-upload-gdrive.js';
export type { RemoteBackupInfo, UploadResult, DownloadResult } from './core/backup-upload-gdrive.js';

// === CRM ===
export { CRM } from './core/crm.js';
export type { ContactData, DealData, InteractionData, ContactRecord } from './core/crm.js';

// === API Store ===
export { ApiStore } from './core/api-store.js';
export type { ApiProfile, ApiEndpoint, ApiAuth, ApiRateLimit } from './core/api-store.js';

// === Sentry (opt-in error reporting) ===
export {
  initSentry, shutdownSentry, captureLynoxError, captureError,
  captureUserFeedback, isSentryEnabled,
  addToolBreadcrumb, addLLMBreadcrumb,
} from './core/sentry.js';

// === ToolContext ===
export { createToolContext } from './core/tool-context.js';

// === Utilities needed by Pro ===
export { writeFileAtomicSync, ensureDirSync, ensureDir } from './core/atomic-write.js';
export { getErrorMessage, sleep } from './core/utils.js';
export { renderTable } from './cli/ui.js';
export { ChangesetManager } from './core/changeset.js';
export { planTaskTool } from './tools/builtin/plan-task.js';
export { RESET, BOLD, DIM, RED, GREEN, BLUE, MAGENTA, GRAY, stripAnsi } from './cli/ansi.js';

// === Workspace ===
export { setTenantWorkspace, ensureContextWorkspace } from './core/workspace.js';


// === CLI ===

import { readSync } from 'node:fs';
import { stdin, stdout, stderr, argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';

import { Engine } from './core/engine.js';
import type { Session } from './core/session.js';
import type { StreamEvent } from './types/index.js';
import { MODEL_MAP, getModelId } from './types/index.js';
import { getActiveProvider, isBedrockEuOnly } from './core/llm-client.js';
import { hasApiKey, setDataDir } from './core/config.js';
import { runSetupWizard } from './cli/setup-wizard.js';

import { renderError, BOLD, DIM, BLUE, GREEN, RED, YELLOW, MAGENTA, RESET } from './cli/ui.js';
import { Watchdog } from './cli/watchdog.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import { writeFileAtomicSync } from './core/atomic-write.js';
import { getErrorMessage } from './core/utils.js';

import { state, spinner, toolsUsed } from './cli/cli-state.js';
import { streamHandler as _streamHandler } from './cli/stream-handler.js';

// Wrapped stream handler that binds stdout
function streamHandler(event: StreamEvent): void {
  _streamHandler(event, stdout);
}

/**
 * Load ~/.lynox/.env if it exists and LYNOX_VAULT_KEY is not already set.
 * This ensures the vault key survives restarts without requiring the user
 * to manually source the file. The entrypoint.sh does this for Docker;
 * this is the equivalent for local npm/npx usage.
 *
 * Security:
 * - Only reads LYNOX_VAULT_KEY from the file (line-by-line parsing, no eval)
 * - Rejects symlinks (must be a regular file)
 * - Rejects files with group/other permissions (must be 0o600 or 0o400)
 * - Rejects files not owned by the current user (Unix only)
 * - Validates vault key format (base64, reasonable length)
 */
const VAULT_KEY_PATTERN = /^[A-Za-z0-9+/=]{32,128}$/;

function loadDotEnv(): void {
  if (process.env['LYNOX_VAULT_KEY']) return; // already set
  try {
    const envPath = join(homedir(), '.lynox', '.env');
    if (!existsSync(envPath)) return;

    // Security: reject symlinks
    const lstats = lstatSync(envPath);
    if (!lstats.isFile()) {
      stderr.write(`${YELLOW}⚠${RESET} ~/.lynox/.env is not a regular file — skipping\n`);
      return;
    }

    // Security: check ownership (Unix only — process.getuid available on POSIX)
    const stats = statSync(envPath);
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      stderr.write(`${YELLOW}⚠${RESET} ~/.lynox/.env is not owned by you — skipping\n`);
      return;
    }

    // Security: reject group/other readable (must be 0o600 or stricter)
    if ((stats.mode & 0o077) !== 0) {
      stderr.write(`${YELLOW}⚠${RESET} ~/.lynox/.env has insecure permissions (${(stats.mode & 0o777).toString(8)}). Run: chmod 600 ~/.lynox/.env\n`);
      return;
    }

    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // Only load vault key — never auto-set API keys or other secrets from dotenv
      if (key === 'LYNOX_VAULT_KEY' && value) {
        // Validate format: base64 string, reasonable length (32-128 chars)
        if (!VAULT_KEY_PATTERN.test(value)) {
          stderr.write(`${YELLOW}⚠${RESET} Invalid LYNOX_VAULT_KEY format in ~/.lynox/.env — skipping\n`);
          return;
        }
        // Lightweight entropy check: warn if key has very few unique chars
        const uniqueChars = new Set(value).size;
        if (uniqueChars < 10) {
          stderr.write(`${YELLOW}⚠${RESET} Vault key has low entropy (${uniqueChars} unique chars). Generate a strong key: openssl rand -base64 48\n`);
        }
        process.env['LYNOX_VAULT_KEY'] = value;
        return;
      }
    }
  } catch {
    // Best-effort: if the file is unreadable, vault init will warn later
  }
}

async function runCLI(): Promise<void> {
  const args = argv.slice(2);

  // Load vault key from ~/.lynox/.env before anything else
  loadDotEnv();

  // === --help flag ===
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write(`lynox ${pkg.version}

Usage:
  lynox                         Start Engine + open Web UI (setup wizard on first run)
  lynox "<task>"                Run a single task and exit
  cat file | lynox "<task>"     Process piped input with a task
  lynox init                    Run the setup wizard
  lynox --http-api              Start Engine HTTP API server (headless)
  lynox --mcp-server            Start as MCP server (stdio)
  lynox --mcp-server --transport sse   Start as MCP server (HTTP/SSE)
  lynox --telegram              Start Telegram bot mode
  lynox --watch <glob> --on-change "<task>"   Watch files and run task on change

Options:
  --help, -h                    Show this help
  --version, -v                 Show version
  --init                        Run setup wizard
  --project <dir>               Set project directory
  --manifest <file>             Run a workflow manifest
  --task "<title>"              Create a background task and exit
  --output <file>               Save output to file
  --data-dir <dir>              Override data directory (default: ~/.lynox)

Environment:
  ANTHROPIC_API_KEY             Anthropic API key (required)
  ANTHROPIC_BASE_URL            Custom API endpoint (for proxies)
  LYNOX_DATA_DIR                Override data directory (same as --data-dir)
  LYNOX_HTTP_PORT               HTTP API port (default: 3100)
  LYNOX_HTTP_SECRET             HTTP API Bearer token (enables network binding)
  LYNOX_WEBUI_URL               Web UI URL to open (default: http://localhost:5173)
  TELEGRAM_BOT_TOKEN            Auto-start Telegram bot mode
  TAVILY_API_KEY                Enable web search tool

Docs: https://docs.lynox.dev
`);
    return;
  }

  // === --version flag ===
  if (args.includes('--version') || args.includes('-v')) {
    stdout.write(`lynox ${pkg.version}\n`);
    return;
  }

  const projectIdx = args.indexOf('--project');
  const projectArg = projectIdx !== -1 ? args[projectIdx + 1] : undefined;

  if (projectArg) {
    const projectDir = resolve(projectArg);
    process.chdir(projectDir);
    const configPath = join(projectDir, '.lynox', 'config.json');
    if (existsSync(configPath)) {
      stderr.write(`${DIM}Project config loaded from ${configPath}${RESET}\n`);
    }
  }

  // === --data-dir flag ===
  const dataDirIdx = args.indexOf('--data-dir');
  const dataDirArg = dataDirIdx !== -1 ? args[dataDirIdx + 1] : undefined;
  if (dataDirArg) {
    setDataDir(resolve(dataDirArg));
  }

  // === HTTP API mode ===
  if (args.includes('--http-api')) {
    const { LynoxHTTPApi } = await import('./server/http-api.js');
    const rawPort = parseInt(process.env['LYNOX_HTTP_PORT'] ?? '3100', 10);
    const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 3100;
    const api = new LynoxHTTPApi();
    await api.init();
    await api.start(port);

    // Graceful shutdown — close KG + DBs before exit to prevent WAL corruption
    let shuttingDown = false;
    const graceful = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`\n[lynox] ${signal} received — shutting down…\n`);
      try { await api.shutdown(); } catch { /* best-effort */ }
      process.exit(0);
    };
    process.on('SIGINT', () => void graceful('SIGINT'));
    process.on('SIGTERM', () => void graceful('SIGTERM'));
    return;
  }

  // === Setup wizard (explicit --init / "init" subcommand, or auto when no API key) ===
  if (args.includes('--init') || args[0] === 'init') {
    const wizardResult = await runSetupWizard();
    if (!wizardResult) {
      stderr.write('No API key configured. Run "lynox init" to set up.\n');
      process.exit(1);
    }
    // Continue to default mode (HTTP API + Web UI)
  } else if (!hasApiKey() && stdin.isTTY) {
    const wizardResult = await runSetupWizard();
    if (!wizardResult) {
      stderr.write('No API key configured. Run "lynox init" to set up.\n');
      process.exit(1);
    }
    // Continue to default mode (HTTP API + Web UI)
  }

  // === MCP Server mode ===
  if (args.includes('--mcp-server')) {
    const { LynoxMCPServer } = await import('./server/mcp-server.js');
    const mcpServer = new LynoxMCPServer({});
    await mcpServer.init();
    const transportIdx = args.indexOf('--transport');
    if (transportIdx !== -1 && args[transportIdx + 1] === 'sse') {
      const port = parseInt(process.env['LYNOX_MCP_PORT'] ?? '3042', 10);
      await mcpServer.startHTTP(port);
    } else {
      await mcpServer.startStdio();
    }
    return;
  }

  // === Telegram bot mode ===
  if (args.includes('--telegram') || process.env['TELEGRAM_BOT_TOKEN']) {
    const { loadConfig: loadCfg } = await import('./core/config.js');
    const cfg = loadCfg();
    const token = process.env['TELEGRAM_BOT_TOKEN'] ?? cfg.telegram_bot_token;
    if (!token) {
      stderr.write('TELEGRAM_BOT_TOKEN required (env var or config)\n');
      process.exit(1);
    }
    const tgEngine = new Engine({});
    await tgEngine.init();

    const allowedRaw = process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    const allowedChatIds = allowedRaw
      ? allowedRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
      : cfg.telegram_allowed_chat_ids;

    const { startTelegramBot: startTgBot, stopTelegramBot: stopTgBot } = await import('./integrations/telegram/telegram-bot.js');

    const shutdown = async () => {
      await stopTgBot();
      await tgEngine.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    await startTgBot({ token, allowedChatIds, engine: tgEngine });

    // Register Telegram notification channel for background task results
    const { getTelegramBot } = await import('./integrations/telegram/telegram-bot.js');
    const { TelegramNotificationChannel } = await import('./integrations/telegram/telegram-notification.js');
    const notifyChatId = allowedChatIds?.[0];
    const tgBot = getTelegramBot();
    if (notifyChatId && tgBot) {
      tgEngine.getNotificationRouter().register(new TelegramNotificationChannel(tgBot, notifyChatId));
    }

    // Start background worker loop for scheduled task execution
    tgEngine.startWorkerLoop();

    return;
  }

  const engine = new Engine({});
  state.currentModelId = getModelId(engine.config.model ?? 'sonnet', getActiveProvider(), isBedrockEuOnly());
  const initPromise = engine.init();

  let session: Session;
  const ensureSession = async (): Promise<Session> => {
    await initPromise;
    if (!session) {
      session = engine.createSession();
      session.onStream = streamHandler;
      state.activeSession = session;
    }
    return session;
  };

  // === --manifest flag ===
  const manifestIdx = args.indexOf('--manifest');
  const manifestFlag = manifestIdx !== -1 ? args[manifestIdx + 1] : undefined;
  if (manifestFlag) {
    session = await ensureSession();
    const { runManifest: runMf, loadManifestFile: loadMf } = await import('./orchestrator/runner.js');
    const { LocalGateAdapter: LocalAdapter } = await import('./orchestrator/gates.js');
    const { loadConfig: getConfig } = await import('./core/config.js');
    const cfg = getConfig();
    let gateAdapter: import('./orchestrator/types.js').GateAdapter | undefined;
    if (stdin.isTTY) {
      const { confirm } = await import('./cli/interactive.js');
      gateAdapter = new LocalAdapter(async (q: string) => {
        const approved = await confirm(q);
        return approved ? 'Yes, approve' : 'No, reject';
      });
    }
    try {
      const manifest = loadMf(resolve(manifestFlag));
      stderr.write(`${BLUE}▶${RESET} Running manifest: ${BOLD}${manifest.name}${RESET}\n`);
      const state = await runMf(manifest, cfg, {
        gateAdapter,
        hooks: {
          onStepStart: (stepId, agentName) => {
            spinner.start(`${stepId} (${agentName})...`);
          },
          onStepComplete: (output) => {
            spinner.stop();
            stdout.write(`  ${GREEN}✓${RESET} ${output.stepId} — ${DIM}${output.durationMs}ms, $${output.costUsd.toFixed(4)}${RESET}\n`);
          },
          onStepSkipped: (stepId, reason) => {
            spinner.stop();
            stdout.write(`  ${DIM}⊘ ${stepId} skipped: ${reason}${RESET}\n`);
          },
          onGateSubmit: (stepId, approvalId) => {
            stdout.write(`  ${MAGENTA}⏳${RESET} Gate pending for ${stepId} (${approvalId})\n`);
          },
          onGateDecision: (stepId, decision) => {
            const icon = decision.status === 'approved' ? `${GREEN}✓` : `${RED}✗`;
            stdout.write(`  ${icon}${RESET} Gate ${decision.status} for ${stepId}\n`);
          },
          onError: (stepId, err) => {
            spinner.stop();
            stderr.write(renderError(`${stepId}: ${err.message}`));
          },
          onRunComplete: (s) => {
            const icon = s.status === 'completed' ? `${GREEN}✓` : `${RED}✗`;
            stdout.write(`${icon}${RESET} Manifest ${s.manifestName} — ${BOLD}${s.status}${RESET}\n`);
          },
        },
      });
      if (state.status === 'failed' || state.status === 'rejected') process.exit(1);
    } catch (err: unknown) {
      spinner.stop();
      stderr.write(renderError(getErrorMessage(err)));
      process.exit(1);
    }
    await engine.shutdown();
    process.exit(0);
  }

  // === Sprint 8b: Pipe detection ===
  let pipedInput = '';
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    try {
      const buf = Buffer.alloc(65536);
      let bytesRead: number;
      do {
        bytesRead = readSync(0, buf, 0, buf.length, null);
        if (bytesRead > 0) {
          chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
        }
      } while (bytesRead > 0);
    } catch {
      // no piped input or error reading
    }
    if (chunks.length > 0) {
      pipedInput = Buffer.concat(chunks).toString('utf-8');
    }
  }

  // === Single task mode ===
  const flagsWithValues = new Set(['--project', '--output', '--watch', '--on-change', '--transport', '--manifest', '--task']);
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      if (flagsWithValues.has(args[i]!)) i++; // skip value
      continue;
    }
    filteredArgs.push(args[i]!);
  }
  const singleTask = filteredArgs.join(' ');

  if (singleTask || pipedInput) {
    if (!hasApiKey()) {
      stderr.write(`${RED}✗${RESET} No API key configured.\n`);
      stderr.write(`${DIM}Set ANTHROPIC_API_KEY or run interactively: npx @lynox-ai/core${RESET}\n`);
      process.exit(1);
    }
    session = await ensureSession();
    stderr.write(`${DIM}model: ${state.currentModelId}${RESET}\n`);
    state.pipeSummaryEnabled = true;
    toolsUsed.clear();
    state.lastUsage = null;
    state.turnCount = 0;
    state.hadError = false;
    const task = pipedInput
      ? (singleTask ? `${singleTask}\n\n<input>\n${pipedInput}\n</input>` : pipedInput)
      : singleTask;

    if (!task.trim()) {
      stderr.write(`${RED}✗${RESET} No input provided. Pass a task as argument or via stdin.\n`);
      await engine.shutdown();
      process.exit(1);
    }

    try {
      await session.run(task);
    } finally {
      // === Pipe-mode JSON summary on stderr ===
      if (state.pipeSummaryEnabled && state.lastUsage) {
        const u = state.lastUsage;
        const inTok = (u['input_tokens'] ?? 0)
          + (u['cache_creation_input_tokens'] ?? 0)
          + (u['cache_read_input_tokens'] ?? 0);
        const cacheRead = u['cache_read_input_tokens'] ?? 0;
        const summary = {
          model: state.currentModelId,
          turns: state.turnCount,
          tokens_in: inTok,
          tokens_out: u['output_tokens'] ?? 0,
          cache_pct: inTok > 0 ? Math.round((cacheRead / inTok) * 100) : 0,
          tools: [...toolsUsed],
          error: state.hadError,
        };
        stderr.write(`\n__LYNOX_SUMMARY__${JSON.stringify(summary)}\n`);
      }
      // === Sprint 8a: --output flag ===
      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
      if (outputPath && state.lastResponse) {
        const resolvedOutput = resolve(outputPath);
        try {
          writeFileAtomicSync(resolvedOutput, state.lastResponse);
          stderr.write(`${GREEN}✓${RESET} Output saved to ${resolvedOutput}\n`);
        } catch (err: unknown) {
          stderr.write(renderError(getErrorMessage(err)));
        }
      }
      await engine.shutdown();
    }
    process.exit(state.hadError ? 1 : 0);
  }

  // === --task flag: create background task and exit ===
  const taskIdx = args.indexOf('--task');
  const taskFlag = taskIdx !== -1 ? args[taskIdx + 1] : undefined;
  if (taskFlag) {
    await initPromise;
    session = await ensureSession();
    const taskManager = session.getTaskManager();
    if (taskManager) {
      const task = taskManager.create({
        title: taskFlag,
        description: taskFlag,
        assignee: 'lynox',
      });
      stderr.write(`${GREEN}\u2713${RESET} Background task created: ${task.id}\n`);
    }
    await engine.shutdown();
    process.exit(0);
  }

  // === --watch mode ===
  const watchIdx = args.indexOf('--watch');
  const watchDir = watchIdx !== -1 ? args[watchIdx + 1] : undefined;
  if (watchDir) {
    session = await ensureSession();
    const onChangeIdx = args.indexOf('--on-change');
    const onChangeTask = onChangeIdx !== -1 && args[onChangeIdx + 1] ? args[onChangeIdx + 1] : 'Review the changed files and suggest improvements';
    const watchdog = new Watchdog(watchDir, async (files) => {
      const task = `${onChangeTask}\n\nChanged files: ${files.join(', ')}`;
      try {
        spinner.start('Processing changes...');
        await session.run(task);
      } catch (err: unknown) {
        spinner.stop();
        stderr.write(renderError(getErrorMessage(err)));
      }
    });
    watchdog.start();
    // Keep process alive
    await new Promise<void>(() => {});
    return;
  }

  // === Default: Engine HTTP API (+ Web UI if available) ===
  if (stdin.isTTY) {
    if (!hasApiKey()) {
      stderr.write('No API key configured. Run "lynox init" to set up.\n');
      process.exit(1);
    }
    const { LynoxHTTPApi } = await import('./server/http-api.js');
    const api = new LynoxHTTPApi();
    await api.init();

    // Default port: 3000 when Web UI is embedded, 3100 for API-only
    const defaultPort = api.hasWebUi() ? 3000 : 3100;
    const rawPort = parseInt(process.env['LYNOX_HTTP_PORT'] ?? String(defaultPort), 10);
    const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : defaultPort;
    await api.start(port);

    const url = `http://localhost:${port}`;

    stderr.write(`\n  ${BOLD}lynox${RESET} ${DIM}v${pkg.version}${RESET}\n`);
    if (api.hasWebUi()) {
      stderr.write(`  ${DIM}Web UI + API:${RESET}  ${url}\n`);
    } else {
      stderr.write(`  ${DIM}Engine API:${RESET}    ${url}\n`);
      stderr.write(`  ${DIM}(Web UI not found — run \`cd packages/web-ui && pnpm run build\` first)${RESET}\n`);
    }
    stderr.write(`  ${DIM}Press Ctrl+C to stop.${RESET}\n\n`);

    // Open browser (best-effort, no shell injection via execFile)
    if (api.hasWebUi()) {
      try {
        const { execFile } = await import('node:child_process');
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        execFile(cmd, [url], () => { /* ignore errors */ });
      } catch { /* best-effort */ }
    }

    // Graceful shutdown
    let shuttingDown = false;
    const graceful = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      stderr.write(`\n[lynox] ${signal} received — shutting down…\n`);
      try { await api.shutdown(); } catch { /* best-effort */ }
      process.exit(0);
    };
    process.on('SIGINT', () => void graceful('SIGINT'));
    process.on('SIGTERM', () => void graceful('SIGTERM'));
    return;
  }

  // === Fallback: no matching mode ===
  stderr.write('No input provided. Run "lynox --help" for usage.\n');
  await engine.shutdown();
  process.exit(1);
}

// Entry point detection
const isMainModule = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const mainArg = process.argv[1];
    if (!mainArg) return false;
    return thisFile === mainArg || thisFile.replace(/\.ts$/, '.js') === mainArg;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runCLI().catch((err: unknown) => {
    const msg = getErrorMessage(err);
    stderr.write(`Fatal: ${msg}\n`);
    if (err instanceof Error && err.cause) {
      const cause = err.cause;
      stderr.write(`Cause: ${getErrorMessage(cause)}\n`);
      if (cause instanceof Error && cause.cause) {
        stderr.write(`Root: ${getErrorMessage(cause.cause)}\n`);
      }
    }
    process.exit(1);
  });
}
