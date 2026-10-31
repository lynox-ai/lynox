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
import { HIDDEN_ALLOWED_MAX, hiddenCharIndexes } from './hidden-chars.js';
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

/**
 * The tags of a value that its fragment does not keep: every stretch of the source no node of the
 * tree was built from, whitespace left out. The fragment parse drops a start tag that only has a
 * place at document level, with its attributes, while the page applies those attributes to its own
 * element of that name; it drops an end tag that closes nothing in the fragment, while in the page
 * it closes the theme's element around the value. Neither the tree, the canonical form nor
 * `endsClosed` sees them, so they are read off the source.
 *
 * A text node does not vouch for its whole range: the parser appends the characters after a dropped
 * tag to the text before it and moves the node's end over the tag. Outside an element whose content
 * the tokenizer reads as raw text, a `<` that opens a tag, an end tag or a declaration cannot be a
 * character of the text, so such a text node's source from the first one to its last `>` is reported
 * as one stretch. Not a match cut at the first `>`: a before-image then holds only the same tags with
 * what lies between them, never a prefix cut at a `>` inside a quoted value, nor a CDATA section of
 * foreign content, which is inert text. The text around them stays out, so editing it is no change.
 */
/** A start tag in a dropped stretch whose name is followed by an attribute. */
const DROPPED_WITH_ATTRIBUTES = /<[A-Za-z][^\s/>]*[\s/]+[^\s/>]/;

/** Elements whose content the tokenizer reads as text, scripting on: a `<` there is a character. */
const RAW_TEXT_PARENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

export function droppedTagsOf(value: string): string[] {
  const div = defaultTreeAdapter.createElement('div', p5.NS.HTML, []);
  const tree = parseFragment(div, value, { scriptingEnabled: true, sourceCodeLocationInfo: true });
  const kept = new Uint8Array(value.length);
  const keep = (at: { startOffset: number; endOffset: number } | null | undefined): void => {
    if (at) kept.fill(1, at.startOffset, at.endOffset);
  };
  const swallowed: string[] = [];
  const visit = (parent: { childNodes?: Node[] }, rawText: boolean): void => {
    for (const node of parent.childNodes ?? []) {
      if (isElement(node)) {
        keep(node.sourceCodeLocation?.startTag);
        keep(node.sourceCodeLocation?.endTag);
        const raw = node.namespaceURI === p5.NS.HTML && RAW_TEXT_PARENTS.has(node.tagName);
        if (node.tagName === 'template') visit(defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterTypes.Template), false);
        visit(node, raw);
      } else {
        const at = node.sourceCodeLocation;
        keep(at);
        if (at && node.nodeName === '#text' && !rawText) {
          const source = value.slice(at.startOffset, at.endOffset);
          const first = source.search(/<[A-Za-z/!?]/);
          const last = source.lastIndexOf('>');
          if (first >= 0) swallowed.push(source.slice(first, last > first ? last + 1 : source.length));
        }
      }
    }
  };
  visit(tree, false);
  const dropped: string[] = [...swallowed];
  let from = -1;
  for (let i = 0; i <= value.length; i++) {
    if (i < value.length && kept[i] === 0) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      const stretch = value.slice(from, i);
      if (stretch.trim() !== '') dropped.push(stretch);
      from = -1;
    }
  }
  return dropped;
}

// --- Which fields hold HTML. Only the form knows a field's content type; a key name is no
// evidence. A closed map from the list read, until forms declare it themselves.

