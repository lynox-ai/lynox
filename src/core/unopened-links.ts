import type { NoticeLanguage } from './notice-language.js';

/**
 * Links to addresses an agent never opened, turned into plain text.
 *
 * An agent the network settings keep off the web (`subAgentLacksWebSearch`) cannot have opened
 * any page, yet a model still writes a well-known address as a link now and then, and whoever
 * passes its report on shows it as clickable. The prompt sentence (`SUBAGENT_NO_WEB_PROMPT_BLOCK`)
 * asks for plain text; this is the structural rest: every link in such an agent's output becomes
 * the address as plain text with a note that it was not checked, before the output is handed on
 * or stored.
 *
 *   [Kitco](https://www.kitco.com/gold)  →  Kitco (kitco.com/gold, not checked)
 *   https://www.kitco.com/gold           →  kitco.com/gold (not checked)
 *
 * An address the agent was GIVEN (it appears in its task or context) is left as it is: it was not
 * invented, and a later step may need it as written.
 *
 * Two passes. The first turns the forms it recognises into the readable plain form: inline links
 * and images, reference-style links and their definitions, autolinks `<scheme:…>`, bare
 * `http(s)://`, `ftp://` and `www.`, and HTML `<a>`. It cannot parse markdown exactly as the
 * renderer does (nested brackets, a definition inside a list item, an `<img>`, an entity-encoded
 * scheme), so the second pass SEALS whatever is left: every `](` and `]:` is escaped, so no
 * inline link and no definition can form, and every HTML tag opener becomes `&lt;`. Only the links
 * kept as given are spared. A miss in the first pass therefore costs readability, never a link.
 * Code spans and blocks are not spared either: a fence is a construct the filter would have to
 * parse exactly as the renderer does, and a mismatch there is a way past it.
 */

const NOTE: Record<NoticeLanguage, string> = { de: 'nicht geprüft', en: 'not checked' };
/** A note the model wrote itself right after the address, in either language: replaced, not doubled. */
const OWN_NOTE = String.raw`[ \t]*\((?:not checked|unchecked|not verified|nicht geprüft|ungeprüft)\)`;
/** Marks the end of a form this filter wrote, until the last pass removes it. */
const MARK = '\u0000';
/** Brackets a link kept as given, by its index, while the sealing pass runs. */
const KEEP = '\u0001';

const SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/i;
const WEB_SCHEMES = new Set(['http', 'https', 'ftp']);

/** `target` as an absolute web URL: a scheme-less or protocol-relative one is read as `https`. */
function webUrl(target: string): URL | null {
  const raw = target.trim().replace(/^<|>$/g, '');
  const scheme = SCHEME.exec(raw);
  if (scheme !== null && !WEB_SCHEMES.has(scheme[1]!.toLowerCase())) return null;
  try {
    return new URL(scheme !== null ? raw : `https://${raw.replace(/^\/+/, '')}`);
  } catch {
    return null;
  }
}

/**
 * The address as it is shown: without scheme, user info and a leading `www.`, path and query as
 * written, and with nothing left in it that the chat's GFM autolinker would turn back into a link
 * (an embedded `scheme://` or `www.`, an `@`). `null` for a target that is no web address
 * (`javascript:`, `data:`, `mailto:`): its link text stays, the target goes.
 */
