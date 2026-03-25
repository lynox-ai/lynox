/**
 * Re-export shim — the Nodyn monolith has been split into Engine + Session.
 * This file exists only for backward compatibility during migration.
 * Once all imports are updated, delete this file.
 */
export { Engine as Nodyn } from './engine.js';
export type { RunContext, NodynHooks, AccumulatedUsage } from './engine.js';
export { Session } from './session.js';
export type { SessionOptions } from './session.js';
