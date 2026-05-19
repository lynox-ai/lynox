import type { LayoutServerLoad } from './$types.js';
import { isDemoMode, getDemoLocale } from '$lib/server/demo-mode.js';

export const load: LayoutServerLoad = () => {
	const demo = isDemoMode();
	return {
		demoMode: demo,
		demoLocale: demo ? getDemoLocale() : null,
	};
};
