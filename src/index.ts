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
export { LocalGateAdapter } from './orchestrator/gates.js';
export { computePhases, validateGraph, CycleError } from './orchestrator/graph.js';
export type { ExecutionPhase, GraphAnalysis } from './orchestrator/graph.js';
export type {
  Manifest, ManifestStep, AgentDef, AgentOutput, RunState, RunHooks,
  GateAdapter, GateDecision, GateSubmitParams,
} from './orchestrator/types.js';
export { GateRejectedError, GateExpiredError } from './orchestrator/types.js';
export { globToRegex, extractMatchString, matchesPreApproval, buildApprovalSet, isCriticalTool } from './core/pre-approve.js';

export { planDAG, estimatePipelineCost } from './core/dag-planner.js';
export type { DagPlanResult } from './core/dag-planner.js';
export { spawnInline, spawnPipeline, resolveModel } from './orchestrator/runtime-adapter.js';
export { retryManifest } from './orchestrator/runner.js';
export { DagVisualizer } from './cli/dag-visualizer.js';
export type { StepStatus, DagVisualizerOptions } from './cli/dag-visualizer.js';
export { buildConditionContext, shouldRunStep, evaluateCondition } from './orchestrator/conditions.js';
export { resolveTaskTemplate } from './orchestrator/context.js';
export type { InlinePipelineStep, PipelineResult, PipelineStepResult, PlannedPipeline, SecretStoreLike, SecretEntry, SecretScope } from './types/index.js';
export { SecretStore, SECRET_REF_PATTERN } from './core/secret-store.js';
export { SecretVault, estimateKeyEntropy } from './core/secret-vault.js';
export type { VaultEntry, VaultOptions } from './core/secret-vault.js';
export { resolveActiveScopes, resolveWriteScope, scopeWeight, scopeToDir, parseScopeString, formatScopeRef, isMoreSpecific, inferScopeFromContext, SCOPE_ORDER, SEMANTIC_OVERRIDE_THRESHOLD, buildEmbeddingsMap } from './core/scope-resolver.js';
export type { ScopeContext, ScopeOverride } from './core/scope-resolver.js';
export { classifyScope } from './core/scope-classifier.js';
export type { ScopeClassification } from './types/index.js';
export { runMemoryGc } from './core/memory-gc.js';
export { TaskManager } from './core/task-manager.js';
export type { TaskCreateParams, TaskUpdateParams, WeekSummary } from './core/task-manager.js';
export type { GcOptions, GcResult } from './core/memory-gc.js';
export { showApprovalDialog, autoApproveDefaults } from './cli/approval-dialog.js';
export type { ApprovalDialogResult } from './cli/approval-dialog.js';
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
export { createToolContext, applyNetworkPolicy, applyHttpRateLimits } from './core/tool-context.js';

// === Utilities needed by Pro ===
export { writeFileAtomicSync, ensureDirSync, ensureDir } from './core/atomic-write.js';
export { getErrorMessage, sleep } from './core/utils.js';
export { renderTable } from './cli/ui.js';
export { ChangesetManager } from './core/changeset.js';
export { reviewChangeset } from './cli/changeset-review.js';
export { planTaskTool } from './tools/builtin/plan-task.js';
export { RESET, BOLD, DIM, RED, GREEN, BLUE, MAGENTA, GRAY, stripAnsi } from './cli/ansi.js';

// === Tool knobs for tenant isolation enforcement ===
export { setNetworkPolicy, clearNetworkPolicy } from './tools/builtin/http.js';
export { setIsolationEnv, clearIsolationEnv } from './tools/builtin/bash.js';
export { setTenantWorkspace, clearTenantWorkspace, ensureContextWorkspace } from './core/workspace.js';

// === CLI Command Registry ===

export type SlashCommandHandler = (
  parts: string[],
  session: import('./core/session.js').Session,
  ctx: { stdout: NodeJS.WriteStream; cliPrompt?: (prompt: string, options?: string[]) => Promise<string> },
) => Promise<boolean>;

const _commandRegistry = new Map<string, SlashCommandHandler>();

export function registerCommand(name: string, handler: SlashCommandHandler): void {
  _commandRegistry.set(name.startsWith('/') ? name : `/${name}`, handler);
}

// === CLI REPL ===

