import { OWNER_PRINCIPAL, isOwnerPrincipal, principalTag, type RequestPrincipal } from './request-principal.js';
import type { SendOrigin } from './origin-notices.js';

/** What {@link ownersCleanBatch} reads of an agent. */
export interface CleanBatchReader {
  readonly principal: RequestPrincipal;
  readonly writeAuthor?: string | null | undefined;
  readonly sendOrigin?: SendOrigin | undefined;
  batchStartedTainted?(): boolean;
  heldProviderSearch?(): boolean;
}

/**
 * Whether the running call is the owner's own, in their interactive chat, in a tool batch that
 * began before any foreign content, in a conversation without a server tool the provider ran
 * itself, such as its web search.
 * Only then may a call record something a later step trusts without asking: the host saved with an
 * API profile (`owner_clean_host`).
 *
 * - Owner's own chat: a trigger's, a workflow's or a task's run carries a run tag as its author
 *   even under the owner's principal, and a sub-agent a run origin of its own; a run made in
 *   another conversation could otherwise name a host unattended.
 * - The batch's snapshot, not the turn's: the dispatch counts a call's own tool as foreign content
 *   before the handler runs. Outside a batch the answer is `false`.
 * - A server tool the provider ran itself (any but the lazy tools' tool search) reaches the model
 *   past every dispatch. Its answer arms the conversation latch, and a conversation holding one
 *   is never clean here either: this check stays as a guard of its own.
 */
export function ownersCleanBatch(agent: CleanBatchReader): boolean {
  return isOwnerPrincipal(agent.principal)
    && agent.writeAuthor === principalTag(OWNER_PRINCIPAL)
    && agent.sendOrigin === undefined
    && agent.batchStartedTainted?.() === false
    && agent.heldProviderSearch?.() === false;
}
