import { env } from '$env/dynamic/private';

export type DemoLocale = 'en' | 'de';

export function isDemoMode(): boolean {
	return env.LYNOX_DEMO_MODE === 'true';
}

export function getDemoLocale(): DemoLocale {
	return env.LYNOX_DEMO_LOCALE === 'de' ? 'de' : 'en';
}
