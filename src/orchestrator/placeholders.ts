/**
 * The `{{…}}` placeholders in a text: the same ones `/\{\{([^}]+)\}\}/g` finds, in time linear in
 * the length of the text.
 *
 * The regex tries again from every `{{` and, when no `}` follows, reads to the end of the text each
 * time, so its time grows with the square of the length; an anchored form with `\s*` on both sides
 * of the path grows with the cube on a `{{` followed by spaces. A stored task or input template is
 * text a model or an import wrote, and every scan runs on the event loop. Here the next `}` from a
 * position is looked up once and only moves forward.
 *
 * The sites that resolve, check or rename step references (`context.ts`, `template-refs.ts`,
 * `step-id.ts`, `workflow-edit.ts`) and the webhook check (`webhook-verifiers.ts`) go through this
 * module, so they see the same placeholders. Two other readers keep their own patterns on purpose:
 * `contract-validation.ts` (a `{{params.` prefix, no closing braces needed) and the captured-call
 * rewrite in `tools/builtin/process.ts` (one named placeholder at a time).
 */

/** One placeholder: `start` is the index of its `{{`, `end` the index after its `}}`, `inner` the text between. */
export interface Placeholder {
  start: number;
  end: number;
  inner: string;
}

const CLOSE = 0x7d; // '}'

/** Every placeholder in `text`, left to right, as `text.matchAll(/\{\{([^}]+)\}\}/g)` finds them. */
export function placeholders(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  // The next '}' at or after `open + 2`. No '}' between `open + 2` and it, so it stays the next one
  // for every later `open` that is still before it.
  let close = -1;
  let open = text.indexOf('{{');
  while (open !== -1) {
    if (close < open + 2) {
      close = text.indexOf('}', open + 2);
      // No '}' after this `{{`, so none after any later one either.
      if (close === -1) break;
    }
    // The regex needs one character or more that is not '}' between the braces, then `}}`.
    if (close > open + 2 && text.charCodeAt(close + 1) === CLOSE) {
      found.push({ start: open, end: close + 2, inner: text.slice(open + 2, close) });
      open = text.indexOf('{{', close + 2);
    } else {
      open = text.indexOf('{{', open + 1);
    }
  }
  return found;
}

/** `text` with each placeholder replaced by what `replace` returns for it, as `text.replace(/\{\{([^}]+)\}\}/g, …)` does. */
export function replacePlaceholders(text: string, replace: (match: string, inner: string) => string): string {
  const found = placeholders(text);
  if (found.length === 0) return text;
  let out = '';
  let at = 0;
  for (const p of found) {
    out += text.slice(at, p.start) + replace(text.slice(p.start, p.end), p.inner);
    at = p.end;
  }
  return out + text.slice(at);
}

/**
 * The text between the braces when all of `text` is one placeholder, otherwise null: the strings
 * `/^\{\{\s*([^}]+)\s*\}\}$/` matches. Its capture differs from the return value only in leading
 * white space, and every caller trims it.
 */
export function solePlaceholder(text: string): string | null {
  if (!text.startsWith('{{')) return null;
  const [first] = placeholders(text);
  return first !== undefined && first.start === 0 && first.end === text.length ? first.inner : null;
}

/**
 * A placeholder's inner text split into the white space before its path and the path, as
 * `/\{\{(\s*)([^}]+)\}\}/` captures them: all the leading white space, but never the last character,
 * since the path is one character or more.
 */
export function splitLeadingSpace(inner: string): [string, string] {
  const lead = Math.min(inner.length - inner.trimStart().length, inner.length - 1);
  return [inner.slice(0, lead), inner.slice(lead)];
}
