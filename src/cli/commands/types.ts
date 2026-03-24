/**
 * Shared types for command handler modules.
 */

import type { Nodyn } from '../../core/orchestrator.js';

export type CLICtx = {
  stdout: NodeJS.WriteStream;
  cliPrompt?: ((prompt: string, options?: string[]) => Promise<string>) | undefined;
};

export type InternalHandler = (parts: string[], nodyn: Nodyn, ctx: CLICtx) => Promise<boolean>;
