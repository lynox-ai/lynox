import { defaultTreeAdapter, html, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';

/**
 * The one place an HTML field value is parsed (a Shopify product description, a WooCommerce
 * description), and the two forms derived from that tree: the canonical bytes stored and sent
 * (`canonicalHtml`) and the normalised form two values are compared by (`normalizeHtml`).
 *
 * The parser is `parse5` (exactly 8.0.1, a runtime dependency): the HTML5 tree construction,
 * not a tokenizer and not a tree builder of our own. A tokenizer cannot see what the tree
 * construction does to markup (the adoption agency, foster parenting, `<image>` as `img`,
 * `noscript` as raw text with scripting on, the SVG and MathML names), and a tree builder of our
 * own would be exactly the mutation-XSS surface a markup check must not have. Every value is
 * parsed as a fragment in a `div` context with scripting on, as a theme that drops the
 * description into a `div` would. The tree is `parse5`'s own objects, not a DOM: nothing in it
 * runs.
 *
 * Inputs are strings only. A field value that is not a string, `null` included, the caller
 * compares byte for byte.
 */

/** `parse5`'s fragment type, as `parseHtmlFragment` returns it. */
export type HtmlFragment = DefaultTreeAdapterTypes.DocumentFragment;
type HtmlParent = DefaultTreeAdapterTypes.ParentNode;
type HtmlChild = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;

const HTML_NS = html.NS.HTML;
// A fresh context element per parse: `parse5` reads it, a shared one would be a shared object.
const divContext = (): HtmlElement => defaultTreeAdapter.createElement('div', HTML_NS, []);

export function parseHtmlFragment(value: string): HtmlFragment {
  return parseFragment(divContext(), value, { scriptingEnabled: true });
}

/**
 * `parse5`'s serialisation of the tree of `value`, with nothing normalised. It is meant as the form
 * an HTML field's after-state is stored and sent in, so that the bytes sent are the bytes a check
 * read; the bulk run wires that up. Serialisation does not round-trip in general:
 * `canonicalHtml(canonicalHtml(v))` can differ from `canonicalHtml(v)` (foreign content,
 * raw-text parents, form re-nesting), and a markup check has to refuse such a value.
 */
export function canonicalHtml(value: string): string {
  return serialize(parseHtmlFragment(value));
}

/**
 * The size and shape a value may have for a check to read it. A text carrier's occurrence holds
 * the text and layout of everything below it, so each carrier above a node reads that node again;
 * the parser may build many nodes from few bytes; and the element depth bounds the recursive
 * walks and the serialiser. Far above product descriptions as shops write them. A value beyond
 * them is refused or left unread, never cut.
 */
export const MARKUP_MAX_BYTES = 1024 * 1024;
export const MARKUP_MAX_DEPTH = 512;
export const MARKUP_MAX_CARRIER_NESTING = 8;
export const MARKUP_MAX_NODES = 50_000;
/** Tags and attributes before the parse: the parser's own work on some inputs grows faster than the
 *  nodes it builds, so these are read off the bytes, in one pass, before it runs. */
export const MARKUP_MAX_TAGS = 5_000;
export const MARKUP_MAX_ATTRIBUTES_PER_TAG = 128;

/** The bounds a test may set smaller, to reach them quickly. */
export interface ReadingBounds {
  readonly depth: number;
  readonly nodes: number;
  readonly tags: number;
  readonly attributesPerTag: number;
}
const READING_BOUNDS: ReadingBounds = { depth: MARKUP_MAX_DEPTH, nodes: MARKUP_MAX_NODES, tags: MARKUP_MAX_TAGS, attributesPerTag: MARKUP_MAX_ATTRIBUTES_PER_TAG };

/** The elements whose text a markup extraction reads again for each one above it, by name in
 *  every namespace: wider than `carriesContent`, which only errs toward refusing. */
export const READ_AGAIN_CARRIERS: ReadonlySet<string> = new Set([
  'script', 'style', 'noscript', 'xmp', 'noembed', 'noframes', 'iframe', 'plaintext', 'textarea', 'title',
]);

class BoundExceeded extends Error {}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/**
 * Whether a value holds at most `bounds.tags` tags and no tag with more than
 * `bounds.attributesPerTag` attributes, read in one pass. It counts more than the parser reads,
 * never less: every `<` that may open a tag, a comment or a declaration counts, inside raw text
 * too, and a tag's attributes are read the way the tokenizer reads them, a quoted value skipped
 * whole.
 */
function tokensWithin(value: string, bounds: ReadingBounds): boolean {
  let tags = 0;
  let i = 0;
  while (i < value.length) {
    const lt = value.indexOf('<', i);
    if (lt < 0) return true;
    const next = value[lt + 1] ?? '';
    i = lt + 1;
    if (!(isLetter(next) || next === '/' || next === '!' || next === '?')) continue;
    tags += 1;
    if (tags > bounds.tags) return false;
    if (next === '!' || next === '?') continue;
    // The tag's name, then its attributes up to the `>` that ends it.
    i = lt + 2;
    while (i < value.length && !isSpace(value[i]!) && value[i] !== '/' && value[i] !== '>') i += 1;
    let attributes = 0;
    for (;;) {
      while (i < value.length && (isSpace(value[i]!) || value[i] === '/')) i += 1;
      if (i >= value.length || value[i] === '>') break;
      attributes += 1;
      if (attributes > bounds.attributesPerTag) return false;
      i += 1;
      while (i < value.length && !isSpace(value[i]!) && value[i] !== '/' && value[i] !== '>' && value[i] !== '=') i += 1;
      while (i < value.length && isSpace(value[i]!)) i += 1;
      if (value[i] !== '=') continue;
      i += 1;
      while (i < value.length && isSpace(value[i]!)) i += 1;
      const quote = value[i];
      if (quote === '"' || quote === "'") {
        const close = value.indexOf(quote, i + 1);
        i = close < 0 ? value.length : close + 1;
      } else {
        while (i < value.length && !isSpace(value[i]!) && value[i] !== '>') i += 1;
      }
    }
    i += 1;
  }
  return true;
}

/** A parse that stops once it has built more than `bounds.nodes` nodes, put a node deeper than
 *  `bounds.depth`, or given one element more than `bounds.attributesPerTag`
 *  attributes. Text appended to the text node before it builds none, so it does not count. */
function parseCounted(value: string, bounds: ReadingBounds): HtmlFragment {
  let built = 0;
  const count = (): void => {
    built += 1;
    if (built > bounds.nodes) throw new BoundExceeded();
  };
  const depths = new WeakMap<object, number>();
  const placed = (parent: object, child: object): void => {
    const depth = (depths.get(parent) ?? 0) + 1;
    // The parser places a fragment's nodes under a root element of its own, one level more.
    if (depth > bounds.depth + 1) throw new BoundExceeded();
    depths.set(child, depth);
  };
  const appendsToText = (parent: DefaultTreeAdapterTypes.ParentNode): boolean =>
    defaultTreeAdapter.getChildNodes(parent).at(-1)?.nodeName === '#text';
  const treeAdapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    createElement: (...a) => { count(); return defaultTreeAdapter.createElement(...a); },
    createCommentNode: (...a) => { count(); return defaultTreeAdapter.createCommentNode(...a); },
    insertText: (parent, text) => { if (!appendsToText(parent)) count(); defaultTreeAdapter.insertText(parent, text); },
    insertTextBefore: (...a) => { count(); defaultTreeAdapter.insertTextBefore(...a); },
    appendChild: (parent, child) => { placed(parent, child); defaultTreeAdapter.appendChild(parent, child); },
    insertBefore: (parent, child, ref) => { placed(parent, child); defaultTreeAdapter.insertBefore(parent, child, ref); },
    setTemplateContent: (template, content) => { depths.set(content, depths.get(template) ?? 0); defaultTreeAdapter.setTemplateContent(template, content); },
    adoptAttributes: (recipient, attrs) => {
      if (recipient.attrs.length + attrs.length > bounds.attributesPerTag) throw new BoundExceeded();
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
  };
  return parseFragment(divContext(), value, { scriptingEnabled: true, treeAdapter });
}

/** Whether a value stays within the bounds above: one pass over its bytes, one counted parse and
 *  one pass over its tree. Ask it before any other parse or walk of a value a shop, a plan or a
 *  model wrote. A test may set smaller bounds to reach them quickly. */
export function withinReadingBounds(value: string, bounds: Partial<ReadingBounds> = {}): boolean {
  const limits: ReadingBounds = { ...READING_BOUNDS, ...bounds };
  if (Buffer.byteLength(value, 'utf8') > MARKUP_MAX_BYTES) return false;
  if (!tokensWithin(value, limits)) return false;
  let fragment: HtmlFragment;
  try {
    fragment = parseCounted(value, limits);
  } catch (err: unknown) {
    if (err instanceof BoundExceeded) return false;
    throw err;
  }
  const stack: [HtmlParent | HtmlChild, number, number][] = [[fragment, 0, 0]];
  while (stack.length > 0) {
    const [n, depth, above] = stack.pop()!;
    const carriers = above + ('tagName' in n && READ_AGAIN_CARRIERS.has(n.tagName) ? 1 : 0);
    if (depth > limits.depth || carriers > MARKUP_MAX_CARRIER_NESTING) return false;
    if ('childNodes' in n) for (const c of childrenOf(n).nodes) stack.push([c, depth + 1, carriers]);
  }
  return true;
}

/**
 * Elements whose text the reference walk carries as `content`, because a change to it is a change
 * to what runs or what is read raw: `script` and `style` in every namespace (an SVG `script` runs),
 * and the HTML raw-text and RCDATA elements. A markup extraction keeps its own list and is tested
 * against the walk: shared, a wrong entry would be wrong in both and no comparison could see it.
 */
export const CONTENT_CARRYING_ELEMENTS: ReadonlySet<string> = new Set(['noscript', 'xmp', 'noembed', 'noframes', 'iframe', 'plaintext', 'textarea', 'title']);
const CONTENT_CARRYING_ANY_NAMESPACE: ReadonlySet<string> = new Set(['script', 'style']);

export function carriesContent(namespace: string, name: string): boolean {
  return CONTENT_CARRYING_ANY_NAMESPACE.has(name) || (namespace === HTML_NS && CONTENT_CARRYING_ELEMENTS.has(name));
}

/** An attribute as the tree holds it: the value decoded, the namespace and prefix of a foreign attribute kept. */
export interface HtmlAttr {
  readonly namespace: string | null;
  readonly prefix: string | null;
  readonly name: string;
  readonly value: string;
}

/** One node of the reference walk, in document order. */
export type HtmlNodeRef =
  | {
    readonly kind: 'element';
    readonly namespace: string;
    readonly name: string;
    readonly attrs: readonly HtmlAttr[];
    /** The direct text of a content-carrying element (`carriesContent`), else null. */
    readonly content: string | null;
    /** Inside the content of a `template`, at any depth. */
    readonly inTemplate: boolean;
    readonly depth: number;
  }
  | { readonly kind: 'comment'; readonly data: string; readonly inTemplate: boolean; readonly depth: number }
  | { readonly kind: 'text'; readonly value: string; readonly inTemplate: boolean; readonly depth: number };

function isElement(node: HtmlChild): node is HtmlElement {
  return defaultTreeAdapter.isElementNode(node);
}

/** A node's children as the tree adapter gives them; for a `template`, its content's children. */
function childrenOf(node: HtmlParent): { nodes: readonly HtmlChild[]; template: boolean } {
  if ('tagName' in node && node.tagName === 'template' && node.namespaceURI === HTML_NS) {
    return { nodes: defaultTreeAdapter.getChildNodes(defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterTypes.Template)), template: true };
  }
  return { nodes: defaultTreeAdapter.getChildNodes(node), template: false };
}