import { createInterface } from 'node:readline/promises';
import { readSync } from 'node:fs';
import { stdin, stdout, stderr, argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';

import { Engine } from './core/engine.js';
import type { Session } from './core/session.js';
import type { StreamEvent, TabQuestion } from './types/index.js';
import { MODEL_MAP } from './types/index.js';
import { hasApiKey, setDataDir } from './core/config.js';
import { runSetupWizard } from './cli/setup-wizard.js';

import { animateBanner, renderError, renderWarning, BOLD, DIM, BLUE, GREEN, RED, YELLOW, MAGENTA, RESET } from './cli/ui.js';
import { PROMPT_READY } from './cli/spinner.js';
import { InteractiveDialog } from './cli/dialog.js';
import { Watchdog } from './cli/watchdog.js';
import { SlashAutocomplete, buildCommandDefs } from './cli/autocomplete.js';
import { writeFileAtomicSync } from './core/atomic-write.js';
import { getErrorMessage } from './core/utils.js';
import { reviewChangeset } from './cli/changeset-review.js';

// New modular imports
import { state, spinner, md, footer, toolsUsed } from './cli/cli-state.js';
import { loadHistory, appendHistory, loadSessionFile } from './cli/cli-helpers.js';
import { COMMANDS, COMMAND_ALIASES, completer, HELP_TEXT_FULL } from './cli/help-text.js';
import { streamHandler as _streamHandler } from './cli/stream-handler.js';
import {
  handleClear, handleCompact, handleSave, handleLoad, handleExport,
  handleHistory, handleHelp, handleExit,
  handleGit, handlePr, handleDiff,
  handleConfig, handleStatus, pkg,
  handleModel, handleAccuracy, handleCost, handleContext,
  handleMode, handleRoles,
  handleTools, handleMcp,
} from './cli/commands/index.js';
import type { InternalHandler, CLICtx } from './cli/commands/types.js';

// === Command dispatch map ===

import { loadAliases } from './cli/cli-helpers.js';

const DISPATCH: Record<string, InternalHandler> = {
  '/clear': handleClear, '/reset': handleClear,
  '/compact': handleCompact,
  '/save': handleSave,
  '/load': handleLoad,
  '/export': handleExport,
  '/history': handleHistory,
  '/help': handleHelp,
  '/exit': handleExit, '/quit': handleExit,
  '/git': handleGit,
  '/pr': handlePr,
  '/diff': handleDiff,
  '/config': handleConfig,
  '/status': handleStatus,
  '/model': handleModel,
  '/accuracy': handleAccuracy,
  '/cost': handleCost,
  '/context': handleContext,
  '/mode': handleMode,
  '/roles': handleRoles,
  '/tools': handleTools,
  '/mcp': handleMcp,
};

// Wrapped stream handler that binds stdout
function streamHandler(event: StreamEvent): void {
  _streamHandler(event, stdout);
}

async function handleCommand(line: string, session: Session): Promise<boolean> {
  const trimmedLine = line.trim();
  const firstWord = trimmedLine.split(/\s+/)[0]!;

  // Resolve command aliases (e.g. /diff → /git diff, /chain → /pipeline chain)
  if (firstWord in COMMAND_ALIASES) {
    const alias = COMMAND_ALIASES[firstWord]!;
    const rest = trimmedLine.slice(firstWord.length).trim();
    const resolved = rest ? `${alias} ${rest}` : alias;
    return handleCommand(resolved, session);
  }

  const parts = trimmedLine.split(/\s+/);
  const cmd = parts[0]!;

  const ctx: CLICtx = state.cliPrompt
    ? { stdout, cliPrompt: state.cliPrompt }
    : { stdout };

  // Check dispatch map
  const handler = DISPATCH[cmd];
  if (handler) {
    return handler(parts, session, ctx);
  }

  // Check registered extension commands (Pro)
  const registeredHandler = _commandRegistry.get(cmd);
  if (registeredHandler) {
    // SlashCommandHandler type does not have `| undefined` on cliPrompt (exactOptionalPropertyTypes)
    const regCtx = state.cliPrompt
      ? { stdout, cliPrompt: state.cliPrompt } as const
      : { stdout } as const;
    return registeredHandler(parts, session, regCtx);
  }

  // Check user aliases
  const aliases = loadAliases();
  const aliasKey = cmd.slice(1); // strip leading /
  if (aliasKey && aliases[aliasKey]) {
    try {
      spinner.start('Running alias...');
      await session.run(aliases[aliasKey]!);
    } catch (err: unknown) {
      spinner.stop();
      stderr.write(renderError(getErrorMessage(err)));
    }
    return true;
  }

  stdout.write(`Unknown command: ${cmd}\n`);
  stdout.write('Type /help for available commands.\n');
  return true;
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
  lynox                         Interactive REPL (setup wizard on first run)
  lynox "<task>"                Run a single task and exit
  cat file | lynox "<task>"     Process piped input with a task
  lynox init                    Run the setup wizard
  lynox --http-api              Start Engine HTTP API server
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
  --resume                      Resume previous session
  --data-dir <dir>              Override data directory (default: ~/.lynox)

Environment:
  ANTHROPIC_API_KEY             Anthropic API key (required)
  ANTHROPIC_BASE_URL            Custom API endpoint (for proxies)
  LYNOX_DATA_DIR                Override data directory (same as --data-dir)
  LYNOX_HTTP_PORT               HTTP API port (default: 3100)
  LYNOX_HTTP_SECRET             HTTP API Bearer token (enables network binding)
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
    const port = parseInt(process.env['LYNOX_HTTP_PORT'] ?? '3100', 10);
    const api = new LynoxHTTPApi();
    await api.init();
    await api.start(port);
    return;
  }

  // === Setup wizard (explicit --init / "init" subcommand, or auto when no API key) ===
  if (args.includes('--init') || args[0] === 'init') {
    const wizardResult = await runSetupWizard();
    if (!wizardResult) {
      stderr.write('No API key configured. Run "lynox init" to set up.\n');
      process.exit(1);
    }
    // Continue into REPL — vault key is already in process.env, config reloaded
  } else if (!hasApiKey() && stdin.isTTY) {
    const wizardResult = await runSetupWizard();
    if (!wizardResult) {
      stderr.write('No API key configured. Run "lynox init" to set up.\n');
      process.exit(1);
    }
    // Continue into REPL — vault key is already in process.env, config reloaded
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
  state.currentModelId = MODEL_MAP[engine.config.model ?? 'sonnet'];
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

  // === Sprint 2b: --resume flag ===
  if (args.includes('--resume')) {
    session = await ensureSession();
    if (loadSessionFile(session)) {
      stderr.write(`${GREEN}✓${RESET} Resumed previous session.\n`);
    }
  }

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
    if (state.cliPrompt) {
      gateAdapter = new LocalAdapter(state.cliPrompt);
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

  // === Interactive REPL ===
  // Init must complete before reading tool counts
  session = await ensureSession();
  const mcpCount = session.getRegistry().getMCPServers().length;
  const toolCount = session.getRegistry().getEntries().length + 1; // +1 for web_search

  const thinkingLabel = session.getThinking() ? 'adaptive' : 'disabled';
  const effortLabel = session.getEffort() ?? 'high';
  const memoryLabel = session.getMemory() ? 'local' : 'none';
  await animateBanner(stdout, MODEL_MAP[session.getModelTier()], thinkingLabel, effortLabel, memoryLabel, mcpCount, toolCount, pkg.version);

  // === Footer bar (inline status after each response) ===
  if (stdout.isTTY) {
    footer.activate();
  }

  // Load command history
  const history = loadHistory();

  const rl = createInterface({ input: stdin, output: stdout, terminal: true, history, completer });
  rl.setPrompt(PROMPT_READY);

  // === Stdin listener management (shared by dialog and ESC handler) ===
  // Detach ALL stdin listeners (data + keypress) during dialog to prevent
  // readline's emitKeypressEvents and prompt rendering from interfering.
  const detachStdin = () => {
    const data = stdin.rawListeners('data').slice();
    const keypress = stdin.rawListeners('keypress').slice();
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    return { data, keypress };
  };
  const reattachStdin = (saved: { data: Function[]; keypress: Function[] }) => {
    // Ensure rawMode is on before reattaching — dialogs set rawMode(false) in cleanup,
    // but readline's emitKeypressEvents needs rawMode to parse arrow keys correctly.
    if (stdin.isTTY && !stdin.isRaw) stdin.setRawMode(true);
    for (const fn of saved.data) {
      stdin.on('data', fn as (...args: unknown[]) => void);
    }
    for (const fn of saved.keypress) {
      stdin.on('keypress', fn as (...args: unknown[]) => void);
    }
  };

  // === Slash command autocomplete (/ trigger) ===
  const commandDefs = buildCommandDefs(COMMANDS, HELP_TEXT_FULL);
  const slashComplete = new SlashAutocomplete(commandDefs);
  let atPrompt = false;

  const showPrompt = () => {
    rl.prompt();
    atPrompt = true;
  };

  // Detect '/' at position 0 via keypress, then take over stdin for autocomplete.
  // Uses setImmediate so readline finishes processing the keystroke first.
  //
  // Readline internal state access:
  // `(rl as unknown as { line: string }).line` reads the current input buffer.
  // `{ line: string; cursor: number }` resets cursor after completion.
  //
  // Why: Node.js readline has no public API to read/clear the current input
  // buffer. Slash-command autocomplete needs to detect '/' at position 0, take
  // over stdin, and clear readline's buffer after completion. Without this,
  // readline would echo stale characters.
  //
  // Stability: These internals have been stable since Node.js 12+. The readline
  // module is effectively frozen (node:readline/promises wraps the same state).
  // If a Node.js update breaks this, autocomplete would fail gracefully (stale
  // characters in prompt, not a crash).
  if (stdin.isTTY) {
    stdin.on('keypress', (_str: string | undefined, key: { name?: string; sequence?: string }) => {
      if (!atPrompt || key.sequence !== '/') return;
      const rlLine = (rl as unknown as { line: string }).line;
      if (rlLine !== '/') return; // only trigger at position 0

      atPrompt = false;
      setImmediate(() => {
        // Clear readline's echoed '/' and take over
        rl.pause();
        const saved = detachStdin();
        stdout.write('\r\x1b[K'); // clear the prompt line readline wrote
        stdin.setRawMode(true);
        stdin.resume();
        void slashComplete.run(stdin, stdout, '/').then((result) => {
          reattachStdin(saved);
          // Clear readline's internal buffer (it still has '/')
          (rl as unknown as { line: string; cursor: number }).line = '';
          (rl as unknown as { line: string; cursor: number }).cursor = 0;
          rl.resume();
          if (result && result.trim()) {
            const cmd = result.trim();
            appendHistory(cmd);
            stdout.write(`${PROMPT_READY}${cmd}\n`);
            void handleCommand(cmd, session).then((shouldContinue) => {
              if (!shouldContinue) {
                void engine.shutdown().then(() => process.exit(0));
                return;
              }
              showPrompt();
            });
          } else {
            showPrompt();
          }
        });
      });
    });
  }

  // === Interactive Dialog + ESC interrupt ===
  let activeEscHandler: ((data: Buffer) => void) | null = null;

  if (stdin.isTTY) {
    const dialog = new InteractiveDialog(stdin, stdout);

    session.promptUser = async (question: string, options?: string[]): Promise<string> => {
      spinner.stop();
      // Remove ESC handler first so it's not included in saved listeners
      if (activeEscHandler) {
        stdin.removeListener('data', activeEscHandler);
      }
      const saved = detachStdin();
      const answer = await dialog.prompt(question, options);
      reattachStdin(saved);
      // Re-enable ESC handler after dialog
      if (activeEscHandler) {
        stdin.on('data', activeEscHandler);
        stdin.resume();
      }
      // ESC pressed — abort the agent run so it stops asking
      if (!answer) {
        session.abort();
        return 'User canceled.';
      }
      return answer;
    };
    session.promptTabs = async (questions: TabQuestion[]): Promise<string[]> => {
      spinner.stop();
      if (activeEscHandler) {
        stdin.removeListener('data', activeEscHandler);
      }
      const saved = detachStdin();
      const answers = await dialog.tabbedPrompt(questions);
      reattachStdin(saved);
      if (activeEscHandler) {
        stdin.on('data', activeEscHandler);
        stdin.resume();
      }
      // ESC on first tab — abort the agent run
      if (answers.length === 0) {
        session.abort();
      }
      return answers;
    };

    // CLI-only dialog (no abort logic — for slash commands like /model)
    state.cliPrompt = async (question: string, options?: string[]): Promise<string> => {
      rl.pause();
      const saved = detachStdin();
      const answer = await dialog.prompt(question, options);
      reattachStdin(saved);
      (rl as unknown as { line: string; cursor: number }).line = '';
      (rl as unknown as { line: string; cursor: number }).cursor = 0;
      rl.resume();
      return answer;
    };
  }

  // SIGINT: skip shutdown() — better-sqlite3 db.close() throws a native C++ mutex
  // exception (std::system_error) that JS try/catch cannot intercept, crashing the process.
  // SQLite WAL mode is crash-safe; the WAL file auto-recovers on next open.
  // Registered early so it covers the greeting phase too.
  process.on('SIGINT', () => {
    spinner.stop();
    stdout.write('\n');
    // Hard exit — process.exit() runs 'exit' handlers that may touch SQLite and crash.
    // SIGKILL bypasses all cleanup. SQLite WAL mode recovers automatically.
    process.kill(process.pid, 'SIGKILL');
  });

  // === Initial greeting — lynox introduces itself proactively ===
  const userCfg = session.getUserConfig();
  let greetingShown = false;
  if (stdin.isTTY && userCfg.greeting !== false) {
    const { existsSync, readdirSync } = await import('node:fs');
    const memDir = join(homedir(), '.lynox', 'memory');
    const isFirstSession = !existsSync(memDir) || readdirSync(memDir).length === 0;

    let greetingText = '';
    spinner.start('...');
    session.onStream = (event: StreamEvent) => {
      if (event.type === 'text') {
        greetingText += event.text;
      }
    };

    if (isFirstSession) {
      // First session: natural onboarding conversation — agent asks about the business.
      // Uses configured model with memory extraction so answers are remembered.
      // Ensure thinking is adaptive (wizard doesn't set it, default may be disabled).
      session.setThinking({ type: 'adaptive' });
      const allToolNames = session.getRegistry().getEntries().map(e => e.definition.name);
      const memoryTools = ['memory_store', 'memory_recall'];
      const excludeTools = allToolNames.filter(n => !memoryTools.includes(n));
      session._recreateAgent({ maxIterations: 2, excludeTools });
      try {
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Greeting timed out')), 30_000),
        );
        await Promise.race([session.run(
          'This is the user\'s very first session. Welcome them warmly in 2-3 sentences. ' +
          'Refer to yourself as "lynox" (lowercase). ' +
          'Briefly say what you are (a digital coworker that learns their business over time). ' +
          'Then suggest something small and concrete to start with — like checking their emails, ' +
          'summarizing a file, or looking at recent git activity. ' +
          'Do NOT ask what they want to automate or what their biggest problem is — ' +
          'they don\'t know what\'s possible yet. Let them experience it first. ' +
          'Write in the user\'s language (detect from system locale or default to English).',
        ), timeout]);
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        const isApiError = msg.includes('authentication') || msg.includes('invalid x-api-key')
          || msg.includes('API key') || msg.includes('401')
          || msg.includes('credit balance') || msg.includes('billing');
        if (isApiError) {
          stderr.write(renderWarning(`API error: ${msg}`));
        }
      }
      session._recreateAgent();
    } else {
      // Returning user: quick greeting via Haiku (cheap, fast, no tools)
      const taskBriefing = session.getTaskManager()?.getBriefingSummary(session.getActiveScopes()) ?? '';
      const memoryContent = session.getAgent()?.memory?.render() ?? '';
      const greetingContext = [taskBriefing, memoryContent].filter(Boolean).join('\n\n');
      const greetingPrompt = greetingContext
        ? `Context:\n${greetingContext}\n\nGreet the user in 1-2 short sentences. Mention the project name and any useful context from above. Do NOT describe what you are doing, do NOT report bugs or issues, do NOT give advice — just a friendly, brief welcome. No feature lists, no tool narration.`
        : 'Greet the user in 1-2 short sentences. Be brief and friendly. No feature lists, no tool narration.';
      const savedTier = session.getModelTier();
      const savedThinking = session.getThinking();
      session.setModel('haiku');
      session.setThinking({ type: 'disabled' });
      session.setSkipMemoryExtraction(true);
      const allToolNames = session.getRegistry().getEntries().map(e => e.definition.name);
      session._recreateAgent({ maxIterations: 1, excludeTools: allToolNames });
      try {
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Greeting timed out')), 15_000),
        );
        await Promise.race([session.run(greetingPrompt), timeout]);
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        const isApiError = msg.includes('authentication') || msg.includes('invalid x-api-key')
          || msg.includes('API key') || msg.includes('401')
          || msg.includes('credit balance') || msg.includes('billing');
        if (isApiError) {
          stderr.write(renderWarning(`API error: ${msg}`));
        }
      }
      session.setSkipMemoryExtraction(false);
      session.setModel(savedTier);
      session.setThinking(savedThinking ?? { type: 'adaptive' });
      session._recreateAgent();
    }

    spinner.stop();
    session.onStream = streamHandler;
    if (greetingText.trim()) {
      stdout.write(`👾 `);
      stdout.write(md.push(greetingText));
      stdout.write(md.flush());
      stdout.write('\n');
      md.reset();
      greetingShown = true;
    }
  }

  // Onboarding hint when no greeting was shown
  if (stdin.isTTY && !greetingShown) {
    stdout.write(`${DIM}Type a question or /help for commands.${RESET}\n`);
  }

  showPrompt();

  let lastBusyEnd = 0;
  let lastInput = '';
  let lastInputTime = 0;
  const recentRunTimestamps: number[] = [];

  for await (const line of rl) {
    atPrompt = false;
    const sanitized = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    const trimmed = sanitized.trim();
    if (!trimmed) {
      showPrompt();
      continue;
    }

    // Discard ghost lines buffered during a previous run/command
    if (Date.now() - lastBusyEnd < 150) {
      showPrompt();
      continue;
    }

    // Skip identical consecutive inputs within 2s (buffered keystroke dedup)
    if (trimmed === lastInput && Date.now() - lastInputTime < 2000) {
      showPrompt();
      continue;
    }
    lastInput = trimmed;
    lastInputTime = Date.now();

    appendHistory(trimmed);

    if (trimmed.startsWith('/')) {
      rl.pause();
      const shouldContinue = await handleCommand(trimmed, session);
      lastBusyEnd = Date.now();
      rl.resume();
      if (!shouldContinue) {
        break;
      }
      showPrompt();
      continue;
    }

    // Rate limit: max 3 runs in 5 seconds to prevent runaway loops
    recentRunTimestamps.push(Date.now());
    while (recentRunTimestamps.length > 0 && recentRunTimestamps[0]! < Date.now() - 5000) {
      recentRunTimestamps.shift();
    }
    if (recentRunTimestamps.length > 3) {
      recentRunTimestamps.length = 0;
      stderr.write(renderWarning('Too many runs in quick succession — pausing to prevent a loop.'));
      showPrompt();
      continue;
    }

    // Set up ESC interrupt
    let aborted = false;
    const escHandler = (data: Buffer) => {
      if (data[0] === 0x03) {
        // Ctrl+C in raw mode — hard kill to avoid native C++ mutex crash.
        // process.exit() runs cleanup handlers that may touch SQLite.
        spinner.stop();
        stdout.write('\n');
        process.kill(process.pid, 'SIGKILL');
      }
      if (data[0] === 0x1b && data.length === 1 && !aborted) {
        aborted = true;
        session.abort();
        spinner.stop();
        stdout.write(md.flush());
        stdout.write(`\n  ${DIM}[interrupted]${RESET}\n`);
      }
    };

    if (stdin.isTTY) {
      rl.pause();
      stdin.setRawMode(true);
      activeEscHandler = escHandler;
      stdin.on('data', escHandler);
      stdin.resume();
    }

    try {
      state.lastResponse = '';
      state.responseStarted = false;
      state.turnStartMs = Date.now();
      spinner.start('Thinking...');
      await session.run(trimmed);

      // Post-run changeset review
      const changesetMgr = session.getChangesetManager();
      if (changesetMgr?.hasChanges()) {
        // Remove ESC handler temporarily so readKey works
        if (stdin.isTTY && activeEscHandler) {
          stdin.removeListener('data', activeEscHandler);
        }
        try {
          const changes = changesetMgr.getChanges();
          const result = await reviewChangeset(changes, stdin, stdout);
          if (result.action === 'rollback') {
            changesetMgr.rollbackAll();
            stdout.write(`${DIM}All changes rolled back.${RESET}\n`);
          } else if (result.action === 'partial') {
            changesetMgr.rollbackFiles(result.rolledBackFiles);
            stdout.write(`${DIM}Accepted ${result.acceptedFiles.length}, rolled back ${result.rolledBackFiles.length} files.${RESET}\n`);
          } else {
            changesetMgr.acceptAll();
            stdout.write(`${DIM}Changes accepted.${RESET}\n`);
          }
        } finally {
          changesetMgr.cleanup();
          // Re-attach ESC handler
          if (stdin.isTTY && activeEscHandler) {
            stdin.on('data', activeEscHandler);
          }
        }
      }
    } catch (err: unknown) {
      spinner.stop();
      if (!aborted) {
        const msg = getErrorMessage(err);
        stderr.write(renderError(msg));
      }
    } finally {
      if (stdin.isTTY) {
        stdin.removeListener('data', escHandler);
        activeEscHandler = null;
        // Do NOT setRawMode(false) — readline needs raw mode for arrow key handling.
        // rl.resume() will take over raw mode management.
      }
      lastBusyEnd = Date.now();
      rl.resume();
    }
    showPrompt();
  }

  await engine.shutdown();
  process.exit(0);
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
