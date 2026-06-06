<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { codeToHtml } from 'shiki';
	import { goto } from '$app/navigation';
	import { saveArtifact } from '../stores/artifacts.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { getResolvedTheme, type ResolvedTheme } from '../stores/theme.svelte.js';
	import { fixMarkdownPreprocessing, repairCodeFences } from '../utils/markdown-preprocess.js';
	import { deckFrameHeight, computeFitZoom } from '../utils/artifact-frame.js';
	import { printHtmlDocument, printMarkdownDocument } from '../utils/artifact-print.js';

	interface Props {
		content: string;
		/** When true, defer artifact iframe rendering (show code instead). */
		streaming?: boolean;
	}

	let { content, streaming = false }: Props = $props();

	let highlightedHtml = $state('');

	// Wrap <table> elements in a scrollable container for wide tables.
	function wrapTables(html: string): string {
		return html.replace(/<table\b[^>]*>/g, '<div class="table-wrap">$&').replace(/<\/table>/g, '</table></div>');
	}

	const baseHtml = $derived(
		wrapTables(DOMPurify.sanitize(marked.parse(repairCodeFences(fixMarkdownPreprocessing(content)), { async: false }) as string))
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

	let mermaidInitTheme: ResolvedTheme | null = null;

	function mermaidVars(theme: ResolvedTheme): Record<string, string> {
		if (theme === 'light') {
			return {
				primaryColor: '#eceef2',
				primaryTextColor: '#0b0b14',
				primaryBorderColor: '#21179b',
				lineColor: '#6b6e7b',
				secondaryColor: '#f6f7f9',
				tertiaryColor: '#ffffff',
				background: '#ffffff',
				mainBkg: '#f6f7f9',
				nodeBorder: '#21179b',
				clusterBkg: '#ffffff',
				titleColor: '#0b0b14',
				edgeLabelBackground: '#ffffff'
			};
		}
		return {
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
		};
	}

	async function renderMermaid(code: string): Promise<string> {
		const { default: mermaid } = await import('mermaid');
		const theme = getResolvedTheme();
		if (mermaidInitTheme !== theme) {
			mermaid.initialize({
				startOnLoad: false,
				theme: theme === 'light' ? 'default' : 'dark',
				themeVariables: mermaidVars(theme)
			});
			mermaidInitTheme = theme;
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

	function buildMermaidError(code: string, message: string): string {
		return `<div class="mermaid-error">
			<div class="mermaid-error-header">
				<span class="mermaid-error-icon">!</span>
				<span class="mermaid-error-title">${escapeHtml(t('markdown.mermaid_error'))}</span>
			</div>
			<div class="mermaid-error-message">${escapeHtml(message)}</div>
			<pre class="mermaid-error-source"><code>${escapeHtml(code)}</code></pre>
		</div>`;
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

	/** Build a markdown-typed artifact: same collapsed-pill chrome as the iframe
	 *  variant (container + toolbar + label), but the body is rendered markdown,
	 *  not an iframe. Collapsed by default like every type (lazy-expand pill).
	 *  The raw markdown source is embedded as `data-md` so the toolbar
	 *  buttons can produce a .md download and a print-to-PDF popup from the
	 *  original text (not the rendered HTML). */
	function buildMarkdownArtifact(code: string): string {
		const { title, clean } = extractTitle(code);
		const body = clean.replace(/<!--\s*type:\s*markdown\s*-->\s*/i, '').trim();
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);
		const rendered = DOMPurify.sanitize(marked.parse(fixMarkdownPreprocessing(body), { async: false }) as string);
		const encodedMd = btoa(unescape(encodeURIComponent(body)));
		return `<div class="artifact-container artifact-md artifact-collapsed" data-md="${encodedMd}" data-title="${safeTitle}">
			<div class="artifact-toolbar" data-action="toggle" style="cursor:pointer">
				<span class="artifact-type-icon">${artifactTypeIcon('markdown')}</span>
				<span class="artifact-label">Markdown</span>
				<span class="artifact-title">${safeTitle}</span>
				<button class="artifact-btn" data-action="open-gallery" title="Open in Artifacts">${ICON_OPEN_GALLERY}</button>
				<button class="artifact-btn" data-action="download-md" title="Download as .md">${ICON_DOWNLOAD}</button>
				<button class="artifact-btn" data-action="print-pdf" title="Print / Save as PDF">${ICON_PRINT}</button>
				<button type="button" class="artifact-chevron" aria-label="${t('artifacts.toggle_preview')}" aria-expanded="false">${ICON_CHEVRON}</button>
			</div>
			<div class="artifact-md-body prose prose-invert max-w-none">${rendered}</div>
		</div>`;
	}

	/** csv/tsv/json/text artifacts are real data files: they render as a
	 *  labelled code preview with a download button, never an HTML iframe. */
	const DATA_ARTIFACT_META: Record<string, { ext: string; mime: string; label: string }> = {
		csv: { ext: 'csv', mime: 'text/csv', label: 'CSV' },
		tsv: { ext: 'tsv', mime: 'text/tab-separated-values', label: 'TSV' },
		json: { ext: 'json', mime: 'application/json', label: 'JSON' },
		text: { ext: 'txt', mime: 'text/plain', label: 'Text' },
	};

	/** Return the data-artifact type if the fence body is marked as one. */
	function artifactDataType(code: string): string | null {
		const m = code.match(/<!--\s*type:\s*(csv|tsv|json|text)\s*-->/i);
		return m ? m[1]!.toLowerCase() : null;
	}

	/** Build a data-file artifact: a code preview plus a download button that
	 *  produces a real Blob with the right extension and MIME type. The full
	 *  body is embedded as `data-raw` so the download is the exact file, not
	 *  the truncated preview. */
	function buildDataArtifact(code: string, type: string): string {
		const meta = DATA_ARTIFACT_META[type] ?? DATA_ARTIFACT_META['text']!;
		const { title, clean } = extractTitle(code);
		// Anchored: only strip the leading marker we ourselves prepended, never
		// a literal `<!-- type: … -->` that happens to sit inside the data.
		const body = clean.replace(/^<!--\s*type:\s*\w+\s*-->\s*/i, '').trim();
		const safeTitle = escapeHtml(title || 'Data');
		const encodedRaw = btoa(unescape(encodeURIComponent(body)));
		const lines = body.split('\n');
		const preview = escapeHtml(lines.slice(0, 60).join('\n')) + (lines.length > 60 ? '\n…' : '');
		return `<div class="artifact-container artifact-data artifact-collapsed" data-raw="${encodedRaw}" data-ext="${meta.ext}" data-mime="${meta.mime}" data-title="${safeTitle}">
			<div class="artifact-toolbar" data-action="toggle" style="cursor:pointer">
				<span class="artifact-type-icon">${artifactTypeIcon(type)}</span>
				<span class="artifact-label">${meta.label}</span>
				<span class="artifact-title">${safeTitle}</span>
				<button class="artifact-btn" data-action="download-data" title="Download .${meta.ext}">${ICON_DOWNLOAD}</button>
				<button type="button" class="artifact-chevron" aria-label="${t('artifacts.toggle_preview')}" aria-expanded="false">${ICON_CHEVRON}</button>
			</div>
			<pre class="artifact-data-body"><code>${preview}</code></pre>
		</div>`;
	}

	function buildArtifact(code: string): string {
		if (isMarkdownArtifact(code)) return buildMarkdownArtifact(code);
		const dataType = artifactDataType(code);
		if (dataType) return buildDataArtifact(code, dataType);
		const { title, clean } = extractTitle(code);
		// PRD-LIGHT-MODE PR 2a — srcdoc is sandboxed; CSS-vars from parent don't
		// inherit into the iframe document. Read the theme at render time and
		// inject matching styles. Theme-flip invalidates richCache (downstream
		// $effect on getResolvedTheme) so srcdoc is regenerated.
		const theme = getResolvedTheme();
		const bg = theme === 'light' ? '#ffffff' : '#0a0a1a';
		const fg = theme === 'light' ? '#0b0b14' : '#e8e8f0';
		const defaultStyles = `<style>body{background:${bg};color:${fg};font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1rem}*{box-sizing:border-box}</style>`;
		// overflow-x:auto (not hidden) so a wide document (e.g. an A4-print HTML
		// artifact) can be PANNED on mobile instead of being clipped off-screen.
		const overflowFix = `<style>html,body{overflow-x:auto;max-width:100vw;scrollbar-width:none;-ms-overflow-style:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}</style>`;
		let fullHtml: string;
		if (clean.includes('<html')) {
			// Inject a viewport meta if the artifact's own <html> lacks one, so it
			// lays out for the device width on mobile instead of desktop-wide.
			const viewportMeta = /name=["']viewport["']/i.test(clean)
				? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">';
			fullHtml = clean.replace(/<head[^>]*>/, `$&${CSP_META}${viewportMeta}${overflowFix}`);
			fullHtml = fullHtml.includes('</body>') ? fullHtml.replace('</body>', `${RESIZE_SCRIPT}</body>`) : fullHtml + RESIZE_SCRIPT;
		} else {
			fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${CSP_META}${defaultStyles}${overflowFix}</head><body>${clean}${RESIZE_SCRIPT}</body></html>`;
		}
		const encoded = btoa(unescape(encodeURIComponent(fullHtml)));
		const escaped = fullHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);
		const typeMatch = code.match(/<!--\s*type:\s*([a-z]+)\s*-->/i);
		const typeKey = typeMatch ? typeMatch[1]!.toLowerCase() : 'html';
		const typeLabel = typeKey.toUpperCase();

		return `<div class="artifact-container artifact-collapsed" data-html="${encoded}" data-title="${safeTitle}">
			<div class="artifact-toolbar" data-action="toggle" style="cursor:pointer">
				<span class="artifact-type-icon">${artifactTypeIcon(typeKey)}</span>
				<span class="artifact-label">${typeLabel}</span>
				<span class="artifact-title">${safeTitle}</span>
				<button class="artifact-btn" data-action="screenshot" title="Copy as image">${ICON_CLIPBOARD}</button>
				<button class="artifact-btn" data-action="export" title="Download image">${ICON_DOWNLOAD}</button>
				<button class="artifact-btn" data-action="download-html" title="Download .html source">${ICON_CODE}</button>
				<button class="artifact-btn" data-action="print-pdf" title="Save as PDF">${ICON_PRINT}</button>
				<button class="artifact-btn" data-action="expand" title="Fullscreen">${ICON_EXPAND}</button>
				<button class="artifact-btn artifact-close-btn" data-action="close" title="Close">${ICON_CLOSE}</button>
				<button class="artifact-btn" data-action="pin" title="Pin to Artifacts">${ICON_SAVE}</button>
				<button type="button" class="artifact-chevron" aria-label="${t('artifacts.toggle_preview')}" aria-expanded="false">${ICON_CHEVRON}</button>
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
	// External-link / "open in another view" icon — arrow exiting a frame.
	const ICON_OPEN_GALLERY = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9 2h5v5M14 2L8 8M11 9v4a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	// Chevron — the universal expand/collapse affordance on the pill row;
	// rotates 90° when the artifact is expanded (CSS).
	const ICON_CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

	// Per-type leading icon shown in the collapsed pill. Keeps the pill
	// scannable at a glance (frame=html/svg, branches=mermaid, lines=doc,
	// grid=data) before the type label even reads.
	const ICON_TYPE_FRAME = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.3"/></svg>`;
	const ICON_TYPE_DOC = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l3 3v9H4V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 7h4M6 9.5h4M6 12h2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`;
	const ICON_TYPE_GRID = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M2 9.5h12M6.5 3v10" stroke="currentColor" stroke-width="1.1"/></svg>`;
	const ICON_TYPE_FLOW = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="3.5" rx="0.5" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="10.5" width="5" height="3.5" rx="0.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 5.5v3a2 2 0 002 2h2.5" stroke="currentColor" stroke-width="1.2"/></svg>`;

	function artifactTypeIcon(type: string): string {
		switch (type) {
			case 'markdown': return ICON_TYPE_DOC;
			case 'csv': case 'tsv': case 'json': case 'text': return ICON_TYPE_GRID;
			case 'mermaid': return ICON_TYPE_FLOW;
			default: return ICON_TYPE_FRAME; // html / svg
		}
	}

	/** Injected into artifact iframes — posts height via postMessage for cross-origin resize */
	// `deck` flag: a 100vh/dvh slide-deck collapses scrollHeight (absolute /
	// overflow-hidden, viewport-pinned content) so the parent can't size it from
	// the measured height. We flag it when BOTH a viewport-height unit is present
	// AND scrollHeight stays within the current viewport (a long min-height:100vh
	// page that actually flows tall reports a large scrollHeight → not a deck →
	// normal sizing keeps working). The parent then sizes by aspect ratio.
	// The deck regex + `sh<=vh+8` guard are the sandbox-isolated mirror of
	// `isViewportDeck` in lib/utils/artifact-frame.ts — keep them identical. The
	// viewport-unit scan is cached (`vu`) since style text doesn't change after
	// load, so each ResizeObserver tick only re-reads scrollHeight/innerHeight
	// instead of re-walking the whole DOM. (String backslashes are doubled so the
	// emitted srcdoc carries a valid `\d`/`\b` regex literal.)
	const RESIZE_SCRIPT = '<script>(function(){var vu=null;function st(){var t="",i,s=document.getElementsByTagName("style");for(i=0;i<s.length;i++)t+=s[i].textContent||"";var e=document.querySelectorAll("[style]");for(i=0;i<e.length;i++)t+=e[i].getAttribute("style")||"";return t}function hasVU(){if(vu===null){try{vu=/(?:^|[^\\d.])100(?:vh|dvh|svh|lvh)\\b/i.test(st())}catch(x){vu=false}}return vu}function s(){var sh=document.documentElement.scrollHeight,vh=window.innerHeight||0,bw=document.body?document.body.scrollWidth:0;parent.postMessage({type:"lynox-resize",h:sh,w:Math.max(document.documentElement.scrollWidth,bw),deck:hasVU()&&vh>0&&sh<=vh+8},"*")}window.addEventListener("message",function(e){if(e.data==="lynox-measure")s()});window.addEventListener("load",function(){s();setTimeout(s,300);setTimeout(s,1500)});if(typeof ResizeObserver!=="undefined")new ResizeObserver(s).observe(document.documentElement);s()})()</' + 'script>';

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
				const expanded = !container.classList.contains('artifact-collapsed');
				// Keep the chevron button's aria-expanded in sync for screen readers.
				container.querySelector('.artifact-chevron')?.setAttribute('aria-expanded', String(expanded));
				if (expanded) {
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
			else if (action === 'download-html') handleHtmlDownload(container);
			else if (action === 'download-data') handleDataDownload(container);
			else if (action === 'download-md') handleMarkdownDownload(container);
			// One "Save as PDF" action for both document types — HTML artifacts
			// (data-html) print their rendered source, markdown its rendered body.
			else if (action === 'print-pdf') {
				if (container.dataset['html']) handleHtmlPrint(container);
				else handleMarkdownPrint(container);
			}
			else if (action === 'open-gallery') void handleMarkdownOpenGallery(container);
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
		if (!md) { addToast('Download failed', 'error'); return; }
		const title = container.dataset['title'] ?? 'artifact';
		const filename = `${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')}.md`;
		const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = filename || 'artifact.md';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	/** Trigger a browser download of `content` as a file. */
	function downloadBlob(content: string, filename: string, mime: string) {
		const blob = new Blob([content], { type: `${mime};charset=utf-8` });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = filename;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	/** Slugify the artifact title into a safe `<base>.<ext>` filename. */
	function artifactFilename(container: HTMLElement, ext: string): string {
		const title = container.dataset['title'] ?? 'artifact';
		const base = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
		return `${base || 'artifact'}.${ext}`;
	}

	/** Download a data-file artifact (csv/tsv/json/text) as its real file. */
	function handleDataDownload(container: HTMLElement) {
		const encoded = container.dataset['raw'] ?? '';
		let raw = '';
		try { raw = encoded ? decodeURIComponent(escape(atob(encoded))) : ''; }
		catch { raw = ''; }
		if (!raw) { addToast('Download failed', 'error'); return; }
		const ext = container.dataset['ext'] ?? 'txt';
		const mime = container.dataset['mime'] ?? 'text/plain';
		downloadBlob(raw, artifactFilename(container, ext), mime);
	}

	/** Download the raw HTML source of an HTML artifact as a .html file. */
	function handleHtmlDownload(container: HTMLElement) {
		const encoded = container.dataset['html'] ?? '';
		let html = '';
		try { html = encoded ? decodeURIComponent(escape(atob(encoded))) : ''; }
		catch { html = ''; }
		if (!html) { addToast('Download failed', 'error'); return; }
		downloadBlob(html, artifactFilename(container, 'html'), 'text/html');
	}

	/** Open the rendered markdown in a fresh popup with a print-friendly
	 *  stylesheet, then auto-trigger the browser's print dialog. User picks
	 *  "Save as PDF" (Desktop) or "Save to Files" (iOS Safari share sheet).
	 *  Pure-browser flow — no dependency, PDF output has selectable text,
	 *  tables render natively. */
	function handleMarkdownPrint(container: HTMLElement) {
		const md = decodeDataMd(container);
		if (!md) { addToast('PDF export failed', 'error'); return; }
		const title = container.dataset['title'] ?? 'Artifact';
		if (!printMarkdownDocument(md, title)) {
			addToast('Popup blocked — allow popups for this site to print', 'error');
		}
	}

	/** Save an HTML artifact as PDF via the browser print pipeline. The source is
	 *  sanitized (scripts stripped) but keeps its styles, so a styled document
	 *  like a contract prints with full fidelity + selectable text. */
	function handleHtmlPrint(container: HTMLElement) {
		const encoded = container.dataset['html'] ?? '';
		let raw = '';
		try { raw = encoded ? decodeURIComponent(escape(atob(encoded))) : ''; }
		catch { raw = ''; }
		if (!raw) { addToast('PDF export failed', 'error'); return; }
		if (!printHtmlDocument(raw)) {
			addToast('Popup blocked — allow popups for this site to print', 'error');
		}
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
			// Asset-export background follows current UI theme so the exported
			// PNG matches what the user just saw.
			c.fillStyle = getResolvedTheme() === 'light' ? '#ffffff' : '#0c0c20';
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
		const entering = !container.classList.contains('artifact-fullscreen');
		container.classList.toggle('artifact-fullscreen');
		document.body.style.overflow = entering ? 'hidden' : '';
		const iframe = container.querySelector('.artifact-frame') as HTMLIFrameElement | null;
		if (iframe) applyFullscreenFit(iframe, entering);
	}

	/** Clear every inline style applyFullscreenFit may have set. Idempotent —
	 *  safe to call on collapse, on ESC, and on the no-fit branch. */
	function clearFullscreenFit(iframe: HTMLIFrameElement) {
		iframe.style.width = '';
		iframe.style.height = '';
		iframe.style.transform = '';
		iframe.style.transformOrigin = '';
		iframe.style.marginRight = '';
		iframe.style.marginBottom = '';
	}

	/** Fit a wide artifact (e.g. an A4-print HTML doc) to the fullscreen frame
	 *  width so the whole page is visible on a narrow phone instead of being
	 *  clipped. Uses `transform: scale()` (NOT CSS `zoom`, which iOS-Safari
	 *  ignores → the prior fix didn't work on iPhone). A CSS transform is
	 *  paint-only and does NOT shrink the element's layout box, so we lay the
	 *  frame out at its intrinsic size, scale from the top-left, then pull the
	 *  reclaimed width/height back with NEGATIVE MARGINS — otherwise the
	 *  intrinsic-width box overflows the container horizontally (the exact
	 *  clipping we're fixing) and leaves dead scroll space below. Reverted on
	 *  collapse; a no-op for content that already fits. */
	function applyFullscreenFit(iframe: HTMLIFrameElement, entering: boolean) {
		if (!entering) {
			clearFullscreenFit(iframe);
			return;
		}
		// rAF so the fullscreen layout (frame width) is settled before measuring.
		requestAnimationFrame(() => {
			const cw = Number(iframe.dataset['cw'] ?? 0);
			// Intrinsic content height = the height the resize handler already set
			// on the inline frame (the fullscreen CSS doesn't override it). Read it
			// BEFORE we mutate height below.
			const ch = parseFloat(iframe.style.height) || 0;
			const frameW = iframe.parentElement?.clientWidth ?? iframe.clientWidth;
			const scale = computeFitZoom(cw, frameW);
			if (scale === null) {
				// Already fits — clear any stale fit from a previous open.
				clearFullscreenFit(iframe);
				return;
			}
			iframe.style.width = `${cw}px`;
			iframe.style.transformOrigin = 'top left';
			iframe.style.transform = `scale(${scale})`;
			// Collapse the unscaled layout box to the scaled size so the container
			// sees exactly frameW × (ch·scale): no horizontal overflow, no dead gap.
			iframe.style.marginRight = `${-(cw - cw * scale)}px`;
			if (ch > 0) {
				iframe.style.height = `${ch}px`;
				iframe.style.marginBottom = `${-(ch - ch * scale)}px`;
			}
		});
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
				backgroundColor: getResolvedTheme() === 'light' ? '#ffffff' : '#0a0a1a',
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

	/**
	 * Open the markdown artifact in the dedicated /app/artifacts gallery
	 * view. Saves a snapshot to the ArtifactStore first (no prompt — the
	 * agent's title is used as-is to keep the click fast), then navigates.
	 * If the user already triggered this on the same artifact, they'll get
	 * a duplicate row in the gallery — acceptable cost; dedup-by-content
	 * is a future improvement.
	 */
	async function handleMarkdownOpenGallery(container: HTMLElement) {
		const md = decodeDataMd(container);
		if (!md) { addToast('Open failed', 'error'); return; }
		const title = container.dataset['title'] ?? 'Artifact';
		const result = await saveArtifact({ title, content: md, type: 'markdown' });
		if (!result) { addToast('Open failed', 'error'); return; }
		// Client-side nav so the chat scroll position, streaming SSE,
		// and the wider app shell don't blow away on a full reload.
		await goto(`/app/artifacts?id=${encodeURIComponent(result.id)}`);
	}

	// ── Escape key for fullscreen artifacts ──────────────────
	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key !== 'Escape') return;
			const fs = document.querySelector('.artifact-fullscreen') as HTMLElement | null;
			if (fs) {
				fs.classList.remove('artifact-fullscreen');
				document.body.style.overflow = '';
				// Revert the fit-to-width transform/width/margins — otherwise the
				// now-inline frame is left scaled + overflowing (button-collapse
				// reverts via handleArtifactExpand; ESC must too).
				const iframe = fs.querySelector('.artifact-frame') as HTMLIFrameElement | null;
				if (iframe) applyFullscreenFit(iframe, false);
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
			const w = e.data.w;
			const deck = e.data.deck === true;
			// A deck legitimately reports a collapsed height — only bail on a bad
			// height for the normal (non-deck) flow path.
			if (!deck && (typeof h !== 'number' || h <= 0)) return;
			const iframes = document.querySelectorAll('.artifact-frame') as NodeListOf<HTMLIFrameElement>;
			for (const iframe of iframes) {
				if (iframe.contentWindow === e.source) {
					// Remember the content's intrinsic width so fullscreen can fit-to-width
					// a wide doc (e.g. an A4-print artifact) instead of clipping it.
					if (typeof w === 'number' && w > 0) {
						iframe.dataset['cw'] = String(w);
						// If the artifact is ALREADY fullscreen, a late width measurement
						// (expand fired before the first resize message → cw was 0 → no fit)
						// lets us fit-to-width now instead of leaving the doc clipped.
						if (iframe.closest('.artifact-fullscreen')) applyFullscreenFit(iframe, true);
					}
					if (deck) {
						// 100vh slide-decks: size by 16:9 of the rendered width instead of
						// the collapsed scrollHeight (old Math.max(h,200) clamped to 200px).
						const deckW = iframe.clientWidth || iframe.getBoundingClientRect().width;
						iframe.style.height = `${deckFrameHeight(deckW, window.innerHeight)}px`;
					} else {
						iframe.style.height = `${Math.max(h, 200)}px`;
					}
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
					const shikiTheme = getResolvedTheme() === 'light' ? 'github-light' : 'github-dark';
					return { original: match[0], result: await codeToHtml(code, { lang, theme: shikiTheme }) };
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

	/*
	 * PRD-LIGHT-MODE PR 2a — theme-reactive re-render.
	 *
	 * Mermaid SVGs, Shiki-highlighted HTML, and iframe srcdoc all bake the
	 * theme palette into their output. When the user toggles theme:
	 *   1. richCache.clear() drops cached SVGs + iframe srcdocs.
	 *   2. processBlocks re-runs (theme is read via getResolvedTheme()).
	 *   3. highlightedHtml is reassigned, Svelte re-renders.
	 *
	 * Reading getResolvedTheme() inside the $effect tracks it as a dep, so
	 * the effect re-fires on theme change without any explicit subscription.
	 */
	$effect(() => {
		const html = baseHtml;
		const theme = getResolvedTheme();
		// Touch theme so $effect tracks it.
		void theme;
		// On theme change, clear caches so re-render picks up new palette.
		if (mermaidInitTheme !== null && mermaidInitTheme !== theme) {
			richCache.clear();
		}
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
				} catch (err) {
					// Failed mermaid would otherwise show a perma-placeholder
					// because processBlocks falls back to placeholder for any
					// uncached rich block. Cache an error block so the user
					// sees what happened and can copy the source.
					if (lang === 'mermaid') {
						const message = err instanceof Error ? err.message : String(err);
						richCache.set(raw, buildMermaidError(code, message));
					}
				}
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
<div onclick={handleContainerClick} class="markdown-root prose prose-invert max-w-none min-w-0
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

	/* Width hardening — nothing inside the markdown root may push the
	   chat container wider than its parent. The :global(.markdown-root)
	   layer forces a 0 min-width even when this component is rendered
	   inside a flex item that hasn't been given min-w-0 by its parent. */
	:global(.markdown-root) {
		min-width: 0;
		max-width: 100%;
	}

	/* Long single-token strings (URLs, IDs, paths) wrap inside paragraphs
	   and list items instead of forcing horizontal scroll. */
	div :global(p),
	div :global(li),
	div :global(blockquote),
	div :global(h1),
	div :global(h2),
	div :global(h3),
	div :global(h4),
	div :global(h5),
	div :global(h6) {
		overflow-wrap: anywhere;
	}

	/* Inline code: long IDs / URLs in backticks should wrap, not overflow. */
	div :global(code) {
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	/* Code blocks scroll INTERNALLY only — never push the parent wider. */
	div :global(pre) {
		scrollbar-width: thin;
		scrollbar-color: var(--color-border) transparent;
		max-width: 100%;
		min-width: 0;
		overflow-x: auto;
	}
	/* Override the inline-code wrap rule when the code is inside a <pre>:
	   preserve original formatting for genuine code, just scroll if needed. */
	div :global(pre > code) {
		overflow-wrap: normal;
		word-break: normal;
		white-space: pre;
	}

	/* Tables */
	div :global(.table-wrap) {
		overflow-x: auto;
		margin: 1rem 0;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: thin;
		scrollbar-color: var(--color-border) transparent;
		max-width: 100%;
		min-width: 0;
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
		max-width: 100%;
	}
	div :global(.mermaid-diagram svg) {
		max-width: 100%;
		height: auto;
		min-width: 0;
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

	/* ── Mermaid render error ───────────────────────────── */
	div :global(.mermaid-error) {
		margin: 1rem 0;
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
		font-size: 0.8125rem;
	}
	div :global(.mermaid-error-header) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-danger);
		font-weight: 600;
		margin-bottom: 0.375rem;
	}
	div :global(.mermaid-error-icon) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		background: var(--color-danger);
		color: var(--color-bg);
		font-size: 0.6875rem;
		line-height: 1;
	}
	div :global(.mermaid-error-message) {
		color: var(--color-text-muted);
		margin-bottom: 0.5rem;
		word-break: break-word;
	}
	div :global(.mermaid-error-source) {
		margin: 0;
		padding: 0.5rem 0.75rem;
		background: var(--color-bg-muted);
		border-radius: var(--radius-sm, 4px);
		font-size: 0.75rem;
		max-height: 240px;
		overflow: auto;
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
		color: var(--color-accent-text);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		flex-shrink: 0;
	}

	/* Per-type leading icon in the pill row (frame/doc/grid/flow). */
	div :global(.artifact-type-icon) {
		display: inline-flex;
		align-items: center;
		color: var(--color-accent-text);
		line-height: 0;
		flex-shrink: 0;
	}

	/* Artifact name — takes the remaining width and truncates so a long
	   title never blows out the collapsed pill. */
	div :global(.artifact-title) {
		font-size: 0.75rem;
		color: var(--color-text);
		font-weight: 500;
		margin-right: auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Chevron: the universal expand affordance; rotates 90° when expanded. */
	/* A real <button> so the collapsed pill is keyboard-operable (Tab → focus,
	   Enter/Space → toggle via click delegation); reset native button chrome. */
	div :global(.artifact-chevron) {
		display: inline-flex;
		align-items: center;
		color: var(--color-text-subtle);
		line-height: 0;
		flex-shrink: 0;
		transition: transform 0.15s;
		background: none;
		border: none;
		padding: 0;
		margin: 0;
		cursor: pointer;
	}
	div :global(.artifact-chevron:hover) {
		color: var(--color-text);
	}
	div :global(.artifact-chevron:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 2px;
	}
	div :global(.artifact-container:not(.artifact-collapsed) .artifact-chevron) {
		transform: rotate(90deg);
	}

	/* Markdown artifacts: same container chrome as iframe artifacts, body is
	   inline rendered markdown when expanded. */
	div :global(.artifact-md) {
		background: var(--color-bg-subtle);
	}
	div :global(.artifact-md .artifact-toolbar) {
		border-bottom: 1px solid var(--color-border);
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

	div :global(.artifact-data) {
		background: var(--color-bg-subtle);
	}
	div :global(.artifact-data .artifact-toolbar) {
		border-bottom: 1px solid var(--color-border);
	}
	div :global(.artifact-data .artifact-label) {
		margin-right: 0;
	}
	div :global(.artifact-data-body) {
		margin: 0;
		padding: 0.75rem 1rem;
		max-height: 20rem;
		overflow: auto;
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre;
		color: var(--color-text-muted);
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
		background: var(--color-bg-elevated);
		color-scheme: light dark;
	}
	/* ── Collapsed pill (all types) ──────────────────────────
	   Every artifact renders inline first as a compact, clickable pill:
	   icon · TYPE · title · chevron. The body (iframe / markdown / data)
	   and the per-artifact action buttons only appear once expanded, so
	   the chat stream stays quiet and the full preview is one click away.
	   Expanding removes .artifact-collapsed → the container falls back to
	   the full bordered card. */
	div :global(.artifact-collapsed) {
		display: flex;
		width: fit-content;
		max-width: 100%;
		border-radius: 999px;
		background: var(--color-bg-subtle);
	}
	div :global(.artifact-collapsed .artifact-toolbar) {
		border-bottom: none;
		background: transparent;
		border-radius: 999px;
		min-width: 0;
		flex: 1;
	}
	div :global(.artifact-collapsed:hover) {
		border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
	}
	/* Hide the body + the action buttons while collapsed — only the
	   icon/type/title/chevron make up the pill. */
	div :global(.artifact-collapsed .artifact-frame),
	div :global(.artifact-collapsed .artifact-md-body),
	div :global(.artifact-collapsed .artifact-data-body) {
		display: none;
	}
	div :global(.artifact-collapsed .artifact-btn) {
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
		/* The container itself scrolls (sticky toolbar stays pinned) so a wide
		   artifact scaled-to-fit-width via transform on the frame drives THIS
		   scroll area — the scaled box is exactly the viewport width, so no
		   horizontal clipping, and a tall doc scrolls vertically. */
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		/* Clear the iOS status bar / Dynamic Island + home indicator — without
		   this the toolbar (and its close button) render UNDER the notch on
		   mobile and become unreachable ("no way back"). bg fills the inset. */
		background: var(--color-bg);
		padding-top: env(safe-area-inset-top, 0px);
		padding-bottom: env(safe-area-inset-bottom, 0px);
		padding-left: env(safe-area-inset-left, 0px);
		padding-right: env(safe-area-inset-right, 0px);
	}
	/* Keep the toolbar pinned + give the close button a real mobile tap target. */
	div :global(.artifact-fullscreen .artifact-toolbar) {
		position: sticky;
		top: 0;
		flex-shrink: 0;
	}
	div :global(.artifact-fullscreen .artifact-close-btn) {
		min-width: 2.5rem;
		min-height: 2.5rem;
	}
	div :global(.artifact-fullscreen .artifact-frame) {
		/* flex:none so the inline content-height (set by the resize handler) wins
		   and the CONTAINER scrolls, not the frame. width:100% by default; the
		   fit-to-width path overrides width + transform-scale. */
		flex: none;
		width: 100%;
	}
	div :global(.artifact-fullscreen .artifact-source-wrap) {
		flex: 1;
		height: auto;
		max-height: none;
	}
</style>
