/**
 * The markup check of a bulk run's HTML fields (PRD shopify-preset §20.2 item 5, §21.2 item 4).
 *
 * A verdict or a planner's after-state may rewrite a product description; it may not add
 * markup the owner does not read. The rule works on the `parse5` tree, never on the text:
 * - elements and comments are counted as a multiset of occurrences; one outside a small
 *   allowlist passes only as often as the before-image of that field holds the same
 *   occurrence, its raw-text content and its `template` flag included;
 * - every (namespace, element, attribute, value) the after-state holds is held by the
 *   before-image, or is an `href` on an allowlisted `a` whose target passes the domain rule;
 * - hidden characters count per code point, no more often than in the before-image.
 *
 * The check runs on two trees of the bytes sent: the tree they parse to, and the tree of their
 * canonical round trip, each against the before-image's tree of the same kind. Serialising a
 * `parse5` tree and parsing it again need not give the same tree (foreign content, raw-text
 * parents, form re-nesting), so a value whose canonical form is not stable is refused outright.
 *
 * It never throws on an input: a refusal after the paid model call is a fixed reason (M8).
 */

import { parseFragment, serialize, defaultTreeAdapter, html as p5 } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { hiddenCharIndexes } from './hidden-chars.js';
import type { BulkListSourceForm } from './bulk-list.js';

export type HtmlFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

// --- Stand-ins for `html-tree.ts`, replaced by that module on rebase. Same contract: a
// fragment in a `div` context with scripting on, and its serialisation unnormalised.

function parseHtmlFragment(value: string): HtmlFragment {
  const div = defaultTreeAdapter.createElement('div', p5.NS.HTML, []);
  return parseFragment(div, value, { scriptingEnabled: true });
}

function canonicalHtml(value: string): string {
  return serialize(parseHtmlFragment(value));
}

// --- Which fields hold HTML. Only the form knows a field's content type; a key name is no
// evidence. A closed map from the list read, until forms declare it themselves.

const HTML_FIELDS: Readonly<Record<BulkListSourceForm, readonly string[]>> = Object.freeze({
  shopify: Object.freeze(['descriptionHtml']),
  woocommerce: Object.freeze(['description', 'short_description']),
});

/** The fields of a list form whose values are HTML. Empty for a run without a list form. */
export function htmlFieldsOfListForm(form: BulkListSourceForm | null): readonly string[] {
  return form === null ? [] : HTML_FIELDS[form] ?? [];
}

// --- The extraction.

export type MarkupNamespace = 'html' | 'svg' | 'mathml' | 'other';

/** One element or comment of a tree, as much as tells two apart. */
export interface Occurrence {
  kind: 'element' | 'comment';
  /** Empty for a comment. */
  namespace: MarkupNamespace | '';
  /** The element's name as the tree holds it; empty for a comment. */
  name: string;
  /** Name (with its prefix, `xlink:href`) and decoded value, sorted by name. */
  attributes: (readonly [name: string, value: string])[];
  /** The text below a script, style, raw-text or RCDATA element; a comment's text; else null. */
  text: string | null;
  /** Inside a `template`'s content: inert there, live once lifted out. */
  inTemplate: boolean;
}

/** An element, or one of its attributes with its value. `attribute` null is the element itself. */
export interface Triple {
  namespace: MarkupNamespace;
  element: string;
  attribute: string | null;
  value: string | null;
}

const NAMESPACES: Readonly<Record<string, MarkupNamespace>> = {
  [p5.NS.HTML]: 'html',
  [p5.NS.SVG]: 'svg',
  [p5.NS.MATHML]: 'mathml',
};

/** Elements whose content is code or text the parser does not read as markup. `script` and
 *  `style` in every namespace: in SVG and MathML their body hangs below them as text nodes,
 *  and an inline SVG `<script>` runs. Wider than the PRD's list where the parser has more
 *  raw-text elements (`iframe`, `noframes`, `plaintext`); wider only errs toward refusing. */
const TEXT_CARRIERS = new Set([
  'script', 'style', 'noscript', 'xmp', 'noembed', 'noframes', 'iframe', 'plaintext', 'textarea', 'title',
]);

function isElement(n: Node): n is Element {
  return 'tagName' in n;
}

function childrenOf(n: Node): Node[] {
  if (isElement(n) && n.tagName === 'template' && n.namespaceURI === p5.NS.HTML) {
    return defaultTreeAdapter.getChildNodes(defaultTreeAdapter.getTemplateContent(n as DefaultTreeAdapterTypes.Template));
  }
  return 'childNodes' in n ? n.childNodes : [];
}

