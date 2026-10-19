/**
 * The name a built-in provider is shown under, from its preset id. The id is the engine's
 * (`bexio`, `shopify`), never free text. bexio writes its own name in lower case, so it keeps
 * it; any other provider is shown with a capital first letter.
 */
export function presetProviderLabel(presetId: string): string {
	if (presetId === 'bexio') return 'bexio';
	return presetId.charAt(0).toUpperCase() + presetId.slice(1);
}
