// === Mail tools barrel + factory ===

export { InMemoryMailRegistry, resolveProvider, resolveProviders } from './registry.js';
export type { MailRegistry, MutableMailRegistry } from './registry.js';
export { createMailSearchTool } from './mail-search.js';
export { createMailReadTool } from './mail-read.js';
export { createMailSendTool } from './mail-send.js';
export { createMailReplyTool } from './mail-reply.js';
export { createMailTriageTool } from './mail-triage.js';

import type { ToolEntry } from '../../../types/index.js';
import { createMailSearchTool } from './mail-search.js';
import { createMailReadTool } from './mail-read.js';
import { createMailSendTool } from './mail-send.js';
import { createMailReplyTool } from './mail-reply.js';
import { createMailTriageTool } from './mail-triage.js';
import type { MailRegistry } from './registry.js';
import type { MailContext } from '../context.js';

/**
 * Build the full set of mail tools backed by a single registry.
 * The engine registers the returned ToolEntry array on its ToolRegistry.
 *
 * The optional `ctx` is used by mail_send and mail_reply to look up account
 * types for the receive-only hard block + persona hints. Tests and bare-bones
 * callers can omit it; the send path then falls back to the default account
 * without type-aware behavior.
 */
export function createMailTools(registry: MailRegistry, ctx?: MailContext): ToolEntry[] {
  return [
    createMailSearchTool(registry) as ToolEntry,
    createMailReadTool(registry) as ToolEntry,
    createMailSendTool(registry, ctx) as ToolEntry,
    createMailReplyTool(registry, ctx) as ToolEntry,
    createMailTriageTool(registry) as ToolEntry,
  ];
}

/** Names of the mail tools that mutate external state (need permission guard). */
export const MAIL_WRITE_TOOLS: ReadonlySet<string> = new Set(['mail_send', 'mail_reply']);
