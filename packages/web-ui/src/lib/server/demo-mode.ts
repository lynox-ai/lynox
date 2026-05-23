import { env } from '$env/dynamic/private';

export type DemoLocale = 'en' | 'de';

/**
 * Demo-mode sessions live 24h, not the 30-day default. A public playground
 * cookie that survives 30 days on a shared/kiosk browser is a long-lived
 * foothold for the next person on that machine.
 */
export const DEMO_SESSION_MAX_AGE_S = 24 * 60 * 60;

export function isDemoMode(): boolean {
	return env.LYNOX_DEMO_MODE === 'true';
}

export function getDemoLocale(): DemoLocale {
	return env.LYNOX_DEMO_LOCALE === 'de' ? 'de' : 'en';
}