const HTML_FIELDS: Readonly<Record<BulkListSourceForm, readonly string[]>> = Object.freeze({
  shopify: Object.freeze(['descriptionHtml']),
  // An image's `alt` is plain text.
  shopify_media: Object.freeze([]),
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

/** An element, or one of its attributes with its value. `attribute` null is the element itself.
 *  One held inside a `template`'s content is inert there, so it holds nothing outside. */
export interface Triple {
  namespace: MarkupNamespace;
  element: string;
  attribute: string | null;
  value: string | null;
  inTemplate: boolean;
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

/** Every node below `n` in document order, `template` contents included, each with whether it
 *  sits inside a `template`'s content. A loop, not recursion: a value nests as deep as its
 *  bytes allow, and the stack must not decide what a check answers. */
function* descendants(n: Node, inTemplate: boolean): Generator<[Node, boolean]> {
  const stack: [Node, boolean][] = [];
  const push = (p: Node, t: boolean): void => {
    const inner = t || (isElement(p) && p.tagName === 'template' && p.namespaceURI === p5.NS.HTML);
    const kids = childrenOf(p);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, inner]);
  };
  push(n, inTemplate);
  while (stack.length > 0) {
    const [c, t] = stack.pop()!;
    yield [c, t];
    push(c, t);
  }
}

function textBelow(n: Node): string {
  let out = '';
  for (const [c] of descendants(n, false)) if (c.nodeName === '#text') out += (c as DefaultTreeAdapterTypes.TextNode).value;
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
  // A text carrier's content is in its occurrence; below a foreign `script` or `style` there
  // may still be elements, and they count as their own.
  for (const [c, inTemplate] of descendants(fragment, false)) {
    if (c.nodeName === '#comment') {
      occurrences.push({ kind: 'comment', namespace: '', name: '', attributes: [], text: (c as DefaultTreeAdapterTypes.CommentNode).data, inTemplate });
      continue;
    }
    if (!isElement(c)) continue;
    const namespace = NAMESPACES[c.namespaceURI] ?? 'other';
    const attributes = attributesOf(c);
    const text = TEXT_CARRIERS.has(c.tagName) ? textBelow(c) : null;
    occurrences.push({ kind: 'element', namespace, name: c.tagName, attributes, text, inTemplate });
    triples.push({ namespace, element: c.tagName, attribute: null, value: null, inTemplate });
    for (const [attribute, value] of attributes) triples.push({ namespace, element: c.tagName, attribute, value, inTemplate });
  }
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
    if (!endsClosed(input.after)) {
      return refused('not_canonical', 'The value leaves a tag, a comment, raw text or an element open at its end.');
    }
    const before = input.before ?? '';
    // What the fragment drops, a multiset against the before-image's own, byte for byte. A stretch
    // with a start tag that carries attributes is never held: the same bytes are inert where the
    // before-image has them (a `template`, a `select`) and land on the page's own element where the
    // after-state puts them, and the place is not compared. Held is only what can move layout.
    const held = counts(droppedTagsOf(before));
    for (const tag of droppedTagsOf(input.after)) {
      const n = DROPPED_WITH_ATTRIBUTES.test(tag) ? 0 : held.get(tag) ?? 0;
      if (n === 0) return refused('not_canonical', `The value carries a tag the page reads but this check cannot place: ${tag}`);
      held.set(tag, n - 1);
    }
    // Each tree of the after-state against the before-image's tree of the same kind.
    const raw = checkTrees(parseHtmlFragment(before), parseHtmlFragment(input.after), input);
    if (!raw.ok) return raw;
    return checkTrees(parseHtmlFragment(canonicalHtml(before)), parseHtmlFragment(canonical), input);
  } catch {
    // parse5 does not throw on any string; this is the fixed reason should it ever.
    return refused('not_canonical', 'The value could not be read as HTML.');
  }
}

/**
 * Whether a field the host read back holds markup the run never sent (PRD shopify-preset §21.2
 * item 6): an occurrence or a triple outside the allowlist and outside the value sent, or a link
 * to a domain the rule does not take. Checked against the value SENT, not the before-image: an
 * undo's before-image may already hold the shop's markup, and against it that would pass unmarked.
 * Only the tree the host serialised is read, the one a shopper's browser parses, and its end must
 * be as closed as the value sent was (`endsClosed`). Formatting,
 * allowlisted additions and removals are not refused here; hidden characters are not either.
 * Like {@link checkMarkup}, it never throws: a value that cannot be read counts as added markup.
 */
