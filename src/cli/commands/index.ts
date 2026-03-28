/**
 * Barrel export for CLI command handlers.
 *
 * Commands removed in CLI slim (moved to PWA):
 * task, schedule, runs, stats, batch, batchStatus, tree,
 * alias, google, vault, secret, plugin, hooks, approvals,
 * profile, memory, scope, knowledge, pipeline, chain,
 * manifest, api, backup, quickstart
 */

export type { CLICtx, InternalHandler } from './types.js';

// Basic commands
export { handleClear, handleCompact, handleSave, handleLoad, handleExport, handleHistory, handleHelp, handleExit } from './basic.js';

// Git commands
export { handleGit, handlePr, handleDiff } from './git.js';

// Config commands
export { handleConfig, handleStatus, pkg } from './config.js';

// Model commands
export { handleModel, handleAccuracy, handleCost, handleContext } from './model.js';

// Mode commands
export { handleMode, handleRoles } from './mode.js';

// Tool + MCP commands (kept from pipeline.ts)
export { handleTools, handleMcp } from './pipeline.js';
