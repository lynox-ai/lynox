// Shared artifact "Save as PDF" via the browser's own print pipeline. Produces
// a real PDF with selectable text and native fidelity (for an HTML contract,
// arbitrary client-side PDF libs can't render the source faithfully — the
// browser engine can). Used by both the inline artifact bubble
// (MarkdownRenderer) and the gallery (ArtifactsView) so the "Als PDF" action is
// identical on both surfaces.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { fixMarkdownPreprocessing } from './markdown-preprocess.js';

/**
 * Inject @page margins + a trusted auto-print script into an HTML document.
 * Handles BOTH a full document (`<html>…</html>`) and a bare fragment. Pure
 * string transform — DOM-free so it is unit-testable without a browser.
 *
 * The auto-print script is OURS (added after any sanitization), so it is safe
 * to inline here.
 */
export function injectPrintScaffold(html: string): string {
  // @page margins + print page-break hygiene so a multi-page document (e.g. an
  // A4 contract) doesn't split tables/figures/headings across pages or leave
  // orphan/widow lines — the prior "zeilenumbrüche schlecht" report.
  const style =
    '<style>@page{margin:1.5cm}@media print{' +
    'html,body{margin:0}' +
    'tr,img,pre,figure,blockquote{break-inside:avoid}' +
    'h1,h2,h3,h4,h5,h6{break-after:avoid;break-inside:avoid}' +
    'p,li{orphans:3;widows:3}' +
    '}</style>';
  // Split the closing-script-tag literal so bundlers/inline-HTML parsers don't
  // terminate the surrounding module/markup early.
  const script =
    '<scr' + 'ipt>window.addEventListener("load",function(){setTimeout(function(){window.print();},200);});' +
    'window.addEventListener("afterprint",function(){window.close();});</scr' + 'ipt>';
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : `${style}${html}`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${script}</body>`) : `${out}${script}`;
  return out;
}

/** Open a built print document in a new window. False if the popup was blocked. */
function openPrintWindow(doc: string): boolean {
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    URL.revokeObjectURL(url);
    return false;
  }
  // The popup owns its blob URL; revoke after a minute so we don't leak even if
  // the user dismisses the print dialog without closing the window.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/**
 * Print an HTML artifact. The HTML is agent-generated and we open it in a real
 * window (not the sandboxed bubble iframe), so strip scripts + event handlers
 * with DOMPurify first — WHOLE_DOCUMENT keeps `<html>/<head>/<body>` and
 * `<style>`, so a styled document (e.g. a contract) prints with full fidelity
 * while no artifact script ever executes. Returns false on a blocked popup.
 */
export function printHtmlDocument(rawHtml: string): boolean {
  const clean = DOMPurify.sanitize(rawHtml, { WHOLE_DOCUMENT: true }) as unknown as string;
  return openPrintWindow(injectPrintScaffold(clean));
}

/**
 * Print-friendly stylesheet for rendered markdown — INTENTIONALLY fixed
 * light-on-white regardless of UI theme ("Save as PDF" should produce a
 * printable document). Hex values here are exempt from the hex-guard.
 */
function buildMarkdownPrintDocument(title: string, renderedBody: string): string {
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
@page { margin: 2cm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
	font-size: 11pt; line-height: 1.55; color: #1a1a1a; background: #fff;
	max-width: 18cm; margin: 2rem auto; padding: 0 1rem;
}
h1, h2, h3, h4, h5, h6 { color: #000; line-height: 1.25; margin: 1.5em 0 0.5em; }
h1 { font-size: 1.9em; border-bottom: 2px solid #000; padding-bottom: 0.2em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.15em; }
p { margin: 0.7em 0; }
ul, ol { margin: 0.7em 0; padding-left: 1.6em; }
li { margin: 0.2em 0; }
a { color: #0057b0; text-decoration: underline; word-break: break-word; }
pre, code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
code { background: #f3f3f5; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.92em; }
pre { background: #f5f5f7; border: 1px solid #e6e6ea; border-radius: 4px; padding: 0.8em 1em; overflow-x: auto; white-space: pre-wrap; font-size: 0.85em; }
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.92em; }
th, td { border: 1px solid #d0d0d6; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { background: #f5f5f7; font-weight: 600; }
blockquote { border-left: 3px solid #c0c0c8; padding: 0.1em 1em; color: #555; margin: 1em 0; }
hr { border: none; border-top: 1px solid #d0d0d6; margin: 2em 0; }
img { max-width: 100%; height: auto; }
@media print {
	body { max-width: none; margin: 0; padding: 0; }
	a { color: #000; }
	pre, table, blockquote, img { break-inside: avoid; }
	h1, h2, h3 { break-after: avoid; }
}
</style>
</head>
<body>
<h1>${safeTitle}</h1>
${renderedBody}
</body>
</html>`;
}

/**
 * Print a markdown artifact: render → sanitize → wrap in the print stylesheet →
 * open. Returns false on a blocked popup.
 */
export function printMarkdownDocument(md: string, title: string): boolean {
  const rendered = DOMPurify.sanitize(marked.parse(fixMarkdownPreprocessing(md), { async: false }) as string);
  return openPrintWindow(injectPrintScaffold(buildMarkdownPrintDocument(title || 'Artifact', rendered)));
}