export function markupAddedByHost(input: { sent: string; back: string; storeHost: string; startDomains: readonly string[] }): MarkupCheckResult {
  try {
    // A tag, comment or attribute value left open at the end falls away from the fragment's tree,
    // so no tree check sees it, nor what the host writes into it; the theme's next `>` closes it,
    // live. A value read back open counts as added unless it is the bytes sent: a before-image an
    // undo restores, or an unchanged field a verdict carries, may itself end open.
    if (!endsClosed(input.back) && input.back !== input.sent) {
      return refused('not_canonical', 'The value read back leaves a tag, a comment, raw text or an element open at its end.');
    }
    const got = checkTrees(parseHtmlFragment(input.sent), parseHtmlFragment(input.back), {
      before: input.sent, after: input.back, storeHost: input.storeHost, startDomains: input.startDomains,
    });
    return !got.ok && got.reason === 'hidden_char' ? { ok: true } : got;
  } catch {
    return refused('not_canonical', 'The value could not be read as HTML.');
  }
}

const END_MARK = 'lynox-end-of-value';

/** Elements a value may leave open at its end: the theme's next closing tag ends them, and they
 *  carry nothing onto what follows. A formatting element (`a`, `strong`) is not among them — the
 *  parser opens it again after the closing tag, around the theme's own markup. */
const OPEN_AT_END = new Set(['p', 'ul', 'ol', 'li', 'h2', 'h3', 'h4']);

/**
 * Whether a value ends so that the theme's markup after it stays the theme's. The page parses the
 * value and what follows it as one text; a fragment parse alone does not see what is left open:
 * - a tag, comment, attribute value or raw-text element open at the end is dropped from the
 *   fragment, while in the page the theme's next `>` closes it, live (`<img src=x onerror=… `);
 * - an element left open takes what follows inside it: a `template` hides the theme's footer, an
 *   `a` or `strong` is opened again around it, a `table` re-parents it, and a `form` — even one
 *   closed by another element's end tag — takes the theme's own form fields.
 * So a mark is appended and must come out as the last node of the tree, below allowed blocks
 * only; and a form appended must come out as a form, which it does not while one is still open.
 */
export function endsClosed(value: string): boolean {
  const count = (tree: HtmlFragment, name: string): number => {
    let n = 0;
    for (const [c] of descendants(tree, false)) if (isElement(c) && c.tagName === name && c.attrs.length === 0) n++;
    return n;
  };
  const tree = parseHtmlFragment(value);
  if (count(parseHtmlFragment(`${value}<form></form>`), 'form') !== count(tree, 'form') + 1) return false;
  // Whatever swallows the appended mark swallows the form before it, so the form's count also
  // stands for the mark's; the value's own bare mark at its end is caught there too.
  const marked = parseHtmlFragment(`${value}<${END_MARK}></${END_MARK}>`);
  let last: Node | null = null;
  for (const [c] of descendants(marked, false)) last = c;
  if (last === null || !isElement(last) || last.tagName !== END_MARK || last.attrs.length > 0) return false;
  for (let p = last.parentNode; p !== null && p !== marked; p = (p as Element).parentNode) {
    if (!isElement(p) || p.namespaceURI !== p5.NS.HTML || !OPEN_AT_END.has(p.tagName)) return false;
  }
  return true;
}

function occurrenceKey(o: Occurrence): string {
  return JSON.stringify([o.kind, o.namespace, o.name, o.attributes, o.text, o.inTemplate]);
}

function shellKey(o: Occurrence): string {
  return JSON.stringify([o.kind, o.namespace, o.name, o.attributes, o.inTemplate]);
}

