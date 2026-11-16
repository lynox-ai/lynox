import type { NoticeLanguage } from './notice-language.js';

/**
 * Links to addresses an agent never opened, turned into plain text.
 *
 * An agent the network settings keep off the web (`subAgentLacksWebSearch`) cannot have opened
 * any page, yet a model still writes a well-known address as a link now and then, and whoever
 * passes its report on shows it as clickable. The prompt sentence (`SUBAGENT_NO_WEB_PROMPT_BLOCK`)
 * asks for plain text; this is the structural rest: every link form in such an agent's output
 * becomes the address as plain text with a note that it was not checked, before the output is
 * handed on or stored.
 *
 *   [Kitco](https://www.kitco.com/gold)  →  Kitco (kitco.com/gold, not checked)
 *   https://www.kitco.com/gold           →  kitco.com/gold (not checked)
 *
 * An address the agent was GIVEN (it appears in its task or context) is left as it is: it was not
 * invented, and a later step may need it as written.
 *
 * Forms: inline links and images, reference-style links and their definitions, autolinks
 * `<scheme:…>`, bare `scheme://…` and `www.…`, and HTML `<a>`. Code spans and blocks are not
 * spared: a fence is a markdown construct the filter would have to parse exactly as the renderer
 * does, and a mismatch there is a way past it.
 */

const NOTE: Record<NoticeLanguage, string> = { de: 'nicht geprüft', en: 'not checked' };
/** A note the model wrote itself right after the address, in either language: replaced, not doubled. */
const OWN_NOTE = /^[ \t]*\((?:not checked|unchecked|not verified|nicht geprüft|ungeprüft)\)/i;
/** Marks the end of a form this filter wrote, until the last pass removes it. */
const MARK = '\u0000';

const SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/i;
const WEB_SCHEMES = new Set(['http', 'https', 'ftp']);

/**
 * The address as it is shown: without scheme, user info and a leading `www.`, and with nothing
 * left in it that the chat's GFM autolinker would turn back into a link (an embedded `scheme://`
 * or `www.`, an `@`). `null` for a target that is no web address (`javascript:`, `data:`, `mailto:`):
 * its link text stays, the target goes.
 */
