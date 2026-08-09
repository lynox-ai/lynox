/**
 * Fill `{placeholder}` slots in a translated string.
 *
 * Kept out of `i18n.svelte.ts` deliberately: that module holds the active locale in a
 * `$state` rune, so a test importing it needs the rune compiler and cannot run in the
 * ordinary suite. This is pure, so the reason below is defended where it is enforced.
 *
 * Use this instead of `t(key).replace('{x}', value)` whenever the value is not a number you
 * produced yourself. In a replacement STRING, `$&`, `` $` ``, `$'` and `$1` are substitution
 * patterns: a value containing one silently rewrites the message around it, and `$'`
 * truncates it outright. That is at its worst in a confirmation dialog, which is the one
 * place the text has to be exactly what the user is agreeing to. `replaceAll` has the same
 * semantics, so reaching for it is not the fix. Passing a FUNCTION is — this wraps that so
 * the reason has a name and cannot be "simplified" away.
 *
 * Every occurrence is replaced, and an unknown placeholder is left standing rather than
 * blanked, so a typo shows up instead of quietly deleting text.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		Object.hasOwn(vars, name) ? (vars[name] ?? '') : whole,
	);
}
