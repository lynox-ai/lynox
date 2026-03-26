/**
 * Barrel export for all CLI command handlers.
 */

export type { CLICtx, InternalHandler } from './types.js';

// Basic commands
export { handleClear, handleCompact, handleSave, handleLoad, handleExport, handleHistory, handleHelp, handleExit } from './basic.js';

// Git commands
export { handleGit, handlePr, handleDiff } from './git.js';

// Task commands
export { handleTask, handleSchedule } from './task.js';

// History commands
export { handleRuns, handleStats, handleBatch, handleBatchStatus, handleTree } from './history.js';

// Identity commands
export { handleAlias, handleGoogle, handleVault, handleSecret, handlePlugin } from './identity.js';

// Config commands
export { handleConfig, handleStatus, handleHooks, handleApprovals, pkg } from './config.js';

// Model commands
export { handleModel, handleAccuracy, handleCost, handleContext } from './model.js';

// Mode commands
export { handleMode, handleRoles, handleProfile } from './mode.js';

// Memory commands
export { handleMemory, handleScope, handleKnowledge } from './memory.js';

// Pipeline commands
export { handlePipeline, handleChain, handleManifest, handleTools, handleMcp } from './pipeline.js';

// Backup command
export { handleBackup } from './backup.js';

// API command
export { handleApi } from './api.js';

// Quickstart command
export { handleQuickstart } from './quickstart.js';
