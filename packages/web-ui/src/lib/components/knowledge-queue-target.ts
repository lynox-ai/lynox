/**
 * DEF-review-approve-target-opaque — what the review queue says about the subject an
 * approval would bind a pending entry to.
 *
 * Pure and separate from the component on purpose. The components in this package are not
 * mountable in the suite (see `chat-nav-targets.test.ts`), so a decision left inside the
 * template can only be guarded by reading the source — which pins that the branches EXIST,
 * never that they choose correctly. The branch that most needs choosing correctly is the
 * last one: an engine older than this UI sends no target at all, and rendering that as any
 * of the three real answers would be a wrong claim about what pressing approve does.
 */

/** The server's answer, mirrored from `KnowledgeSubjectTarget` in core's knowledge-store. */
export type ApproveTarget =
	| { resolution: 'existing'; id: string; name: string; kind: string }
	| { resolution: 'new'; name: string; kind: string }
	| { resolution: 'ambiguous'; name: string; candidates: number };

/** What the queue row renders: a name, an optional kind chip, an optional note, a tooltip. */
export interface ApproveTargetLabel {
	name: string;
	/** Raw subject kind, shown as a chip — the same raw-enum idiom SubjectsView uses. */
	kind: string | null;
	/** i18n key for the consequence worth spelling out ("will be created" / "no link"). */
	noteKey: string | null;
	/** i18n key for the hover explanation; null when there is nothing to explain. */
	titleKey: string | null;
	/** True when the note should read as a warning rather than as neutral metadata. */
	emphasis: boolean;
}

/**
 * `target` absent (not null — ABSENT) means the engine predates this field. Fall back to the
 * bare hint, exactly as the queue looked before: showing less is honest, showing a guess is
 * not. `null` arrives for a hintless entry, which never reaches this function because the
 * row renders nothing at all then — it is accepted here so the two cannot diverge.
 */
export function approveTargetLabel(
	target: ApproveTarget | null | undefined,
	hint: string,
): ApproveTargetLabel {
	switch (target?.resolution) {
		case 'existing':
			return {
				name: target.name, kind: target.kind, noteKey: null,
				titleKey: 'knowledge.queue.target_existing_title', emphasis: false,
			};
		case 'new':
			// The one that changes a decision: approving does not only file the fact, it
			// creates the subject. Emphasised for that reason, not for symmetry.
			return {
				name: target.name, kind: target.kind, noteKey: 'knowledge.queue.target_new',
				titleKey: 'knowledge.queue.target_new_title', emphasis: true,
			};
		case 'ambiguous':
			return {
				name: target.name, kind: null, noteKey: 'knowledge.queue.target_ambiguous',
				titleKey: 'knowledge.queue.target_ambiguous_title', emphasis: false,
			};
		default:
			return { name: hint, kind: null, noteKey: null, titleKey: null, emphasis: false };
	}
}