function attrsOf(el: HtmlElement): HtmlAttr[] {
  return defaultTreeAdapter.getAttrList(el).map((a) => ({ namespace: a.namespace ?? null, prefix: a.prefix ?? null, name: a.name, value: a.value }));
}

function directText(el: HtmlElement): string {
  let out = '';
  for (const c of defaultTreeAdapter.getChildNodes(el)) if (defaultTreeAdapter.isTextNode(c)) out += c.value;
  return out;
}

/**
 * The reference walk: every element, text and comment of the tree in document order, `template`
 * contents included and marked, over the tree adapter's accessors only (`getChildNodes`,
 * `getTemplateContent`). It holds two rules, each pinned by a test: which elements carry
 * `content` (`carriesContent`), and that only an HTML `template` has template content. A markup extraction is tested against it (the fuzz's property 1) and must
 * use neither the walk nor that list.
 */
export function walkHtml(fragment: HtmlFragment): HtmlNodeRef[] {
  const out: HtmlNodeRef[] = [];
  const visit = (parent: HtmlParent, inTemplate: boolean, depth: number): void => {
    const { nodes, template } = childrenOf(parent);
    const inside = inTemplate || template;
    for (const node of nodes) {
      if (isElement(node)) {
        const namespace = node.namespaceURI as string;
        out.push({
          kind: 'element', namespace, name: node.tagName, attrs: attrsOf(node),
          content: carriesContent(namespace, node.tagName) ? directText(node) : null,
          inTemplate: inside, depth,
        });
        visit(node, inside, depth + 1);
      } else if (defaultTreeAdapter.isTextNode(node)) {
        out.push({ kind: 'text', value: node.value, inTemplate: inside, depth });
      } else if (defaultTreeAdapter.isCommentNode(node)) {
        out.push({ kind: 'comment', data: node.data, inTemplate: inside, depth });
      }
    }
  };
  visit(fragment, false, 0);
  return out;
}

