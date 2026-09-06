export { GoogleAuth, SCOPES, STANDARD_SCOPES, SENSITIVE_EXTRA_SCOPES, RESTRICTED_SCOPES, FULL_SCOPES } from './google-auth.js';
export type { GoogleAuthOptions, DeviceFlowPrompt, LocalAuthResult, GoogleTokenChange, GoogleTokenChangeReason } from './google-auth.js';
import type { GoogleAuthOptions } from './google-auth.js';
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

/**
 * ⚠ An ALIAS, not a copy. It was a hand-maintained duplicate of
 * `GoogleAuthOptions` with a by-hand forwarding list in `createGoogleAuth`
 * below, so every new option had to be added in three places and a forgotten
 * one was silent — the option simply never arrived. §3.10's `onTokenChange`
 * would have been the first casualty: the credential would build, the hook
 * would be dropped, and the connection row would never be written.
 */
export type GoogleToolsOptions = GoogleAuthOptions;

/**
 * Build the GoogleAuth instance. Needs a resolved client pair.
 *
 * Split from `createGoogleTools` by PRD Stage 1 §3.2: the tools must exist
 * before the credential does, so the two can no longer be created together.
 */
export function createGoogleAuth(options: GoogleToolsOptions): GoogleAuth {
  // Forwarded whole. Naming the fields one by one is what made a dropped
  // option possible in the first place.
  return new GoogleAuth(options);
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
