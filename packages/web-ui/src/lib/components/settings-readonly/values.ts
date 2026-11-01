// How a settings value reads as text in a mandate's session (ux U-104).

import { t } from '../../i18n.svelte.js';

/** A switch: "An" / "Aus". */
export function onOff(on: boolean | undefined | null): string {
	return on ? t('settings.value_on') : t('settings.value_off');
}

/** A value, or "Nicht festgelegt" when there is none. */
export function orNotSet(value: string | number | undefined | null): string {
	return value === undefined || value === null || String(value).trim() === '' ? t('settings.value_not_set') : String(value);
}

/** The visible label of a choice, not its code; the code itself when no label matches. */
export function optionLabel(value: string | undefined | null, options: ReadonlyArray<{ value: string; label: string }>): string {
	if (value === undefined || value === null || value === '') return t('settings.value_not_set');
	return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * An endpoint the owner entered, as a mandate may read it: scheme, host and path. Credentials,
 * a query and a fragment can hold a key, so they are left out (the owner's form shows them).
 */
export function endpointText(url: string | undefined | null): string {
	if (url === undefined || url === null || url.trim() === '') return t('settings.value_not_set');
	try {
		const u = new URL(url.trim());
		// `user:pw@host` parses as an opaque URL with scheme `user:` and no host.
		if (u.host === '') throw new Error('no host');
		return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
	} catch {
		// Not a URL the browser parses: keep what stands between the last `@` and the first `?` or `#`.
		return url.trim().replace(/^[^]*@/, '').replace(/[?#][^]*$/, '') || t('settings.value_not_set');
	}
}
