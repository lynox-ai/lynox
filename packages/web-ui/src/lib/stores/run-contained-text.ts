/**
 * What the workflow-run view says about a run started from a chat that only reads, as i18n keys.
 *
 * A run's outputs carry what its chat read. The engine marks such a run `contained`, and adds
 * `contained_unknown` when it counts the chat as contained only because it could not read the
 * record — then the text says the check failed and where to look, as for the chat itself
 * (`contained-text.ts`). A run no chat started carries neither field and shows nothing.
 */
import { readContainedUnknown, type ContainedUnknown } from './contained-text.js';

/** The run's state as the view shows it: `null` for a run that shows nothing. */
export function runContainedState(run: { contained?: unknown; contained_unknown?: unknown }): { unknown: ContainedUnknown | null } | null {
	if (run.contained !== true) return null;
	return { unknown: readContainedUnknown(run.contained_unknown) };
}

/** The mark in the run list. */
export function runContainedBadgeKey(unknown: ContainedUnknown | null): string {
	return unknown === null ? 'workflow.run_contained_badge' : 'workflow.run_contained_badge_unknown';
}

/** The sentence above the step outputs, joined with a space when shown. */
export function runContainedNoteKeys(unknown: ContainedUnknown | null): string[] {
	if (unknown === null) return ['workflow.run_contained_note'];
	return ['workflow.run_contained_note_unknown', unknown === 'provisioned' ? 'contained.unknown_way_support' : 'contained.unknown_way_logs'];
}