export function shownAddress(target: string): string | null {
  let rest = target.trim().replace(/^<|>$/g, '');
  const scheme = SCHEME.exec(rest);
  if (scheme !== null) {
    if (!WEB_SCHEMES.has(scheme[1]!.toLowerCase())) return null;
    rest = rest.slice(scheme[0].length);
  }
  rest = rest.replace(/^\/+/, '');
  // User info (`user:pass@host`) only decorates the host; shown it would read as the host.
  const hostEnd = rest.search(/[/?#]/);
  const authority = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
  const at = authority.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);
  rest = rest
    .replace(/[a-z][a-z0-9+.-]{0,31}:\/\//gi, '')
    // A leading `www.`, and one after an embedded scheme the line above took out.
    .replace(/(^|[^a-z0-9-])www\./gi, '$1')
    .replace(/@/g, '%40');
  if (/^[^/?#]*\/$/.test(rest)) rest = rest.slice(0, -1);
  return rest === '' ? null : rest;
}

/** The key two spellings of one address share, for "was this address given". */
function addressKey(target: string): string | null {
  const shown = shownAddress(target);
  return shown === null ? null : shown.toLowerCase().replace(/\/$/, '');
}

/** What the chat's GFM autolinker turns into a link by itself: `http(s)://`, `ftp://`, `www.`. */
const BARE = /(?:\b(?:https?|ftp):\/\/|(?<![a-z0-9.-])www\.)[^\s<>"'`]*/gi;

/** A bare match without the trailing characters GFM leaves outside a link. */
function trimBare(raw: string): string {
  let url = raw.replace(/[.,:;!?*_~]+$/, '');
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,:;!?*_~]+$/, '');
  }
  return url;
}

/** Every address `text` names, as keys: what an agent was given. */
function givenKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const add = (target: string): void => {
    const key = addressKey(target);
    if (key !== null) keys.add(key);
  };
  for (const m of text.matchAll(BARE)) add(trimBare(m[0]));
  for (const m of text.matchAll(/\]\(\s*<?([^\s()<>]+)/g)) add(m[1]!);
  for (const m of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s<>]+)/gm)) add(m[1]!);
  for (const m of text.matchAll(/href\s*=\s*["']?([^"'\s>]+)/gi)) add(m[1]!);
  return keys;
}

// Link text: brackets nested one level deep, as `[a [b] c](…)`.
const LABEL = String.raw`((?:[^\[\]\\]|\\.|\[(?:[^\[\]\\]|\\.)*\])*)`;
const DEST = String.raw`(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)`;
const TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`;
const INLINE = new RegExp(String.raw`!?\[${LABEL}\]\(\s*${DEST}${TITLE}\s*\)`, 'g');
const REF_DEF = /^ {0,3}\[((?:[^\[\]\\]|\\.)+)\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;
const REF_USE = new RegExp(String.raw`!?\[${LABEL}\](?:\[((?:[^\[\]\\]|\\.)*)\])?`, 'g');
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/gi;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const OPEN_ANCHOR = /<a\b([^>]*)>/gi;

const labelKey = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

function hrefOf(attrs: string): string | null {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return m === null ? null : (m[1] ?? m[2] ?? m[3] ?? '');
}

export function defuseUnopenedLinks(text: string, given: string, lang: NoticeLanguage): string {
  const note = NOTE[lang];
  const known = givenKeys(given);
  const keep = (target: string): boolean => {
    const key = addressKey(target);
    return key !== null && known.has(key);
  };
  const bare = (s: string): string => s.replace(BARE, (raw) => {
    const url = trimBare(raw);
    const tail = raw.slice(url.length);
    if (keep(url)) return raw;
    const shown = shownAddress(url);
    return `${shown === null ? '' : `${shown} (${note})${MARK}`}${tail}`;
  });
  /** The plain form of a link with text `label` to `target`. */
  const plain = (label: string, target: string): string => {
    const shown = shownAddress(target);
    const words = bare(label.replace(/\\([\[\]])/g, '$1')).replace(new RegExp(MARK, 'g'), '').trim();
    if (shown === null) return words;
    const same = words === '' || addressKey(words.replace(/ \([^)]*\)$/, '')) === shown.toLowerCase().replace(/\/$/, '')
      || words.toLowerCase() === shown.toLowerCase();
    return same ? `${shown} (${note})${MARK}` : `${words} (${shown}, ${note})${MARK}`;
  };

  let out = text.replace(new RegExp(MARK, 'g'), '');

  out = out.replace(ANCHOR, (whole, attrs: string, inner: string) => {
    const href = hrefOf(attrs);
    if (href !== null && keep(href)) return whole;
    const words = inner.replace(/<[^>]*>/g, '');
    return href === null ? words : plain(words, href);
  });
  out = out.replace(OPEN_ANCHOR, (whole, attrs: string) => {
    const href = hrefOf(attrs);
    if (href !== null && keep(href)) return whole;
    // The words that followed the tag were its link text: one space keeps them apart.
    return href === null ? '' : `${plain('', href)} `;
  });

  const defs = new Map<string, string>();
  out = out.replace(REF_DEF, (whole, label: string, target: string) => {
    if (keep(target)) return whole;
    defs.set(labelKey(label), target);
    return '';
  });

  out = out.replace(INLINE, (whole, label: string, target: string) => (keep(target) ? whole : plain(label, target)));

  if (defs.size > 0) {
    out = out.replace(REF_USE, (whole, label: string, ref: string | undefined) => {
      const target = defs.get(labelKey(ref !== undefined && ref.trim() !== '' ? ref : label));
      return target === undefined ? whole : plain(label, target);
    });
  }

  out = out.replace(AUTOLINK, (whole, target: string) => {
    if (keep(target)) return whole;
    const shown = shownAddress(target);
    return shown === null ? target.replace(SCHEME, '') : `${shown} (${note})${MARK}`;
  });

  out = bare(out);

  return out.replace(new RegExp(`${MARK}(?:${OWN_NOTE.source.slice(1)})?`, 'gi'), '');
}