function textBelow(n: Node): string {
  let out = '';
  for (const c of childrenOf(n)) out += c.nodeName === '#text' ? (c as DefaultTreeAdapterTypes.TextNode).value : textBelow(c);
  return out;
}

function attributesOf(el: Element): (readonly [string, string])[] {
  return el.attrs
    .map((a) => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

/** Every element and comment occurrence of a fragment, `template` contents and foreign
 *  content included, and every triple. An element without attributes is the triple
 *  (element, ∅, ∅), so a bare `<script>` is not invisible. */
export function markupOf(fragment: HtmlFragment): { occurrences: Occurrence[]; triples: Triple[] } {
  const occurrences: Occurrence[] = [];
  const triples: Triple[] = [];
  const walk = (n: Node, inTemplate: boolean): void => {
    for (const c of childrenOf(n)) {
      if (c.nodeName === '#comment') {
        occurrences.push({ kind: 'comment', namespace: '', name: '', attributes: [], text: (c as DefaultTreeAdapterTypes.CommentNode).data, inTemplate });
        continue;
      }
      if (!isElement(c)) continue;
      const namespace = NAMESPACES[c.namespaceURI] ?? 'other';
      const attributes = attributesOf(c);
      const text = TEXT_CARRIERS.has(c.tagName) ? textBelow(c) : null;
      occurrences.push({ kind: 'element', namespace, name: c.tagName, attributes, text, inTemplate });
      triples.push({ namespace, element: c.tagName, attribute: null, value: null });
      for (const [attribute, value] of attributes) triples.push({ namespace, element: c.tagName, attribute, value });
      // A text carrier's content is in its occurrence; below a foreign `script` or `style`
      // there may still be elements, and they count as their own.
      walk(c, inTemplate || (c.tagName === 'template' && c.namespaceURI === p5.NS.HTML));
    }
  };
  walk(fragment, false);
  return { occurrences, triples };
}

// --- The rule.

/** HTML namespace only: an SVG or MathML `a` is outside it. */
const ALLOWED_ELEMENTS = new Set(['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'a']);

function allowedElement(o: { namespace: string; name: string }): boolean {
  return o.namespace === 'html' && ALLOWED_ELEMENTS.has(o.name);
}

function isLinkTriple(t: Triple): boolean {
  return t.namespace === 'html' && t.element === 'a' && t.attribute === 'href';
}

export type MarkupRefusal =
  | 'element_not_allowed'
  | 'attribute_not_allowed'
  | 'content_changed'
  | 'comment_added'
  | 'new_img'
  | 'new_link_domain'
  | 'url_scheme'
  | 'url_control_char'
  | 'hidden_char'
  | 'not_canonical';

export interface MarkupCheckInput {
  /** The field's before-image; null where the target has none. */
  before: string | null;
  /** The bytes sent: canonical where the form sends the canonical form, raw where it does not. */
  after: string;
  /** The store host the run knows; relative links resolve against it. */
  storeHost: string;
  /** The domains the owner gave at the start. */
  startDomains: readonly string[];
}

export type MarkupCheckResult = { ok: true } | { ok: false; reason: MarkupRefusal; detail: string };

const DETAIL_MAX = 200;

function refused(reason: MarkupRefusal, detail: string): MarkupCheckResult {
  return { ok: false, reason, detail: detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail };
}

/** Whether a verdict's or a plan's value for an HTML field adds markup the owner does not read. */
export function checkMarkup(input: MarkupCheckInput): MarkupCheckResult {
  try {
    const canonical = canonicalHtml(input.after);
    if (canonicalHtml(canonical) !== canonical) {
      return refused('not_canonical', 'The value parses to another tree once serialised.');
    }
    const before = input.before ?? '';
    // Each tree of the after-state against the before-image's tree of the same kind.
    const raw = checkTrees(parseHtmlFragment(before), parseHtmlFragment(input.after), input);
    if (!raw.ok) return raw;
    return checkTrees(parseHtmlFragment(canonicalHtml(before)), parseHtmlFragment(canonical), input);
  } catch {
    // parse5 does not throw on any string; this is the fixed reason should it ever.
    return refused('not_canonical', 'The value could not be read as HTML.');
  }
}

function occurrenceKey(o: Occurrence): string {
  return JSON.stringify([o.kind, o.namespace, o.name, o.attributes, o.text, o.inTemplate]);
}

function shellKey(o: Occurrence): string {
  return JSON.stringify([o.kind, o.namespace, o.name, o.attributes, o.inTemplate]);
}

function tripleKey(t: Triple): string {
  return JSON.stringify([t.namespace, t.element, t.attribute, t.value]);
}

function counts(keys: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function describe(o: Occurrence): string {
  if (o.kind === 'comment') return `<!--${o.text ?? ''}-->`;
  const attrs = o.attributes.map(([n, v]) => ` ${n}="${v}"`).join('');
  return `<${o.namespace === 'html' ? '' : `${o.namespace}:`}${o.name}${attrs}>`;
}

function checkTrees(beforeTree: HtmlFragment, afterTree: HtmlFragment, input: MarkupCheckInput): MarkupCheckResult {
  const before = markupOf(beforeTree);
  const after = markupOf(afterTree);

  // Occurrences outside the allowlist: a multiset, byte for byte.
  const held = counts(before.occurrences.filter((o) => !allowedElement(o)).map(occurrenceKey));
  const heldAtAll = new Set(held.keys());
  const heldShells = new Set(before.occurrences.filter((o) => o.text !== null).map(shellKey));
  for (const o of after.occurrences) {
    if (allowedElement(o)) continue;
    const k = occurrenceKey(o);
    const left = held.get(k) ?? 0;
    if (left > 0) { held.set(k, left - 1); continue; }
    if (o.kind === 'comment') return refused('comment_added', describe(o));
    // The same element with another body; a second copy of a held one is an addition.
    if (o.text !== null && !heldAtAll.has(k) && heldShells.has(shellKey(o))) return refused('content_changed', describe(o));
    if (o.namespace === 'html' && o.name === 'img') return refused('new_img', describe(o));
    return refused('element_not_allowed', describe(o));
  }

  // Attributes with their values: held, or a link whose target passes.
  const heldTriples = new Set(before.triples.map(tripleKey));
  const linkDomains = linkedDomains(before.triples, input.storeHost);
  for (const t of after.triples) {
    if (t.attribute === null || heldTriples.has(tripleKey(t))) continue;
    if (!isLinkTriple(t)) return refused('attribute_not_allowed', `${t.element} ${t.attribute}="${t.value ?? ''}"`);
    const link = checkLink(t.value ?? '', input, linkDomains);
    if (!link.ok) return link;
  }

  // Hidden characters: per code point, no more often than the before-image holds them.
  const hiddenBefore = hiddenCounts(beforeTree);
  for (const [cp, n] of hiddenCounts(afterTree)) {
    if (n > (hiddenBefore.get(cp) ?? 0)) return refused('hidden_char', `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  return { ok: true };
}

/** Every text a tree carries: text nodes, attribute values, comments. */
function textsOf(n: Node, out: string[] = []): string[] {
  for (const c of childrenOf(n)) {
    if (c.nodeName === '#text') out.push((c as DefaultTreeAdapterTypes.TextNode).value);
    else if (c.nodeName === '#comment') out.push((c as DefaultTreeAdapterTypes.CommentNode).data);
    else if (isElement(c)) {
      for (const a of c.attrs) out.push(a.value);
      textsOf(c, out);
    }
  }
  return out;
}

function hiddenCounts(tree: HtmlFragment): Map<number, number> {
  const m = new Map<number, number>();
  for (const text of textsOf(tree)) {
    const chars = Array.from(text);
    for (const i of hiddenCharIndexes(text)) {
      const cp = chars[i]!.codePointAt(0)!;
      m.set(cp, (m.get(cp) ?? 0) + 1);
    }
  }
  return m;
}

// --- The domain rule.

const LINK_SCHEMES = new Set(['https:', 'http:', 'mailto:']);
/** C0 controls and DEL, U+FFFD (what `parse5` makes of NUL and `&#0;`), and the backslash. */
const URL_CONTROL = /[\u0000-\u001f\u007f�\\]/;
/** Attributes a before-image links through; their hosts count as already linked to. */
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'poster', 'data', 'action', 'formaction', 'cite', 'background', 'ping']);

type LinkTarget = { ok: true; domain: string } | { ok: false; reason: 'url_scheme' | 'url_control_char'; detail: string };

/** The domain a link points at: the host of an `http(s)` URL resolved against the store, or the
 *  address domain of a `mailto:` with exactly one address. */
function linkTarget(value: string, storeHost: string): LinkTarget {
  if (URL_CONTROL.test(value)) return { ok: false, reason: 'url_control_char', detail: value };
  let url: URL;
  try {
    url = new URL(value, `https://${storeHost}/`);
  } catch {
    return { ok: false, reason: 'url_scheme', detail: value };
  }
  if (!LINK_SCHEMES.has(url.protocol)) return { ok: false, reason: 'url_scheme', detail: value };
  if (url.protocol !== 'mailto:') return { ok: true, domain: url.hostname };
  // `?bcc=` or a second recipient would carry addresses the rule does not check.
  if (value.includes('?') || value.includes(',')) return { ok: false, reason: 'url_scheme', detail: value };
  let address: string;
  try {
    address = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, reason: 'url_scheme', detail: value };
  }
  const at = address.split('@');
  if (at.length !== 2 || at[1]!.length === 0) return { ok: false, reason: 'url_scheme', detail: value };
  return { ok: true, domain: at[1]!.toLowerCase() };
}

function linkedDomains(triples: Triple[], storeHost: string): Set<string> {
  const out = new Set<string>();
  for (const t of triples) {
    if (t.attribute === null || !URL_ATTRIBUTES.has(t.attribute)) continue;
    const target = linkTarget(t.value ?? '', storeHost);
    if (target.ok) out.add(target.domain);
  }
  return out;
}

/** A host matches a domain exactly, or as a subdomain at a dot boundary. */
function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  return d.length > 0 && (host === d || host.endsWith(`.${d}`));
}

function checkLink(value: string, input: MarkupCheckInput, linked: Set<string>): MarkupCheckResult {
  const target = linkTarget(value, input.storeHost);
  if (!target.ok) return refused(target.reason, target.detail);
  const allowed = [input.storeHost, ...input.startDomains, ...linked];
  if (allowed.some((d) => hostMatches(target.domain, d))) return { ok: true };
  return refused('new_link_domain', target.domain);
}

// --- Plain-text fields.

/** `<` that opens a tag, a closing tag, a comment or a processing instruction. */
const TAG_OPEN = /<[A-Za-z/!?]/g;

function countOf(text: string, re: RegExp | string): number {
  if (typeof re === 'string') return text.split(re).length - 1;
  return text.match(re)?.length ?? 0;
}

/**
 * Whether a verdict for a text field that is not HTML adds markup characters. A theme may put
 * the field into a page unescaped, so the value may hold no more `<`, no more `>` and no more
 * tag openings than the before-image of that field. `"` is not refused: inch marks are common in
 * product titles.
 */
export function plainTextMarkupOf(
  before: string | null, after: string,
): { ok: true } | { ok: false; reason: 'markup_in_text'; detail: string } {
  const prior = before ?? '';
  for (const probe of ['<', '>', TAG_OPEN] as const) {
    if (countOf(after, probe) > countOf(prior, probe)) {
      const what = probe === TAG_OPEN ? 'a tag opening' : `"${probe}"`;
      return { ok: false, reason: 'markup_in_text', detail: `The value holds ${what} its current text does not.` };
    }
  }
  return { ok: true };
}

// --- The list the approval view shows.

/** One element or comment the after-state adds or removes, with its full value. */
export interface MarkupItem {
  kind: 'element' | 'comment';
  namespace: MarkupNamespace | '';
  element: string;
  attributes: (readonly [name: string, value: string])[];
  text: string | null;
  inTemplate: boolean;
}

export interface FieldMarkupChange {
  field: string;
  added: MarkupItem[];
  removed: MarkupItem[];
}

/** Whether an occurrence is worth naming: a bare allowlisted element (a `p`, a `strong`)
 *  carries nothing a reader could miss; anything with an attribute, outside the allowlist, or a
 *  comment does. */
function named(o: Occurrence): boolean {
  return o.kind === 'comment' || !allowedElement(o) || o.attributes.length > 0;
}

function toItem(o: Occurrence): MarkupItem {
  return { kind: o.kind, namespace: o.namespace, element: o.name, attributes: o.attributes, text: o.text, inTemplate: o.inTemplate };
}

/** The elements and comments the after-state of one field adds and removes, over the tree of
 *  the bytes sent (sec-core M3: a rewrite to the allowlist must not delete an image unseen). */
export function markupChangesOf(field: string, before: string | null, after: string): FieldMarkupChange {
  const b = markupOf(parseHtmlFragment(before ?? '')).occurrences.filter(named);
  const a = markupOf(parseHtmlFragment(after)).occurrences.filter(named);
  return { field, added: multisetMinus(a, b).map(toItem), removed: multisetMinus(b, a).map(toItem) };
}

function multisetMinus(xs: Occurrence[], ys: Occurrence[]): Occurrence[] {
  const left = counts(ys.map(occurrenceKey));
  const out: Occurrence[] = [];
  for (const x of xs) {
    const k = occurrenceKey(x);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else out.push(x);
  }
  return out;
}
