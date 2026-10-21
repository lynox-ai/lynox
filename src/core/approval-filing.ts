/**
 * How a run nobody watches hands a mail to its owner (PRD unattended-approval-queue §4.2).
 *
 * The runner gives such a run an {@link ApprovalFilingContext}: the worker's standard trigger and
 * a scheduled workflow, never an attended session, never a run without a trigger. With it, the
 * agent's danger check lets a queueable mail call through and marks its call slot `filing`; the
 * mail handler then files at its consent step through `Agent.fileApproval`, which refuses
 * without that mark. Nothing here sends.
 */

import { approvalQueueEnabled, type ApprovalSource, type ApprovalStore, type FileResult } from './approval-store.js';
import { mandateIdOf, principalTag, OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

/** At most this many entries of one trigger wait at a time (§5, flooding). Children of a run
 *  inherit its trigger, so they count against the same limit. */
export const MAX_PENDING_PER_TRIGGER = 10;

/**
 * What a run may file with, set by its runner and inherited by its children. The trigger is
 * the runner's, never taken from a tool's input.
 */
export interface ApprovalFilingContext {
  readonly source: ApprovalSource;
  readonly triggerId: string;
  /** The run at the root of the tree. Absent on the root itself, whose own run it is. */
  readonly rootRunId?: string | undefined;
  readonly eventId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly store: ApprovalStore;
  /** Who the run acts for, recorded on the entry. */
  readonly createdBy: string | null;
  /** The mandate the run acts under, so the entry ends with it. */
  readonly mandateId: string | null;
}

/**
 * The context a runner gives a run nobody watches, or undefined when the run may not file: the
 * queue is off, engine.db is unavailable, or the run has no trigger (a run without one has no
 * flooding limit to count against, so it is refused as before).
 */
export function filingContextFor(
  store: ApprovalStore | null,
  run: { source: ApprovalSource; triggerId: string | undefined; principal?: RequestPrincipal | undefined; eventId?: string | undefined; threadId?: string | undefined },
): ApprovalFilingContext | undefined {
  if (store === null || !approvalQueueEnabled() || run.triggerId === undefined || run.triggerId === '') return undefined;
  const principal = run.principal ?? OWNER_PRINCIPAL;
  return {
    source: run.source,
    triggerId: run.triggerId,
    ...(run.eventId !== undefined ? { eventId: run.eventId } : {}),
    ...(run.threadId !== undefined ? { threadId: run.threadId } : {}),
    store,
    createdBy: principalTag(principal),
    mandateId: mandateIdOf(principal) ?? null,
  };
}

/** The context a child of `parent` files with: the same trigger and root, the parent's run as
 *  the root when the parent is the root. */
export function childFilingContext(parent: ApprovalFilingContext, parentRunId: string | undefined): ApprovalFilingContext {
  const rootRunId = parent.rootRunId ?? parentRunId;
  return { ...parent, ...(rootRunId !== undefined ? { rootRunId } : {}) };
}

export type FilingOutcome =
  | { ok: true; id: string; message: string }
  | { ok: false; message: string };

/** The result a handler returns once its mail is filed. */
export function queuedMessage(id: string): string {
  return `Queued for the owner's approval (entry ${id}). Nothing was sent.`;
}

/** Why a filing did not go in, as the handler returns it. Every refusal says nothing was sent. */
export function notQueuedMessage(result: Exclude<FileResult, { ok: true }>): string {
  switch (result.reason) {
    case 'waiting':
      return `Not queued: the same mail is already waiting for the owner's approval (entry ${result.existingId}). Nothing was sent.`;
    case 'family_open':
      return `Not queued: a mail to the same recipients with the same subject is already waiting for the owner's approval (entry ${result.existingId}). Nothing was sent.`;
    case 'unknown':
      return `Not queued: the same mail may already have gone out, and the owner has not cleared it yet (entry ${result.existingId}). Nothing was sent.`;
    case 'sent':
      return `Not queued: the owner already sent this mail (entry ${result.existingId}). Nothing was sent.`;
    case 'discarded':
      return `Not queued: the owner discarded this mail (entry ${result.existingId}). Nothing was sent.`;
    case 'flood':
      return `Not queued: this trigger already has ${result.pending} mails waiting for the owner's approval. Nothing was sent.`;
    case 'invalid_origin':
      return `Not queued: this run cannot file for approval. Nothing was sent.`;
  }
}

/** The result when the queue could not store the mail. */
export function storeFailedMessage(): string {
  return `Not queued: the approval queue could not store the mail. Nothing was sent.`;
}

/** The result when a filing was asked for outside a call the danger check marked. */
export const NOT_MARKED_MESSAGE = 'Not queued: this call was not let through for approval. Nothing was sent.';