function tripleKey(t: Triple): string {
  return JSON.stringify([t.namespace, t.element, t.attribute, t.value, t.inTemplate]);
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

  // Attributes with their values: held, or a link whose target passes. One that runs code,
  // styles or loads something counts as a multiset — a held `onclick` is not copied onto a
  // second element; any other (a `class` on every paragraph) only needs to be held at all.
  const heldTriples = counts(before.triples.filter((t) => t.attribute !== null).map(tripleKey));
  const linkDomains = linkedDomains(before.triples, input.storeHost);
  for (const t of after.triples) {
    if (t.attribute === null) continue;
    const k = tripleKey(t);
    const left = heldTriples.get(k) ?? 0;
    if (left > 0) {
      if (countedAttribute(t.attribute)) heldTriples.set(k, left - 1);
      continue;
    }
    if (!isLinkTriple(t)) return refused('attribute_not_allowed', `${t.element} ${t.attribute}="${t.value ?? ''}"`);
    const link = checkLink(t.value ?? '', input, linkDomains);
    if (!link.ok) return link;
  }

  // Hidden characters, per code point against the before-image: none more where real text does
  // not put one; where it does (an emoji's joiner, a soft hyphen) at most HIDDEN_ALLOWED_MAX more
  // across the whole field — the allowance holds per text, and a value can be cut into as many
  // texts as it likes.
  const b = hiddenCounts(beforeTree);
  const a = hiddenCounts(afterTree);
  let extra = 0;
  for (const [cp, n] of a.all) {
    const held = b.all.get(cp) ?? 0;
    const name = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    if ((a.out.get(cp) ?? 0) > held) return refused('hidden_char', name);
    extra += Math.max(0, n - held);
    if (extra > HIDDEN_ALLOWED_MAX) return refused('hidden_char', name);
  }
  return { ok: true };
}

/** Attributes counted per occurrence: they run code, style the page or load something — or, as
 *  `id` and `name`, name an element the page's scripts look up, so a copy would shadow it. */
function countedAttribute(name: string): boolean {
  return /^on/i.test(name) || name === 'style' || name === 'srcdoc' || name === 'srcset' || name === 'id' || name === 'name' || URL_ATTRIBUTES.has(name);
}

/** Every text a tree carries: text nodes, attribute values, comments. */
function textsOf(n: Node): string[] {
  const out: string[] = [];
  for (const [c] of descendants(n, false)) {
    if (c.nodeName === '#text') out.push((c as DefaultTreeAdapterTypes.TextNode).value);
    else if (c.nodeName === '#comment') out.push((c as DefaultTreeAdapterTypes.CommentNode).data);
    else if (isElement(c)) for (const a of c.attrs) out.push(a.value);
  }
  return out;
}

/** Per code point: every hidden character (`all`), and those outside the places real text puts
 *  one (`out`). */
function hiddenCounts(tree: HtmlFragment): { all: Map<number, number>; out: Map<number, number> } {
  const all = new Map<number, number>();
  const out = new Map<number, number>();
  const add = (m: Map<number, number>, cp: number): void => { m.set(cp, (m.get(cp) ?? 0) + 1); };
  for (const text of textsOf(tree)) {
    const chars = Array.from(text);
    for (const i of hiddenCharIndexes(text, { inPlace: false })) add(all, chars[i]!.codePointAt(0)!);
    for (const i of hiddenCharIndexes(text)) add(out, chars[i]!.codePointAt(0)!);
  }
  return { all, out };
}

// --- The domain rule.

const LINK_SCHEMES = new Set(['https:', 'http:', 'mailto:']);
/** C0 controls and DEL, U+FFFD (what `parse5` makes of NUL and `&#0;`), and the backslash. */
const URL_CONTROL = /[\u0000-\u001f\u007f\ufffd\\]/;
/** Attributes a before-image links through; their hosts count as already linked to. */
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'poster', 'data', 'action', 'formaction', 'cite', 'background', 'ping']);