// ── normalizeHtml ─────────────────────────────────────────────────────────────

/** HTML elements that bound a whitespace-only text node, so it can be dropped (M6's list re-layout). */
export const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'ul',
]);

/**
 * Elements below which every whitespace character counts: none is collapsed, none is dropped.
 * `pre`, `textarea`, `listing` and `plaintext` show whitespace as it is, and the content-carrying
 * elements (`carriesContent`) are read raw.
 */
const WHITESPACE_KEEPING: ReadonlySet<string> = new Set(['pre', 'textarea', 'listing', 'plaintext']);
const keepsWhitespace = (el: HtmlElement): boolean =>
  (el.namespaceURI === HTML_NS && WHITESPACE_KEEPING.has(el.tagName)) || carriesContent(el.namespaceURI as string, el.tagName);

/** ASCII whitespace as HTML defines it: space, tab, LF, FF, CR. Never U+00A0. */
const ASCII_WS_RUN = /[\t\n\f\r ]+/g;
const ASCII_WS_ONLY = /^[\t\n\f\r ]+$/;

const isBlock = (node: HtmlChild | undefined): boolean =>
  node !== undefined && isElement(node) && node.namespaceURI === HTML_NS && BLOCK_ELEMENTS.has(node.tagName);

// The normalised tree, as arrays so that JSON.stringify gives one string per tree:
// element ['E', namespace, name, attrs sorted, children], text ['T', value], comment ['C', data].
type NormNode = readonly ['E', string, string, readonly (readonly [string, string, string, string])[], readonly NormNode[]] | readonly ['T', string] | readonly ['C', string];

