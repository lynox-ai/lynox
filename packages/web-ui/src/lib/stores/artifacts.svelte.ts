import { getApiBase } from '../config.svelte.js';
import { t } from '../i18n.svelte.js';

export type ArtifactType = 'html' | 'mermaid' | 'svg' | 'markdown' | 'csv' | 'tsv' | 'json' | 'text';

export interface ArtifactMeta {
	id: string;
	title: string;
	description: string;
	type: ArtifactType;
	createdAt: string;
	updatedAt: string;
	threadId: string;
	/** Optional for back-compat with older API responses that predate the
	 *  field; bumped on every save and on every external file-tool edit. */
	version?: number;
	/** Set by the engine when the stored file holds its placeholder for a
	 *  saved body instead of a document — the document was lost on save. */
	lostOnSave?: boolean;
}

export interface Artifact extends ArtifactMeta {
	content: string;
}

let artifacts = $state<ArtifactMeta[]>([]);
let isLoading = $state(false);

export async function loadArtifacts(): Promise<void> {
	isLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/artifacts`);
		if (res.ok) {
			const data = (await res.json()) as { artifacts: ArtifactMeta[] };
			artifacts = data.artifacts;
		}
	} catch {
		// non-critical
	} finally {
		isLoading = false;
	}
}

export async function getArtifact(id: string): Promise<Artifact | null> {
	try {
		const res = await fetch(`${getApiBase()}/artifacts/${id}`);
		if (res.ok) return (await res.json()) as Artifact;
	} catch {
		// non-critical
	}
	return null;
}

export interface SaveArtifactOpts {
	title: string;
	content: string;
	type?: ArtifactType;
	description?: string;
	id?: string;
}

/** Why the server refused a save, where it named a reason the UI can say in the person's
 *  language: `placeholder` is content that is only the assistant's placeholder, not a document. */
export type SaveArtifactRefusal = 'placeholder';

/** A save that did not happen carries `refusal` for a refusal the UI can name, and `null` for
 *  every other failure. */
export type SaveArtifactResult = { artifact: Artifact } | { artifact: null; refusal: SaveArtifactRefusal | null };

export async function trySaveArtifact(opts: SaveArtifactOpts): Promise<SaveArtifactResult> {
	try {
		const res = await fetch(`${getApiBase()}/artifacts`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(opts),
		});
		if (res.ok) {
			const artifact = (await res.json()) as Artifact;
			// Refresh list
			await loadArtifacts();
			return { artifact };
		}
		if (res.status === 422) {
			const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
			if (body?.code === 'artifact_placeholder') return { artifact: null, refusal: 'placeholder' };
		}
	} catch {
		// non-critical
	}
	return { artifact: null, refusal: null };
}

/** The text for a save that did not happen: the refusal's own, or `fallback`. */
export function saveFailureText(result: { refusal: SaveArtifactRefusal | null }, fallback: string): string {
	return result.refusal === 'placeholder' ? t('artifacts.placeholder_refused') : fallback;
}

/** The saved artifact, or `null` for any save that did not happen. */
export async function saveArtifact(opts: SaveArtifactOpts): Promise<Artifact | null> {
	return (await trySaveArtifact(opts)).artifact;
}

export async function deleteArtifact(id: string): Promise<void> {
	await fetch(`${getApiBase()}/artifacts/${id}`, { method: 'DELETE' });
	artifacts = artifacts.filter((a) => a.id !== id);
}

export function getArtifacts() {
	return artifacts;
}
export function getIsLoadingArtifacts() {
	return isLoading;
}

/** Artifacts created in a specific thread/session, newest first. Cheap filter
 *  over the in-memory list already populated by `loadArtifacts()`. */
export function getSessionArtifacts(threadId: string | null | undefined): ArtifactMeta[] {
	if (!threadId) return [];
	return artifacts
		.filter((a) => a.threadId === threadId)
		.slice()
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