/** A web link and a mail address are told apart: linking to a host is not writing to it. */
type LinkTarget = { ok: true; kind: 'web' | 'mail'; domain: string } | { ok: false; reason: 'url_scheme' | 'url_control_char'; detail: string };

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
  if (url.protocol !== 'mailto:') return { ok: true, kind: 'web', domain: url.hostname.replace(/\.$/, '') };
  // `?bcc=` or a second recipient would carry addresses the rule does not check; nor does a plain
  // address need a fragment.
  if (/[?,#]/.test(value)) return { ok: false, reason: 'url_scheme', detail: value };
  let address: string;
  try {
    // Decoded once, as a mail client reads it; a broken escape is no address.
    address = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, reason: 'url_scheme', detail: value };
  }
  // What was percent-encoded is checked as it decodes: a newline or a space would split the
  // address the domain rule reads from the one a mail client sends to.
  if (URL_CONTROL.test(address) || /\s/.test(address)) return { ok: false, reason: 'url_control_char', detail: value };
  const at = address.split('@');
  if (at.length !== 2) return { ok: false, reason: 'url_scheme', detail: value };
  // A plain address only: a quoted or escaped local part (`;`, `"`, a second `%`-escape) can make
  // a client read another recipient than the one checked here. The domain as ASCII, an
  // internationalised one in Punycode, as `new URL` gives a web link's host; a domain given
  // here in Unicode would match no allowed one in Punycode, so it is refused, never let through.
  if (!/^[A-Za-z0-9._+-]+$/.test(at[0]!) || !/^[A-Za-z0-9.-]+$/.test(at[1]!)) {
    return { ok: false, reason: 'url_scheme', detail: value };
  }
  return { ok: true, kind: 'mail', domain: at[1]!.toLowerCase().replace(/\.$/, '') };
}

function linkedDomains(triples: Triple[], storeHost: string): Set<string> {
  const out = new Set<string>();
  for (const t of triples) {
    if (t.attribute === null || !URL_ATTRIBUTES.has(t.attribute)) continue;
    const target = linkTarget(t.value ?? '', storeHost);
    if (target.ok) out.add(`${target.kind}:${target.domain}`);
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
  const same = [...linked].filter((l) => l.startsWith(`${target.kind}:`)).map((l) => l.slice(target.kind.length + 1));
  const allowed = [input.storeHost, ...input.startDomains, ...same];
  if (allowed.some((d) => hostMatches(target.domain, d))) return { ok: true };
  return refused('new_link_domain', target.domain);
}

// --- Plain-text fields.

/** A tag, a closing tag, a comment or a processing instruction as written: from its `<` to its
 *  `>`, or to the next `<` or the end where it has none. A quoted value is read whole, as the
 *  browser reads it: a `>` inside quotes does not end the tag. */
const TAG = /<[A-Za-z/!?](?:"[^"]*"?|'[^']*'?|[^<>"'])*>?/g;

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * Whether a verdict for a text field that is not HTML adds markup characters. A theme may put
 * the field into a page unescaped, so the value may hold no more `<` and no more `>` than the
 * before-image of that field, and no tag the before-image does not hold as written. `"` is not
 * refused: inch marks are common in product titles.
 */
export function plainTextMarkupOf(
  before: string | null, after: string,
): { ok: true } | { ok: false; reason: 'markup_in_text'; detail: string } {
  const prior = before ?? '';
  for (const probe of ['<', '>'] as const) {
    if (countOf(after, probe) > countOf(prior, probe)) {
      return { ok: false, reason: 'markup_in_text', detail: `The value holds "${probe}" its current text does not.` };
    }
  }
  // Each tag as written, as a multiset: a held `<b>` does not make room for an `<img …>`.
  const held = counts(prior.match(TAG) ?? []);
  for (const tag of after.match(TAG) ?? []) {
    const left = held.get(tag) ?? 0;
    if (left === 0) return { ok: false, reason: 'markup_in_text', detail: 'The value holds a tag its current text does not.' };
    held.set(tag, left - 1);
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

/** Whether an occurrence is worth naming. Left out is only a bare allowlisted element — on
 *  the allowlist, without attributes, carrying no raw text, and not inside a `template`'s
 *  content (sec-core, 2026-10-27): a `p` or a `strong` carries nothing a reader could miss, and
 *  listing every one would bury what does. Everything else is named, comments included. */
function named(o: Occurrence): boolean {
  const bare = o.kind === 'element' && allowedElement(o) && o.attributes.length === 0 && o.text === null && !o.inTemplate;
  return !bare;
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
