export { GoogleAuth, SCOPES, READ_ONLY_SCOPES, WRITE_SCOPES } from './google-auth.js';
export type { GoogleAuthOptions, DeviceFlowPrompt, LocalAuthResult } from './google-auth.js';
export { createGmailTool } from './google-gmail.js';
export { createSheetsTool } from './google-sheets.js';
export { createDriveTool } from './google-drive.js';
export { createCalendarTool } from './google-calendar.js';
export { createDocsTool } from './google-docs.js';
export { docsToMarkdown, markdownToHtml } from './google-docs-format.js';

import type { ToolEntry } from '../../types/index.js';
import { GoogleAuth } from './google-auth.js';
import { createGmailTool } from './google-gmail.js';
import { createSheetsTool } from './google-sheets.js';
import { createDriveTool } from './google-drive.js';
import { createCalendarTool } from './google-calendar.js';
import { createDocsTool } from './google-docs.js';

export interface GoogleToolsOptions {
  clientId: string;
  clientSecret: string;
  serviceAccountKeyPath?: string | undefined;
  vault?: import('../../core/secret-vault.js').SecretVault | undefined;
  /** Override default OAuth scopes. Defaults to read-only. */
  scopes?: string[] | undefined;
}

/**
 * Create and register all Google Workspace tools.
 * Returns the tools array and the GoogleAuth instance (for /google CLI commands).
 */
export function createGoogleTools(options: GoogleToolsOptions): { tools: ToolEntry[]; auth: GoogleAuth } {
  const auth = new GoogleAuth({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    serviceAccountKeyPath: options.serviceAccountKeyPath,
    vault: options.vault,
    scopes: options.scopes,
  });

  // Cast needed: ToolEntry<SpecificInput> → ToolEntry (contravariant handler)
  const tools: ToolEntry[] = [
    createGmailTool(auth) as ToolEntry,
    createSheetsTool(auth) as ToolEntry,
    createDriveTool(auth) as ToolEntry,
    createCalendarTool(auth) as ToolEntry,
    createDocsTool(auth) as ToolEntry,
  ];

  return { tools, auth };
}
