/**
 * What the person erasure says about set-aside copies of its databases (U-389).
 *
 * A corrupt database the boot or a restore renamed aside may still hold the person's rows, and
 * the erasure does not reach it. The engine names those files (`setAsideCopies`, names only) or
 * answers `null` when it could not list the data directory. The notice is the same in the preview
 * and the answer: the copies (each name in its own box), then the way to them for the way out
 * this instance has, both ways while that is not known. Self-hosted, the `-wal` and `-shm` the
 * rename took along are named with the way, since one of them may hold the person's rows too
 * (U-389). A path is never shown: the UI does not know the data directory.
 */
import type { WayOut } from './stores/integrations/managed.svelte.js';

/** A set-aside copy as the engine names it: the file and the `-wal`/`-shm` beside it. */
export interface SetAsideCopy { file: string; companions: string[] }

/** A run of the notice: plain text, a file name or pattern in a box, or the support address. */
export type NoticeSegment = { text: string } | { mark: string } | { mail: string };

export const SUPPORT_ADDRESS = 'support@lynox.ai';

/** The pattern every set-aside copy's name follows, its `-wal` and `-shm` included. */
export const SET_ASIDE_PATTERN = '*.corrupt-*';

function boxes(out: NoticeSegment[], names: readonly string[]): void {
	names.forEach((f, i) => { if (i > 0) out.push({ text: ' ' }); out.push({ mark: f }); });
}

/**
 * Splits a sentence at `{files}`, `{companions}`, `{pattern}` and `{mail}` into segments: each
 * file name becomes its own box, in one sentence.
 */
function segments(sentence: string, files: readonly string[], companions: readonly string[]): NoticeSegment[] {
	const out: NoticeSegment[] = [];
	for (const part of sentence.split(/(\{files\}|\{companions\}|\{pattern\}|\{mail\})/)) {
		if (part === '{files}') boxes(out, files);
		else if (part === '{companions}') boxes(out, companions);
		else if (part === '{pattern}') out.push({ mark: SET_ASIDE_PATTERN });
		else if (part === '{mail}') out.push({ mail: SUPPORT_ADDRESS });
		else if (part !== '') out.push({ text: part });
	}
	return out;
}

/**
 * The notice's sentences, each as segments, or `[]` when no copy was set aside. `copies` is the
 * engine's `setAsideCopies`: an engine that does not send it (`undefined`) says nothing either.
 */
export function setAsideCopiesNotice(
	copies: readonly SetAsideCopy[] | null | undefined,
	wayOut: WayOut,
	t: (key: string) => string,
): NoticeSegment[][] {
	if (copies === undefined || (copies !== null && copies.length === 0)) return [];
	const form = copies === null ? 'unchecked' : copies.length === 1 ? 'one' : 'many';
	const files = (copies ?? []).map(c => c.file);
	const companions = (copies ?? []).flatMap(c => c.companions);
	const self = companions.length > 0 ? `self_${form}_with` : `self_${form}`;
	const ways = wayOut === 'managed' ? [`cloud_${form}`] : wayOut === 'self' ? [self] : [`cloud_${form}`, self];
	return [`core_${form}`, ...ways].map(k => segments(t(`erasure.sa.${k}`), files, companions));
}

/** The notice as plain text, one string per sentence (tests and screen readers read the same). */
export function noticeText(lines: NoticeSegment[][]): string[] {
	return lines.map(l => l.map(s => 'text' in s ? s.text : 'mark' in s ? s.mark : s.mail).join(''));
}
