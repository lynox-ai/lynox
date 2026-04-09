import { getApiBase } from '../config.svelte.js';

export type ArtifactType = 'html' | 'mermaid' | 'svg';

export interface ArtifactMeta {
	id: string;
	title: string;
	description: string;
	type: ArtifactType;
	createdAt: string;
	updatedAt: string;
	threadId: string;
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

export async function saveArtifact(opts: {
	title: string;
	content: string;
	type?: ArtifactType;
	description?: string;
	id?: string;
}): Promise<Artifact | null> {
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
			return artifact;
		}
	} catch {
		// non-critical
	}
	return null;
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
