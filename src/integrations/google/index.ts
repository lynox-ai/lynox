export { GoogleAuth, SCOPES, READ_ONLY_SCOPES, WRITE_SCOPES } from './google-auth.js';
export type { GoogleAuthOptions, DeviceFlowPrompt, LocalAuthResult } from './google-auth.js';
// Gmail no longer ships as a standalone tool — it surfaces via the unified
// mail tools (mail_triage, mail_search, mail_read, mail_send, mail_reply)
// once the Gmail OAuth row appears in the mail registry. See OAuthGmailProvider.
export { createSheetsTool } from './google-sheets.js';
export { createDriveTool } from './google-drive.js';
export { createCalendarTool } from './google-calendar.js';
export { createDocsTool } from './google-docs.js';
export { docsToMarkdown, markdownToHtml } from './google-docs-format.js';
export { GOOGLE_NOT_CONNECTED } from './not-connected.js';

import type { ToolEntry } from '../../types/index.js';
import { GoogleAuth } from './google-auth.js';
import { createSheetsTool } from './google-sheets.js';
import { createDriveTool } from './google-drive.js';
import { createCalendarTool } from './google-calendar.js';
import { createDocsTool } from './google-docs.js';

export interface GoogleToolsOptions {
  /** Absent on a brokered tenant — see `GoogleAuthOptions`. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  serviceAccountKeyPath?: string | undefined;
  vault?: import('../../core/secret-vault.js').SecretVault | undefined;
  /** Override default OAuth scopes. Defaults to read-only. */
  scopes?: string[] | undefined;
}

/**
 * Build the GoogleAuth instance. Needs a resolved client pair.
 *
 * Split from `createGoogleTools` by PRD Stage 1 §3.2: the tools must exist
 * before the credential does, so the two can no longer be created together.
 */
export function createGoogleAuth(options: GoogleToolsOptions): GoogleAuth {
  return new GoogleAuth({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    serviceAccountKeyPath: options.serviceAccountKeyPath,
    vault: options.vault,
    scopes: options.scopes,
  });
}

/**
 * The four Google Workspace tools, bound to a RESOLVER rather than to an
 * instance.
 *
 * ## Why a resolver
 *
 * The tools are registered from boot whether or not Google is connected (PRD
 * Stage 1 §3.2: a model that can see the tool can ask the user to connect it).
 * A tool that must exist before its credential does cannot close over that
 * credential. Each handler resolves at call time and answers
 * `GOOGLE_NOT_CONNECTED` when there is nothing to resolve.
 *
 * The resolver is deliberately re-read on every call, not memoised: the auth
 * instance is replaced by `reloadGoogle()` after a credential change, and a
 * captured one would keep a disconnected tenant working — and a reconnected one
 * broken — until the process restarts, which managed tenants cannot trigger.
 *
 * Nothing outside a handler reads the auth, which is what makes this safe:
 * every tool DEFINITION (name, description, schema) is credential-independent,
 * so the entries are complete from boot.
 */
export function createGoogleTools(resolveAuth: () => GoogleAuth | null): { tools: ToolEntry[] } {

  // Cast needed: ToolEntry<SpecificInput> → ToolEntry (contravariant handler)
  // Gmail intentionally absent: agents reach Gmail through the unified mail
  // tools registered by MailContext (which uses OAuthGmailProvider against
  // the same GoogleAuth instance — no second OAuth flow).
  const tools: ToolEntry[] = [
    createSheetsTool(resolveAuth) as ToolEntry,
    createDriveTool(resolveAuth) as ToolEntry,
    createCalendarTool(resolveAuth) as ToolEntry,
    createDocsTool(resolveAuth) as ToolEntry,
  ];

  return { tools };
}
