/**
 * Shared types for command handler modules.
 */

import type { Session } from '../../core/session.js';

export type CLICtx = {
  stdout: NodeJS.WriteStream;
  cliPrompt?: ((prompt: string, options?: string[]) => Promise<string>) | undefined;
};

export type InternalHandler = (parts: string[], session: Session, ctx: CLICtx) => Promise<boolean>;