function normChildren(parent: HtmlParent, keepWs: boolean, parentIsBlock: boolean): NormNode[] {
  const { nodes } = childrenOf(parent);
  const out: NormNode[] = [];
  nodes.forEach((node, i) => {
    if (isElement(node)) {
      const attrs = attrsOf(node)
        .map((a) => [a.namespace ?? '', a.prefix ?? '', a.name, a.value] as const)
        .sort((x, y) => (x[0] + '\u0000' + x[1] + '\u0000' + x[2] < y[0] + '\u0000' + y[1] + '\u0000' + y[2] ? -1 : 1));
      out.push(['E', node.namespaceURI as string, node.tagName, attrs, normChildren(node, keepWs || keepsWhitespace(node), isBlock(node))]);
    } else if (defaultTreeAdapter.isTextNode(node)) {
      if (keepWs) { out.push(['T', node.value]); return; }
      if (ASCII_WS_ONLY.test(node.value)) {
        // Dropped only between two block boundaries: a block element, or the start or end of a
        // block parent (or of the fragment). Between inline elements it stays one space.
        const before = i === 0 ? parentIsBlock : isBlock(nodes[i - 1]);
        const after = i === nodes.length - 1 ? parentIsBlock : isBlock(nodes[i + 1]);
        if (before && after) return;
      }
      out.push(['T', node.value.replace(ASCII_WS_RUN, ' ')]);
    } else if (defaultTreeAdapter.isCommentNode(node)) {
      out.push(['C', node.data]);
    }
  });
  return out;
}

/**
 * The normalised form of an HTML field value: two values are the same when these strings are
 * equal (`htmlEqual`). It is an encoding of the normalised `parse5` tree, not HTML, and it is
 * never stored as the field's value, shown or sent; it is only compared (or hashed). HTML would
 * not do: two different trees can serialise to the same markup.
 *
 * Normalised (Shopify PRD §21.2 item 5):
 * - element names as the tree holds them, with their namespace;
 * - attributes as a set of (namespace, prefix, name, decoded value): order and spacing do not count;
 * - text with its entities decoded (the tree holds it so);
 * - runs of ASCII whitespace collapsed to one space, never U+00A0, and never below `pre`,
 *   `textarea`, `listing`, `plaintext` or a raw-text or RCDATA element;
 * - whitespace-only text dropped only between two block boundaries (a block element, or the
 *   start or end of a block parent or of the fragment), never between inline elements, so
 *   `<b>a</b> <i>b</i>` stays apart from `<b>a</b><i>b</i>`;
 * - comments are tokens, compared by their text;
 * - `template` contents are part of the tree.
 *
 * It errs strict: a looser form would hide a change someone else made, and a run would write over
 * it; a stricter one reports a conflict, which is the safe direction.
 */
export function normalizeHtml(value: string): string {
  return JSON.stringify(normChildren(parseHtmlFragment(value), false, true));
}

export function htmlEqual(a: string, b: string): boolean {
  return normalizeHtml(a) === normalizeHtml(b);
}