export function shownAddress(target: string): string | null {
  let rest = target.trim().replace(/^<|>$/g, '');
  const scheme = SCHEME.exec(rest);
  if (scheme !== null) {
    if (!WEB_SCHEMES.has(scheme[1]!.toLowerCase())) return null;
    rest = rest.slice(scheme[0].length);
  }
  rest = rest.replace(/^[/\\]+/, '');
  // User info (`user:pass@host`) only decorates the host; shown it would read as the host.
  const hostEnd = rest.search(/[/?#\\]/);
  const authority = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
  const at = authority.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);
  rest = rest
    .replace(/(?:https?|ftp):[/\\]{2}/gi, '')
    // A leading `www.`, and any other the autolinker would pick up.
    .replace(/(^|[^a-z0-9-])www\./gi, '$1')
    .replace(/@/g, '%40');
  if (/^[^/?#]*\/$/.test(rest)) rest = rest.slice(0, -1);
  return rest === '' ? null : rest;
}

/**
 * The key two spellings of one address share, for "was this address given": host (without
 * `www.`), path and query as the URL parser reads them. Read by the parser and not from the shown
 * form, so an address whose real host differs (`https://evil.example.https://kitco.com/gold`)
 * never shares a key with the one given.
 */
function addressKey(target: string): string | null {
  const url = webUrl(target);
  if (url === null || url.hostname === '') return null;
  return `${url.hostname.replace(/^www\./, '')}${url.port === '' ? '' : `:${url.port}`}${url.pathname.replace(/\/$/, '')}${url.search}`;
}

/** What the chat's GFM autolinker turns into a link by itself: `http(s)://`, `ftp://`, `www.`. */
const BARE = /(?:\b(?:https?|ftp):\/\/|www\.)[^\s<>"'`\\]*/gi;

/** A bare match without the trailing characters GFM leaves outside a link. */
function trimBare(raw: string): string {
  let url = raw.replace(/[.,:;!?*_~]+$/, '');
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,:;!?*_~]+$/, '');
  }
  return url;
}

/**
 * Every address `text` names, as keys: what an agent was given. The text is read as the agent
 * received it: a workflow step's input is JSON, a child's context is XML-escaped.
 */
function givenKeys(text: string): Set<string> {
  const plainText = text.replace(/\\[nrt"\\/]/g, ' ').replace(/&amp;/g, '&');
  const keys = new Set<string>();
  const add = (target: string): void => {
    const key = addressKey(target);
    if (key !== null) keys.add(key);
  };
  for (const m of plainText.matchAll(BARE)) add(trimBare(m[0]));
  for (const m of plainText.matchAll(/\]\(\s*<?([^\s()<>]+)/g)) add(m[1]!);
  for (const m of plainText.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s<>]+)/gm)) add(m[1]!);
  for (const m of plainText.matchAll(/href\s*=\s*["']?([^"'\s>]+)/gi)) add(m[1]!);
  return keys;
}

// Bounded, so a long output of brackets or tags costs linear time: what a bound cuts off is not
// recognised by the first pass, and the sealing pass takes it.
// Link text: brackets nested one level deep, as `[a [b] c](…)`.
const LABEL = String.raw`((?:[^\[\]\\\n]|\\.|\[(?:[^\[\]\\\n]|\\.){0,300}\]){0,300})`;
const DEST = String.raw`(<[^<>\n]{0,2000}>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.){0,2000}\)){0,2000})`;
const TITLE = String.raw`(?:\s{1,20}(?:"[^"]{0,500}"|'[^']{0,500}'|\([^)]{0,500}\)))?`;
const INLINE = new RegExp(String.raw`!?\[${LABEL}\]\(\s{0,20}${DEST}${TITLE}\s{0,20}\)`, 'g');
const REF_DEF = /^ {0,3}\[((?:[^\[\]\\\n]|\\.){1,300})\]:[ \t]*\n?[ \t]*(<[^<>\n]{0,2000}>|\S{1,2000})(?:[ \t]+(?:"[^"\n]{0,500}"|'[^'\n]{0,500}'|\([^)\n]{0,500}\)))?[ \t]*$/gm;
const REF_USE = new RegExp(String.raw`!?\[${LABEL}\](?:\[((?:[^\[\]\\\n]|\\.){0,300})\])?`, 'g');
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]{0,2000})>/gi;
// An `<a` that opens a tag: followed by white space or `>`, so `Map<a, b>` is left alone.
const ANCHOR = /<a(\s[^>]{0,2000})?>([\s\S]{0,2000}?)<\/a\s*>/gi;
const OPEN_ANCHOR = /<a\s[^>]{0,2000}>/gi;

const labelKey = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

function hrefOf(attrs: string | undefined): string | null {
  if (attrs === undefined) return null;
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return m === null ? null : (m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * The sealing pass: no inline link, definition or HTML tag can form in `text` any more. A `]`
 * before `(` or `:` gets a backslash unless an odd run of them already escapes it; a `<` that
 * opens a tag, a comment or a declaration becomes `&lt;`. Both render as the characters they were.
 */
function seal(text: string): string {
  return text
    .replace(/(\\*)\](?=[(:])/g, (_m, slashes: string) => `${slashes}${slashes.length % 2 === 0 ? '\\' : ''}]`)
    .replace(/<(?=[a-z/!?])/gi, '&lt;');
}

export function defuseUnopenedLinks(text: string, given: string, lang: NoticeLanguage): string {
  const note = NOTE[lang];
  const known = givenKeys(given);
  const kept: string[] = [];
  /** A link kept as given, out of the sealing pass's reach until the end. */
  const keepAs = (whole: string): string => `${KEEP}${kept.push(whole) - 1}${KEEP}`;
  const keep = (target: string): boolean => {
    const key = addressKey(target);
    return key !== null && known.has(key);
  };
  const bare = (s: string): string => s.replace(BARE, (raw) => {
    const url = trimBare(raw);
    const tail = raw.slice(url.length);
    if (keep(url)) return `${keepAs(url)}${tail}`;
    const shown = shownAddress(url);
    return `${shown === null ? '' : `${shown} (${note})${MARK}`}${tail}`;
  });
  /** The plain form of a link with text `label` to `target`. */
  const plain = (label: string, target: string): string => {
    const shown = shownAddress(target);
    const words = bare(label.replace(/\\([\[\]])/g, '$1')).replace(new RegExp(`${MARK}|${KEEP}\\d+${KEEP}`, 'g'), '').trim();
    if (shown === null) return words;
    const same = words === '' || words.toLowerCase() === shown.toLowerCase()
      || (shownAddress(words.replace(/ \([^)]*\)$/, '')) ?? '').toLowerCase() === shown.toLowerCase();
    return same ? `${shown} (${note})${MARK}` : `${words} (${shown}, ${note})${MARK}`;
  };

  let out = text.replace(new RegExp(`[${MARK}${KEEP}]`, 'g'), '');

  out = out.replace(ANCHOR, (whole, attrs: string | undefined, inner: string) => {
    const href = hrefOf(attrs);
    if (href !== null && keep(href)) return keepAs(whole);
    const words = inner.replace(/<[^>]*>/g, '');
    return href === null ? words : plain(words, href);
  });
  out = out.replace(OPEN_ANCHOR, (whole: string) => {
    const href = hrefOf(whole.slice(2, -1));
    if (href !== null && keep(href)) return keepAs(whole);
    // The words that followed the tag were its link text: one space keeps them apart.
    return href === null ? '' : `${plain('', href)} `;
  });

  const defs = new Map<string, string>();
  out = out.replace(REF_DEF, (whole, label: string, target: string) => {
    if (keep(target)) return keepAs(whole);
    defs.set(labelKey(label), target);
    return '';
  });

  out = out.replace(INLINE, (whole, label: string, target: string) => (keep(target) ? keepAs(whole) : plain(label, target)));

  if (defs.size > 0) {
    out = out.replace(REF_USE, (whole, label: string, ref: string | undefined) => {
      const target = defs.get(labelKey(ref !== undefined && ref.trim() !== '' ? ref : label));
      return target === undefined ? whole : plain(label, target);
    });
  }

  out = out.replace(AUTOLINK, (whole, target: string) => {
    if (keep(target)) return keepAs(whole);
    const shown = shownAddress(target);
    return shown === null ? target.replace(SCHEME, '') : `${shown} (${note})${MARK}`;
  });

  out = seal(bare(out));

  return out
    .replace(new RegExp(`${MARK}(?:${OWN_NOTE})?`, 'gi'), '')
    .replace(new RegExp(`${KEEP}(\\d+)${KEEP}`, 'g'), (_m, i: string) => kept[Number(i)] ?? '');
}
