<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { codeToHtml } from 'shiki';
	import { saveArtifact } from '../stores/artifacts.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface Props {
		content: string;
		/** When true, defer artifact iframe rendering (show code instead). */
		streaming?: boolean;
	}

	let { content, streaming = false }: Props = $props();

	let highlightedHtml = $state('');

	// Close unclosed code fences to prevent the entire response rendering as raw code.
	// Only count valid fences: opening (```lang) and closing (``` alone on line).
	// "```Pipeline erfolgreich" is NOT a valid closing fence.
	function closeOpenFences(md: string): string {
		const validFence = /^```\w*\s*$/gm;
		const fenceCount = (md.match(validFence) ?? []).length;
		return fenceCount % 2 !== 0 ? md + '\n```' : md;
	}

	// Fix missing line breaks between concatenated sentences (from streamed tool-call gaps).
	// Pattern: period/exclamation/question followed directly by uppercase letter without space.
	// Only applied outside code blocks to avoid breaking code content.
	// The negative lookbehind skips abbreviations whose "word" before the period is ≤2 letters —
	// catches z.B., Z.B., d.h., u.a., i.e., e.g., U.S., Dr.Smith, etc. A real sentence boundary
	// almost always has a ≥3-letter word before the period.
	function fixSentenceSpacing(md: string): string {
		const parts = md.split(/(```[\s\S]*?```)/g);
		return parts.map((part, i) => {
			if (i % 2 !== 0) return part; // inside code block — skip
			// Apply per-line, skip table rows (contain pipe) to avoid breaking tables
			return part.split('\n').map(line =>
				line.includes('|') ? line : line.replace(/(?<!\b[a-zäöüA-ZÄÖÜ]{1,2})([.!?])([A-ZÄÖÜ])/g, '$1\n\n$2')
			).join('\n');
		}).join('');
	}

	// Wrap <table> elements in a scrollable container for wide tables.
	function wrapTables(html: string): string {
		return html.replace(/<table\b[^>]*>/g, '<div class="table-wrap">$&').replace(/<\/table>/g, '</table></div>');
	}

	const baseHtml = $derived(
		wrapTables(DOMPurify.sanitize(marked.parse(closeOpenFences(fixSentenceSpacing(content)), { async: false }) as string))
	);

	function decodeEntities(str: string): string {
		return str
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.replace(/&#39;/g, "'")
			.replace(/&quot;/g, '"');
	}

	// ── Mermaid ──────────────────────────────────────────────

	let mermaidReady = false;

	async function renderMermaid(code: string): Promise<string> {
		const { default: mermaid } = await import('mermaid');
		if (!mermaidReady) {
			mermaid.initialize({
				startOnLoad: false,
				theme: 'dark',
				themeVariables: {
					primaryColor: '#6525EF',
					primaryTextColor: '#e8e8f0',
					primaryBorderColor: '#3d3d5c',
					lineColor: '#8888aa',
					secondaryColor: '#1a1a3e',
					tertiaryColor: '#0c0c20',
					background: '#0c0c20',
					mainBkg: '#1a1a3e',
					nodeBorder: '#6525EF',
					clusterBkg: '#0c0c20',
					titleColor: '#e8e8f0',
					edgeLabelBackground: '#0c0c20'
				}
			});
			mermaidReady = true;
		}
		const id = `mermaid-${crypto.randomUUID().slice(0, 8)}`;
		const { svg } = await mermaid.render(id, code);
		const encoded = btoa(unescape(encodeURIComponent(code)));
		const btns = `<div class="diagram-actions">
			<button class="diagram-btn mermaid-save" data-content="${encoded}" title="Save" type="button">${ICON_SAVE}</button>
			<button class="diagram-btn mermaid-export" title="Export PNG" type="button">${ICON_DOWNLOAD}</button>
		</div>`;
		return `<div class="mermaid-diagram">${btns}${svg}</div>`;
	}

	// ── Artifacts ────────────────────────────────────────────

	function escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	function extractTitle(code: string): { title: string; clean: string } {
		const match = code.match(/<!--\s*title:\s*(.+?)\s*-->/);
		if (match) return { title: match[1]!, clean: code.replace(match[0], '').trim() };
		const titleTag = code.match(/<title>(.+?)<\/title>/);
		if (titleTag) return { title: titleTag[1]!, clean: code };
		return { title: '', clean: code };
	}

	const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src 'none'">`;

	/** Detect whether an artifact fence body is explicitly typed as markdown. */
	function isMarkdownArtifact(code: string): boolean {
		return /<!--\s*type:\s*markdown\s*-->/i.test(code);
	}

	/** Build a markdown-typed artifact: same chrome as the iframe variant
	 *  (container + toolbar + label) but body is rendered markdown, not an
	 *  iframe. Expanded by default because markdown carries no script risk
	 *  and hiding prose behind a "Click to open" toggle hurts readability.
	 *  The raw markdown source is embedded as `data-md` so the toolbar
	 *  buttons can produce a .md download and a print-to-PDF popup from the
	 *  original text (not the rendered HTML). */
	function buildMarkdownArtifact(code: string): string {
		const { title, clean } = extractTitle(code);
		const body = clean.replace(/<!--\s*type:\s*markdown\s*-->\s*/i, '').trim();
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);
		const rendered = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
		const encodedMd = btoa(unescape(encodeURIComponent(body)));
		return `<div class="artifact-container artifact-md" data-md="${encodedMd}" data-title="${safeTitle}">
			<div class="artifact-toolbar">
				<span class="artifact-label">Markdown</span>
				<span class="artifact-md-title">${safeTitle}</span>
				<button class="artifact-btn" data-action="download-md" title="Als .md herunterladen">${ICON_DOWNLOAD}</button>
				<button class="artifact-btn" data-action="print-pdf" title="Als PDF drucken">${ICON_PRINT}</button>
			</div>
			<div class="artifact-md-body prose prose-invert max-w-none">${rendered}</div>
		</div>`;
	}

	function buildArtifact(code: string): string {
		if (isMarkdownArtifact(code)) return buildMarkdownArtifact(code);
		const { title, clean } = extractTitle(code);
		const defaultStyles = `<style>body{background:#0a0a1a;color:#e8e8f0;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1rem}*{box-sizing:border-box}</style>`;
		const overflowFix = `<style>html,body{overflow-x:hidden!important;max-width:100vw;scrollbar-width:none;-ms-overflow-style:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}</style>`;
		let fullHtml: string;
		if (clean.includes('<html')) {
			fullHtml = clean.replace(/<head[^>]*>/, `$&${CSP_META}${overflowFix}`);
			fullHtml = fullHtml.includes('</body>') ? fullHtml.replace('</body>', `${RESIZE_SCRIPT}</body>`) : fullHtml + RESIZE_SCRIPT;
		} else {
			fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${CSP_META}${defaultStyles}${overflowFix}</head><body>${clean}${RESIZE_SCRIPT}</body></html>`;
		}
		const encoded = btoa(unescape(encodeURIComponent(fullHtml)));
		const escaped = fullHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);

		return `<div class="artifact-container artifact-collapsed" data-html="${encoded}" data-title="${safeTitle}">
			<div class="artifact-toolbar" data-action="toggle" style="cursor:pointer">
				<span class="artifact-label">${safeTitle}</span>
				<span class="artifact-toggle-hint">Click to open</span>
				<button class="artifact-btn" data-action="screenshot" title="Copy as image">${ICON_CLIPBOARD}</button>
				<button class="artifact-btn" data-action="export" title="Download image">${ICON_DOWNLOAD}</button>
				<button class="artifact-btn" data-action="expand" title="Fullscreen">${ICON_EXPAND}</button>
				<button class="artifact-btn artifact-close-btn" data-action="close" title="Close">${ICON_CLOSE}</button>
				<button class="artifact-btn" data-action="pin" title="Pin to Artifacts">${ICON_SAVE}</button>
			</div>
			<iframe class="artifact-frame" srcdoc="${escaped}" sandbox="allow-scripts" scrolling="no" loading="lazy"></iframe>
			<div class="artifact-source-wrap hidden"></div>
		</div>`;
	}

	// ── Icons ────────────────────────────────────────────────

	const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 10.5L4 6.5h3V2h2v4.5h3L8 10.5zM3 12.5h10v1H3v-1z" fill="currentColor"/></svg>`;
	const ICON_CODE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_EXPAND = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_SAVE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h8l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/><path d="M5 2v4h5V2M5 14v-4h6v4" stroke="currentColor" stroke-width="1.2"/></svg>`;
	const ICON_CLIPBOARD = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.5 3A1.5 1.5 0 017 1.5h2A1.5 1.5 0 0110.5 3M5.5 3H4a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1V4a1 1 0 00-1-1h-1.5M5.5 3h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
	const ICON_PRINT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 2.5h7v3.5M4.5 11.5H3A1.5 1.5 0 011.5 10V7A1.5 1.5 0 013 5.5h10A1.5 1.5 0 0114.5 7v3a1.5 1.5 0 01-1.5 1.5h-1.5M4.5 9.5h7V14h-7V9.5z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

	/** Injected into artifact iframes — posts height via postMessage for cross-origin resize */
	const RESIZE_SCRIPT = '<script>(function(){function s(){parent.postMessage({type:"lynox-resize",h:document.documentElement.scrollHeight},"*")}window.addEventListener("message",function(e){if(e.data==="lynox-measure")s()});window.addEventListener("load",function(){s();setTimeout(s,300);setTimeout(s,1500)});if(typeof ResizeObserver!=="undefined")new ResizeObserver(s).observe(document.documentElement);s()})()</' + 'script>';

	// ── Event delegation ─────────────────────────────────────

	function handleContainerClick(e: MouseEvent) {
		const target = e.target as HTMLElement;

		// Mermaid PNG export
		const mermaidBtn = target.closest('.mermaid-export');
		if (mermaidBtn) {
			exportMermaidPng(mermaidBtn);
			return;
		}

		// Mermaid save
		const mermaidSaveBtn = target.closest('.mermaid-save') as HTMLElement | null;
		if (mermaidSaveBtn) {
			const encoded = mermaidSaveBtn.dataset['content'] ?? '';
			const mermaidCode = decodeURIComponent(escape(atob(encoded)));
			const title = prompt('Titel für dieses Diagramm:', 'Diagramm') ?? 'Diagramm';
			saveArtifact({ title, content: mermaidCode, type: 'mermaid' }).then(result => {
				if (result) addToast(t('artifacts.saved'), 'success');
			});
			return;
		}

		// Artifact toolbar toggle (collapsed → expanded with auto-height)
		const toggleTarget = target.closest('[data-action="toggle"]') as HTMLElement | null;
		if (toggleTarget && !target.closest('.artifact-btn')) {
			const container = toggleTarget.closest('.artifact-container') as HTMLElement;
			if (container) {
				container.classList.toggle('artifact-collapsed');
				if (!container.classList.contains('artifact-collapsed')) {
					// Delay so browser lays out the iframe before measuring
					requestAnimationFrame(() => resizeArtifactFrame(container));
				}
			}
			return;
		}

		// Artifact toolbar actions
		const artifactBtn = target.closest('.artifact-btn') as HTMLElement | null;
		if (artifactBtn) {
			const action = artifactBtn.dataset['action'];
			const container = artifactBtn.closest('.artifact-container') as HTMLElement;
			if (!container) return;
			// Auto-expand if collapsed
			if (container.classList.contains('artifact-collapsed')) {
				container.classList.remove('artifact-collapsed');
				requestAnimationFrame(() => resizeArtifactFrame(container));
			}

			if (action === 'pin') handleArtifactSave(container);
			else if (action === 'screenshot') handleArtifactScreenshot(container);
			else if (action === 'source') handleArtifactSource(container);
			else if (action === 'expand') handleArtifactExpand(container);
			else if (action === 'close') handleArtifactExpand(container);
			else if (action === 'export') handleArtifactExport(container);
			else if (action === 'download-md') handleMarkdownDownload(container);
			else if (action === 'print-pdf') handleMarkdownPrint(container);
		}
	}

	function decodeDataMd(container: HTMLElement): string {
		const encoded = container.dataset['md'] ?? '';
		if (!encoded) return '';
		try { return decodeURIComponent(escape(atob(encoded))); }
		catch { return ''; }
	}

	function handleMarkdownDownload(container: HTMLElement) {
		const md = decodeDataMd(container);
		if (!md) { addToast('Download fehlgeschlagen', 'error'); return; }
		const title = container.dataset['title'] ?? 'artifact';
		const filename = `${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')}.md`;
		const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = filename || 'artifact.md';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	/** Open the rendered markdown in a fresh popup with a print-friendly
	 *  stylesheet, then auto-trigger the browser's print dialog. User picks
	 *  "Save as PDF" (Desktop) or "Save to Files" (iOS Safari share sheet).
	 *  Pure-browser flow — no dependency, PDF output has selectable text,
	 *  tables render natively. */
	function handleMarkdownPrint(container: HTMLElement) {
		const md = decodeDataMd(container);
		if (!md) { addToast('PDF-Export fehlgeschlagen', 'error'); return; }
		const title = container.dataset['title'] ?? 'Artifact';
		const rendered = DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
		const html = buildPrintDocument(title, rendered);
		const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const win = window.open(url, '_blank');
		if (!win) {
			addToast('Popup blockiert — bitte Popups für diese Seite erlauben', 'error');
			URL.revokeObjectURL(url);
			return;
		}
		// Popup owns its blob URL; revoke after a minute so memory doesn't leak
		// even if the user closes the window without dismissing the print dialog.
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	function buildPrintDocument(title: string, renderedBody: string): string {
		const safeTitle = escapeHtml(title);
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
	font-size: 11pt;
	line-height: 1.55;
	color: #1a1a1a;
	background: #fff;
	max-width: 18cm;
	margin: 2rem auto;
	padding: 0 1rem;
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
<script>
window.addEventListener('load', function () {
	setTimeout(function () { window.print(); }, 150);
});
window.addEventListener('afterprint', function () { window.close(); });
<\/script>
</body>
</html>`;
	}

	function exportMermaidPng(btn: Element) {
		const svg = btn.closest('.mermaid-diagram')?.querySelector(':scope > svg') as SVGSVGElement | null;
		if (!svg) return;

		const clone = svg.cloneNode(true) as SVGSVGElement;
		const bbox = svg.getBoundingClientRect();
		clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		clone.setAttribute('width', String(bbox.width));
		clone.setAttribute('height', String(bbox.height));

		const svgData = new XMLSerializer().serializeToString(clone);
		const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));

		const scale = 2;
		const canvas = document.createElement('canvas');
		canvas.width = bbox.width * scale;
		canvas.height = bbox.height * scale;
		const c = canvas.getContext('2d')!;
		c.scale(scale, scale);

		const img = new Image();
		img.onload = () => {
			c.fillStyle = '#0c0c20';
			c.fillRect(0, 0, bbox.width, bbox.height);
			c.drawImage(img, 0, 0, bbox.width, bbox.height);
			const a = document.createElement('a');
			a.href = canvas.toDataURL('image/png');
			a.download = `diagram-${Date.now()}.png`;
			a.click();
		};
		img.src = dataUrl;
	}

	/** Ask iframe to re-measure and post its height via postMessage */
	function resizeArtifactFrame(container: HTMLElement) {
		const iframe = container.querySelector('.artifact-frame') as HTMLIFrameElement | null;
		if (!iframe) return;
		try { iframe.contentWindow?.postMessage('lynox-measure', '*'); } catch { /* cross-origin safe */ }
	}

	function handleArtifactSource(container: HTMLElement) {
		const sourceWrap = container.querySelector('.artifact-source-wrap') as HTMLElement;
		const iframe = container.querySelector('.artifact-frame') as HTMLElement;
		if (!sourceWrap || !iframe) return;

		const isHidden = sourceWrap.classList.contains('hidden');
		if (isHidden) {
			// Populate source on first open
			if (!sourceWrap.textContent) {
				const encoded = container.dataset['html'] ?? '';
				const html = decodeURIComponent(escape(atob(encoded)));
				sourceWrap.textContent = html;
			}
			sourceWrap.classList.remove('hidden');
			iframe.classList.add('hidden');
		} else {
			sourceWrap.classList.add('hidden');
			iframe.classList.remove('hidden');
		}
	}

	function handleArtifactExpand(container: HTMLElement) {
		container.classList.toggle('artifact-fullscreen');

		if (container.classList.contains('artifact-fullscreen')) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
		}
	}

	/** Render artifact to canvas via html2canvas in a temporary iframe */
	async function renderArtifactToCanvas(container: HTMLElement): Promise<HTMLCanvasElement | null> {
		const encoded = container.dataset['html'] ?? '';
		if (!encoded) return null;
		const rawHtml = decodeURIComponent(escape(atob(encoded)));
		// Security: strip all scripts via DOMPurify so allow-same-origin is safe
		const html = DOMPurify.sanitize(rawHtml, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style', 'link', 'meta'] });

		const tmp = document.createElement('iframe');
		tmp.setAttribute('sandbox', 'allow-same-origin');
		tmp.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:600px;border:none';
		tmp.srcdoc = html;
		document.body.appendChild(tmp);

		try {
			await new Promise<void>((resolve) => { tmp.onload = () => resolve(); });
			await new Promise(r => setTimeout(r, 500));

			const doc = tmp.contentDocument;
			if (!doc) return null;
			const { default: html2canvas } = await import('html2canvas');
			return await html2canvas(doc.body, {
				backgroundColor: '#0a0a1a',
				scale: 2,
				useCORS: true,
				width: 800,
			});
		} catch {
			return null;
		} finally {
			document.body.removeChild(tmp);
		}
	}

	async function handleArtifactExport(container: HTMLElement) {
		const canvas = await renderArtifactToCanvas(container);
		if (!canvas) { addToast('Export failed', 'error'); return; }
		canvas.toBlob(blob => {
			if (!blob) return;
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			const title = container.dataset['title'] ?? 'artifact';
			a.download = `${title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.png`;
			a.click();
			URL.revokeObjectURL(a.href);
		}, 'image/png');
	}

	async function handleArtifactScreenshot(container: HTMLElement) {
		const canvas = await renderArtifactToCanvas(container);
		if (!canvas) { addToast('Screenshot failed', 'error'); return; }
		canvas.toBlob(blob => {
			if (!blob) return;
			navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
				addToast('Screenshot copied', 'success');
			}).catch(() => {
				// Fallback: download if clipboard unavailable
				const a = document.createElement('a');
				a.href = URL.createObjectURL(blob);
				a.download = `artifact-${Date.now()}.png`;
				a.click();
				URL.revokeObjectURL(a.href);
			});
		}, 'image/png');
	}

	function handleArtifactSave(container: HTMLElement) {
		const encoded = container.dataset['html'] ?? '';
		const html = decodeURIComponent(escape(atob(encoded)));
		const defaultTitle = container.dataset['title'] ?? 'Artifact';
		const title = prompt('Titel:', defaultTitle) ?? defaultTitle;
		saveArtifact({ title, content: html, type: 'html' }).then(result => {
			if (result) addToast(t('artifacts.saved'), 'success');
		});
	}

	// ── Escape key for fullscreen artifacts ──────────────────
	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key !== 'Escape') return;
			const fs = document.querySelector('.artifact-fullscreen') as HTMLElement | null;
			if (fs) {
				fs.classList.remove('artifact-fullscreen');
				document.body.style.overflow = '';
			}
		}
		window.addEventListener('keydown', handleEscape);
		return () => window.removeEventListener('keydown', handleEscape);
	});

	// ── PostMessage listener for iframe height ────────────────
	$effect(() => {
		function handleMessage(e: MessageEvent) {
			if (e.data?.type !== 'lynox-resize') return;
			const h = e.data.h;
			if (typeof h !== 'number' || h <= 0) return;
			const iframes = document.querySelectorAll('.artifact-frame') as NodeListOf<HTMLIFrameElement>;
			for (const iframe of iframes) {
				if (iframe.contentWindow === e.source) {
					iframe.style.height = `${Math.max(h, 200)}px`;
					break;
				}
			}
		}
		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	});

	// ── Code block processing ────────────────────────────────
	// Rich blocks (mermaid, artifact) are debounced to prevent iframe flashing
	// during streaming. Once rendered, results are cached so subsequent updates
	// reuse the stable HTML without recreating iframes.

	const richCache = new Map<string, string>();

	async function processBlocks(html: string, matches: RegExpMatchArray[]): Promise<string> {
		const results = await Promise.all(
			matches.map(async (match) => {
				const lang = match[1] ?? 'text';
				const raw = match[2] ?? '';
				const code = decodeEntities(raw);

				// Treat html blocks containing full documents as artifacts
				const isRichBlock = lang === 'mermaid' || lang === 'artifact'
					|| (lang === 'html' && (code.includes('<!DOCTYPE') || code.includes('<html')));
				if (isRichBlock) {
					const cached = richCache.get(raw);
					if (cached) return { original: match[0], result: cached };
					// Uncached during streaming → show placeholder instead of raw code
					const placeholder = `<div class="artifact-placeholder"><span class="artifact-placeholder-dot"></span><span>${t('tool.artifact_creating')}</span></div>`;
					return { original: match[0], result: placeholder };
				}

				try {
					return { original: match[0], result: await codeToHtml(code, { lang, theme: 'github-dark' }) };
				} catch {
					return { original: match[0], result: match[0] };
				}
			})
		);
		let result = html;
		for (const { original, result: replacement } of results) {
			if (original) result = result.replace(original, replacement);
		}
		return result;
	}

	$effect(() => {
		const html = baseHtml;
		const codeBlockRegex = /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g;
		const matches = [...html.matchAll(codeBlockRegex)];

		if (matches.length === 0) {
			highlightedHtml = html;
			return;
		}

		// Immediate render — uses cached rich blocks or falls back to shiki
		processBlocks(html, matches).then(result => {
			highlightedHtml = result;
		});

		// Debounce uncached rich blocks (prevents iframe flash during streaming)
		const uncached = matches.filter(m => {
			const lang = m[1] ?? '';
			const code = m[2] ?? '';
			const isRich = lang === 'mermaid' || lang === 'artifact'
				|| (lang === 'html' && (code.includes('&lt;!DOCTYPE') || code.includes('&lt;html')));
			return isRich && !richCache.has(code);
		});
		// While streaming, keep iframe artifacts as syntax-highlighted code
		// to avoid flash. Markdown artifacts render live — no iframe, no flash.
		const workset = streaming
			? uncached.filter(m => (m[1] ?? '') === 'artifact' && isMarkdownArtifact(decodeEntities(m[2] ?? '')))
			: uncached;
		if (workset.length === 0) return;

		// Markdown artifacts render fast, without a debounce — the user
		// expects them to appear live during streaming. Iframe artifacts
		// keep the 400 ms debounce to coalesce late fence closings.
		const delay = workset.every(m => (m[1] ?? '') === 'artifact' && isMarkdownArtifact(decodeEntities(m[2] ?? ''))) ? 0 : 400;

		const timer = setTimeout(async () => {
			for (const match of workset) {
				const lang = match[1] ?? 'text';
				const raw = match[2] ?? '';
				const code = decodeEntities(raw);
				try {
					if (lang === 'mermaid') richCache.set(raw, await renderMermaid(code));
					else richCache.set(raw, buildArtifact(code)); // artifact + html full docs
				} catch { /* keep shiki fallback */ }
			}
			if (baseHtml === html) {
				highlightedHtml = await processBlocks(html, matches);
			}
		}, delay);

		return () => clearTimeout(timer);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div onclick={handleContainerClick} class="prose prose-invert max-w-none
	prose-pre:bg-bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-[var(--radius-md)] prose-pre:overflow-x-auto
	prose-code:text-accent-text prose-code:text-xs prose-code:font-mono
	prose-a:text-accent-text prose-a:no-underline hover:prose-a:opacity-80
	prose-headings:text-text prose-headings:font-medium prose-headings:tracking-tight
	prose-p:leading-relaxed prose-li:leading-relaxed
	prose-strong:text-text prose-strong:font-semibold">
	{@html highlightedHtml || baseHtml}
</div>

<style>
	/* Base prose overrides for readability */
	div :global(p) {
		font-size: 0.9375rem;
		line-height: 1.75;
		margin-bottom: 1rem;
	}

	div :global(strong) {
		color: var(--color-text);
		letter-spacing: 0.01em;
	}

	/* Override Shiki's inline styles to match our theme */
	:global(.shiki) {
		background-color: transparent !important;
		padding: 0.75rem 1rem;
		font-size: 0.75rem;
		line-height: 1.6;
	}

	/* Styled scrollbars for code blocks and pre elements */
	div :global(pre) {
		scrollbar-width: thin;
		scrollbar-color: var(--color-border) transparent;
	}

	/* Tables */
	div :global(.table-wrap) {
		overflow-x: auto;
		margin: 1rem 0;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: thin;
		scrollbar-color: var(--color-border) transparent;
	}
	div :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}
	div :global(th) {
		text-align: left;
		font-weight: 600;
		color: var(--color-text);
		padding: 0.625rem 0.875rem;
		border-bottom: 1px solid var(--color-border);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		white-space: nowrap;
	}
	div :global(td) {
		padding: 0.5rem 0.875rem;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-muted);
		word-break: break-word;
		max-width: 20rem;
	}
	div :global(tr:last-child td) {
		border-bottom: none;
	}
	div :global(tr:hover td) {
		background-color: var(--color-bg-subtle);
	}

	/* Headings — visual section separation */
	div :global(h1),
	div :global(h2),
	div :global(h3),
	div :global(h4) {
		margin-top: 1.75rem;
		margin-bottom: 0.75rem;
	}
	div :global(:first-child:is(h1, h2, h3, h4)) {
		margin-top: 0;
	}

	/* Blockquotes */
	div :global(blockquote) {
		border-left: 3px solid var(--color-accent);
		padding: 0.5rem 1rem;
		margin: 1rem 0;
		color: var(--color-text-muted);
		background-color: var(--color-bg-subtle);
		border-radius: 0 var(--radius-md) var(--radius-md) 0;
	}
	div :global(blockquote p) {
		margin: 0;
	}

	/* Lists */
	div :global(ul) {
		list-style-type: disc;
		padding-left: 1.5rem;
		margin: 0.75rem 0;
	}
	div :global(ol) {
		list-style-type: decimal;
		padding-left: 1.5rem;
		margin: 0.75rem 0;
	}
	div :global(li) {
		margin: 0.375rem 0;
		font-size: 0.9375rem;
		line-height: 1.7;
	}
	div :global(li > ul),
	div :global(li > ol) {
		margin: 0.25rem 0;
	}

	/* Horizontal rules */
	div :global(hr) {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 1.5rem 0;
	}

	/* ── Mermaid ────────────────────────────────────────── */

	div :global(.mermaid-diagram) {
		position: relative;
		display: flex;
		justify-content: center;
		margin: 1rem 0;
		padding: 1rem;
		background-color: var(--color-bg-subtle);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow-x: auto;
	}
	div :global(.mermaid-diagram svg) {
		max-width: 100%;
		height: auto;
	}
	div :global(.diagram-actions) {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		display: flex;
		gap: 0.25rem;
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 1;
	}
	div :global(.mermaid-diagram:hover .diagram-actions) {
		opacity: 1;
	}
	div :global(.diagram-btn) {
		background: var(--color-bg-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 4px);
		padding: 0.375rem;
		color: var(--color-text-muted);
		cursor: pointer;
		line-height: 0;
	}
	div :global(.diagram-btn:hover) {
		color: var(--color-text);
		background: var(--color-bg-subtle);
	}

	/* ── Artifact placeholder during streaming ─────────── */
	div :global(.artifact-placeholder) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		margin: 0.75rem 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-muted);
		font-size: 0.75rem;
		color: var(--color-text-subtle);
	}
	div :global(.artifact-placeholder-dot) {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-warning);
		animation: pulse 1.5s ease-in-out infinite;
	}

	/* ── Artifacts ──────────────────────────────────────── */

	div :global(.artifact-container) {
		margin: 1rem 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow: hidden;
		overflow-x: hidden;
		background: var(--color-bg-muted);
		max-width: 100%;
	}

	div :global(.artifact-toolbar) {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.375rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-subtle);
	}

	div :global(.artifact-label) {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-accent-text, #9B8AFF);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-right: auto;
	}

	/* Markdown artifacts: same container chrome as iframe artifacts but
	   body is inline rendered markdown. Expanded by default — prose is
	   meant to be read inline, not gated behind a toggle. */
	div :global(.artifact-md) {
		background: var(--color-bg-subtle);
	}
	div :global(.artifact-md .artifact-toolbar) {
		border-bottom: 1px solid var(--color-border);
	}
	/* Reset the label's margin-right:auto inside .artifact-md so the
	   "Markdown" badge sits next to the title on the left. */
	div :global(.artifact-md .artifact-label) {
		margin-right: 0;
	}
	div :global(.artifact-md-title) {
		font-size: 0.75rem;
		color: var(--color-text);
		font-weight: 500;
		margin-right: auto;
	}
	div :global(.artifact-md-body) {
		padding: 0.75rem 1rem;
	}
	div :global(.artifact-md-body > :first-child) {
		margin-top: 0;
	}
	div :global(.artifact-md-body > :last-child) {
		margin-bottom: 0;
	}

	/* Small chip shown under inline markdown-type artifacts so the user
	   can see it was persisted. Intentionally NOT a link — the markdown
	   is already rendered in-chat, clicking the badge and jumping to
	   /app/artifacts broke the user's mental model. */
	div :global(.artifact-saved-chip) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		color: var(--color-text-subtle);
		background: var(--color-bg-subtle);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.125rem 0.625rem;
		margin-top: 0.5rem;
	}

	div :global(.artifact-btn) {
		background: none;
		border: 1px solid transparent;
		border-radius: var(--radius-sm, 4px);
		padding: 0.25rem;
		color: var(--color-text-muted);
		cursor: pointer;
		line-height: 0;
		transition: color 0.15s, border-color 0.15s;
	}
	div :global(.artifact-btn:hover) {
		color: var(--color-text);
		border-color: var(--color-border);
	}

	div :global(.artifact-frame) {
		width: 100%;
		border: none;
		display: block;
		background: #0a0a1a;
		color-scheme: dark;
	}
	div :global(.artifact-collapsed .artifact-frame) {
		display: none;
	}
	div :global(.artifact-toggle-hint) {
		font-size: 0.625rem;
		color: var(--color-text-subtle);
		margin-right: auto;
		transition: opacity 0.15s;
	}
	div :global(.artifact-container:not(.artifact-collapsed) .artifact-toggle-hint) {
		display: none;
	}
	div :global(.artifact-close-btn) {
		display: none;
	}
	div :global(.artifact-fullscreen .artifact-close-btn) {
		display: inline-flex;
	}

	div :global(.artifact-source-wrap) {
		padding: 0.75rem 1rem;
		font-size: 0.75rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		line-height: 1.6;
		color: var(--color-text-muted);
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 420px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--color-border) transparent;
	}

	div :global(.hidden) {
		display: none !important;
	}

	/* Fullscreen overlay */
	div :global(.artifact-fullscreen) {
		position: fixed;
		inset: 0;
		z-index: 9999;
		margin: 0;
		border-radius: 0;
		border: none;
		display: flex;
		flex-direction: column;
	}
	div :global(.artifact-fullscreen .artifact-frame) {
		flex: 1;
		height: auto;
		overflow: auto;
	}
	div :global(.artifact-fullscreen .artifact-source-wrap) {
		flex: 1;
		height: auto;
		max-height: none;
	}
</style>
