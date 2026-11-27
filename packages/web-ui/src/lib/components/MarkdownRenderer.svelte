<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { renderSanitizedMarkdown } from '../utils/markdown-render.js';
	import { codeToHtml } from 'shiki';
	import { goto } from '$app/navigation';
	import { trySaveArtifact, saveFailureText } from '../stores/artifacts.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import { withoutHidden } from '../stores/contained-way-out.js';
	import { getResolvedTheme, type ResolvedTheme } from '../stores/theme.svelte.js';
	import { fixMarkdownPreprocessing } from '../utils/markdown-preprocess.js';
	import { deckFrameHeight, buildArtifactBubbleFrame } from '../utils/artifact-frame.js';
	import { isChunkLoadError, triggerStaleReload } from '../utils/stale-reload.js';
	import { fenceHoldsOnlyPlaceholder, resolveArtifactRender, withPlaceholderBadge } from '../utils/artifact-inline.js';
	import { parseFences, type CodeFence } from '../utils/code-fences.js';
	import { OWN_ATTR, OWN_MARK, resolveOwnAction } from '../utils/markdown-actions.js';
	import { attachArtifactFrame, artifactFrameFor } from '../utils/artifact-frame-host.js';
	import { untrack } from 'svelte';
	import { saveOrShareBlob } from '../utils/save-blob.js';
	import { isIosSafari } from '../utils/ios-safari.js';
	import { mermaidConfig } from '../utils/mermaid-config.js';

	interface Props {
		content: string;
		/** When true, defer artifact iframe rendering (show code instead). */
		streaming?: boolean;
		/** The chat this renders in only reads: a copied text is on its way to a new chat. */
		containedChat?: boolean;
	}

	let { content, streaming = false, containedChat = false }: Props = $props();

	let highlightedHtml = $state('');

	const baseHtml = $derived(renderSanitizedMarkdown(content));

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
			mermaid.initialize(mermaidConfig(theme, mermaidVars(theme)));
			mermaidInitTheme = theme;
		}
		const id = `mermaid-${crypto.randomUUID().slice(0, 8)}`;
		const { svg } = await mermaid.render(id, code);
		const encoded = btoa(unescape(encodeURIComponent(code)));
		const btns = `<div class="diagram-actions">
			<button class="diagram-btn mermaid-save"${OWN_MARK} data-content="${encoded}" title="Save" type="button">${ICON_SAVE}</button>
			<button class="diagram-btn mermaid-export"${OWN_MARK} title="Export PNG" type="button">${ICON_DOWNLOAD}</button>
		</div>`;
		return `<div class="mermaid-diagram"${OWN_MARK}>${btns}${svg}</div>`;
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

	// Shown when the lazy `import('mermaid')` chunk 404s after a deploy — a
	// stale bundle, not a bad diagram. triggerStaleReload() normally navigates
	// away immediately; this card is what the user sees if the reload is
	// loop-guarded (chunk genuinely gone server-side).
	function buildMermaidReloading(): string {
		return `<div class="mermaid-error">
			<div class="mermaid-error-header">
				<span class="mermaid-error-icon">↻</span>
				<span class="mermaid-error-title">${escapeHtml(t('markdown.mermaid_reloading'))}</span>
			</div>
		</div>`;
	}

	// ── Artifacts ────────────────────────────────────────────

	function escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	function extractTitle(code: string): { title: string; clean: string } {
		// `<!-{2}` instead of `<!--` in these patterns: the same match, but a module parser that
		// reads `<!--` as the start of an HTML-like comment refuses the file (the component tests).
		const match = code.match(/<!-{2}\s*title:\s*(.+?)\s*-->/);
		if (match) return { title: match[1]!, clean: code.replace(match[0], '').trim() };
		const titleTag = code.match(/<title>(.+?)<\/title>/);
		if (titleTag) return { title: titleTag[1]!, clean: code };
		return { title: '', clean: code };
	}


	/** Detect whether an artifact fence body is explicitly typed as markdown. */
	function isMarkdownArtifact(code: string): boolean {
		return /<!-{2}\s*type:\s*markdown\s*-->/i.test(code);
	}

	/** Build a markdown-typed artifact: same collapsed-pill chrome as the iframe
	 *  variant (container + toolbar + label), but the body is rendered markdown,
	 *  not an iframe. Collapsed by default like every type (lazy-expand pill).
	 *  The raw markdown source is embedded as `data-md` so the toolbar
	 *  buttons can produce a .md download and a print-to-PDF popup from the
	 *  original text (not the rendered HTML). */
	function buildMarkdownArtifact(code: string, artifactId = ''): string {
		const { title, clean } = extractTitle(code);
		const body = clean.replace(/<!-{2}\s*type:\s*markdown\s*-->\s*/i, '').trim();
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);
		const rendered = DOMPurify.sanitize(marked.parse(fixMarkdownPreprocessing(body), { async: false }) as string);
		const encodedMd = btoa(unescape(encodeURIComponent(body)));
		const idAttr = artifactId ? ` data-artifact-id="${escapeHtml(artifactId)}"` : '';
		// No copy button: rendered markdown can still hide text that a copy would carry.
		const actions = artifactActionBtns(displayTitle, null);
		return `<div class="artifact-container artifact-md artifact-collapsed"${OWN_MARK} data-md="${encodedMd}" data-title="${safeTitle}" data-artifact-type="markdown"${idAttr}>
			<div class="artifact-toolbar"${OWN_MARK} data-action="toggle" style="cursor:pointer">
				<span class="artifact-type-icon">${artifactTypeIcon('markdown')}</span>
				<span class="artifact-label">Markdown</span>
				<span class="artifact-title">${safeTitle}</span>
				${actions}
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
		const m = code.match(/<!-{2}\s*type:\s*(csv|tsv|json|text)\s*-->/i);
		return m ? m[1]!.toLowerCase() : null;
	}

	/** How many lines of a data card the preview shows. */
	const DATA_PREVIEW_LINES = 60;

	/** Build a data-file artifact: a code preview plus a download button that
	 *  produces a real Blob with the right extension and MIME type. The full
	 *  body is embedded as `data-raw` so the download is the exact file, not
	 *  the truncated preview. */
	function buildDataArtifact(code: string, type: string, artifactId = ''): string {
		const meta = DATA_ARTIFACT_META[type] ?? DATA_ARTIFACT_META['text']!;
		const { title, clean } = extractTitle(code);
		// Anchored: only strip the leading marker we ourselves prepended, never
		// a literal `<!-- type: … -->` that happens to sit inside the data.
		const body = clean.replace(/^<!-{2}\s*type:\s*\w+\s*-->\s*/i, '').trim();
		const displayTitle = title || 'Data';
		const safeTitle = escapeHtml(displayTitle);
		const encodedRaw = btoa(unescape(encodeURIComponent(body)));
		const lines = body.split('\n');
		const preview = escapeHtml(lines.slice(0, DATA_PREVIEW_LINES).join('\n')) + (lines.length > DATA_PREVIEW_LINES ? '\n…' : '');
		const idAttr = artifactId ? ` data-artifact-id="${escapeHtml(artifactId)}"` : '';
		// The button copies the whole file; when the preview shows less, the button says how much.
		const more = lines.length > DATA_PREVIEW_LINES;
		// A file of nothing but invisible characters gets no button: there would be nothing to copy.
		const actions = artifactActionBtns(displayTitle, withoutHidden(body).text.trim() !== '' ? { lines: more ? lines.length : null } : null);
		const moreLine = more
			? `<p class="artifact-data-more">${escapeHtml(tf('artifacts.lines_shown', { shown: String(DATA_PREVIEW_LINES), n: String(lines.length) }))}</p>`
			: '';
		return `<div class="artifact-container artifact-data artifact-collapsed"${OWN_MARK} data-raw="${encodedRaw}" data-ext="${meta.ext}" data-mime="${meta.mime}" data-title="${safeTitle}" data-artifact-type="${type}"${idAttr}>
			<div class="artifact-toolbar"${OWN_MARK} data-action="toggle" style="cursor:pointer">
				<span class="artifact-type-icon">${artifactTypeIcon(type)}</span>
				<span class="artifact-label">${meta.label}</span>
				<span class="artifact-title">${safeTitle}</span>
				${actions}
			</div>
			<pre class="artifact-data-body"><code>${preview}</code></pre>
			${moreLine}
		</div>`;
	}

	/** An artifact card's markup, and for an HTML artifact the document its frame shows. */
	interface BuiltArtifact {
		readonly markup: string;
		readonly frame: string | null;
	}

	function buildArtifact(code: string): BuiltArtifact {
		// The gallery's badge ("Content missing"): for a card from a save, the store's flag the
		// chat wrote into the fence; for a fence the model wrote, the store's rule on its text.
		// Only the card's markup carries it; the frame document is the card's as built.
		const built = buildArtifactCard(code);
		return fenceHoldsOnlyPlaceholder(code)
			? { markup: withPlaceholderBadge(built.markup, t('artifacts.lost_badge')), frame: built.frame }
			: built;
	}

	function buildArtifactCard(code: string): BuiltArtifact {
		// The inline card threads the already-saved gallery id in as a marker.
		// Pull it out and strip it from the body so it can't leak into the
		// rendered prose / data preview, then hand it to the builder so the pill
		// links to the existing entry instead of re-saving a duplicate.
		const { artifactId, src } = resolveArtifactRender(code);
		if (isMarkdownArtifact(src)) return { markup: buildMarkdownArtifact(src, artifactId), frame: null };
		const dataType = artifactDataType(src);
		if (dataType) return { markup: buildDataArtifact(src, dataType, artifactId), frame: null };
		const { title, clean } = extractTitle(src);
		// PRD-LIGHT-MODE PR 2a — the frame document runs on the sandboxed frame
		// endpoint; CSS-vars from parent don't inherit into it. Read the theme at
		// render time and inject matching styles. Theme-flip clears richCache and
		// frameCache (downstream $effect on getResolvedTheme), so the frame
		// document is rebuilt and gets a new frame element.
		// ⚠ NOTHING about the frame's head is composed here any more — not the
		// policy, not the viewport, not the default colours or the overflow fix.
		// A mutation round emptied the head string this used to build and nothing
		// failed, because the only pin available at a component call site is a
		// spelling. `buildArtifactBubbleFrame` owns the whole head and is
		// exported, so the same mutation dies on a behavioural assertion.
		//
		// The theme is the one thing that module cannot know. It is a value, not
		// a concern that can be dropped. `utils/artifact-frame.ts` holds the
		// measurement and the reason.
		const fullHtml = buildArtifactBubbleFrame(clean, getResolvedTheme(), RESIZE_CODE);
		// `data-html` is for the share and download actions only. The frame never reads it: its
		// document comes from memory (`frameCache`), because message markup can carry a
		// `data-html` of its own.
		const encoded = btoa(unescape(encodeURIComponent(fullHtml)));
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);
		// No copy button: what the frame shows cannot be read from the source (a stylesheet can hide
		// text, a script can replace it), so a copy could carry text the user never saw.
		const actions = artifactActionBtns(displayTitle, null);
		const typeMatch = src.match(/<!-{2}\s*type:\s*([a-z]+)\s*-->/i);
		const typeKey = typeMatch ? typeMatch[1]!.toLowerCase() : 'html';
		const typeLabel = typeKey.toUpperCase();
		const idAttr = artifactId ? ` data-artifact-id="${escapeHtml(artifactId)}"` : '';

		// The frame itself is not markup: the slot below is filled after the render by
		// `attachFrames`, with a frame on the sandboxed endpoint. The slot carries OWN_MARK,
		// which the sanitizer strips from message markup, so a message cannot forge one.
		const markup = `<div class="artifact-container artifact-collapsed"${OWN_MARK} data-html="${encoded}" data-title="${safeTitle}" data-artifact-type="${typeKey}"${idAttr}>
			<div class="artifact-toolbar"${OWN_MARK} data-action="toggle" style="cursor:pointer">
				<span class="artifact-type-icon">${artifactTypeIcon(typeKey)}</span>
				<span class="artifact-label">${typeLabel}</span>
				<span class="artifact-title">${safeTitle}</span>
				${actions}
			</div>
			<div class="artifact-frame-slot"${OWN_MARK}></div>
		</div>`;
		return { markup, frame: fullHtml };
	}

	/** The copy button of a card: `null` for none, `lines` set when it copies more lines than the
	 *  card shows. */
	type CopyButton = { readonly lines: number | null } | null;

	/** The shared, minimal artifact-pill actions: expand → the coherent gallery
	 *  big-view (the ONE full view — renders every type incl. interactive HTML),
	 *  share/export the source file, and the collapse chevron. Full print +
	 *  download options live in the gallery view. On mobile the export button
	 *  uses the iOS share glyph (it opens the native share sheet). Every builder
	 *  (html/svg, markdown, data) uses this; only a data card adds the copy button. */
	function artifactActionBtns(title: string, copy: CopyButton): string {
		const shareIcon = isIosSafari() ? ICON_SHARE : ICON_DOWNLOAD;
		// The copy button names what it does in words, not only with an icon: it is the way to take
		// a text from lynox into a new chat, and a chat that only reads says to copy it first. It
		// shows on the closed card too, so the way out needs no opening.
		let copyBtn = '';
		if (copy) {
			const n = copy.lines === null ? null : String(copy.lines);
			const label = n === null ? t('artifacts.copy_text') : tf('artifacts.copy_lines', { n });
			const name = n === null ? tf('artifacts.copy_text_aria', { title }) : tf('artifacts.copy_lines_aria', { n, title });
			const linesAttr = n === null ? '' : ` data-lines="${n}"`;
			copyBtn = `<button type="button" class="artifact-btn artifact-copy"${OWN_MARK} data-action="copy"${linesAttr} aria-label="${escapeHtml(name)}">${ICON_COPY}<span class="artifact-copy-label">${escapeHtml(label)}</span></button>`;
		}
		return `${copyBtn}<button class="artifact-btn"${OWN_MARK} data-action="expand" title="Expand">${ICON_EXPAND}</button>
				<button class="artifact-btn"${OWN_MARK} data-action="share" title="Share">${shareIcon}</button>
				<button type="button" class="artifact-chevron" aria-label="${t('artifacts.toggle_preview')}" aria-expanded="false">${ICON_CHEVRON}</button>`;
	}

	// ── Icons ────────────────────────────────────────────────

	const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 10.5L4 6.5h3V2h2v4.5h3L8 10.5zM3 12.5h10v1H3v-1z" fill="currentColor"/></svg>`;
	// iOS-style share glyph (arrow rising out of a tray) — used on iOS where the
	// download buttons route through the native share sheet.
	const ICON_SHARE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 10V2M8 2L5.5 4.5M8 2l2.5 2.5M3.5 7.5H3a1 1 0 00-1 1V13a1 1 0 001 1h10a1 1 0 001-1V8.5a1 1 0 00-1-1h-.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_COPY = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>`;
	const ICON_EXPAND = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_SAVE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h8l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/><path d="M5 2v4h5V2M5 14v-4h6v4" stroke="currentColor" stroke-width="1.2"/></svg>`;
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
	// script written into the frame document carries a valid `\d`/`\b` regex literal.)
	/**
	 * The resize script's CODE, not a markup string. It is inserted as a
	 * `script` element's `textContent` (see `injectIntoArtifactFrame`), so the
	 * `</` + `script>` split that used to keep the surrounding markup from
	 * terminating early is no longer needed — and neither is a second copy of
	 * this code for the fragment case.
	 */
	const RESIZE_CODE = '(function(){var vu=null;function st(){var t="",i,s=document.getElementsByTagName("style");for(i=0;i<s.length;i++)t+=s[i].textContent||"";var e=document.querySelectorAll("[style]");for(i=0;i<e.length;i++)t+=e[i].getAttribute("style")||"";return t}function hasVU(){if(vu===null){try{vu=/(?:^|[^\\d.])100(?:vh|dvh|svh|lvh)\\b/i.test(st())}catch(x){vu=false}}return vu}function s(){var sh=document.documentElement.scrollHeight,vh=window.innerHeight||0,bw=document.body?document.body.scrollWidth:0;parent.postMessage({type:"lynox-resize",h:sh,w:Math.max(document.documentElement.scrollWidth,bw),deck:hasVU()&&vh>0&&sh<=vh+8},"*")}window.addEventListener("message",function(e){if(e.data==="lynox-measure")s()});window.addEventListener("load",function(){s();setTimeout(s,300);setTimeout(s,1500)});if(typeof ResizeObserver!=="undefined")new ResizeObserver(s).observe(document.documentElement);s()})()';

	// ── Event delegation ─────────────────────────────────────

	function handleContainerClick(e: MouseEvent) {
		// Only the controls this view built count: message markup can copy their classes and
		// `data-*`, but not their marker (see utils/markdown-actions.ts).
		const hit = resolveOwnAction(e.target as Element);
		if (!hit) return;

		if (hit.kind === 'mermaid-export') {
			exportMermaidPng(hit.diagram);
			return;
		}

		if (hit.kind === 'mermaid-save') {
			const encoded = hit.button.dataset['content'] ?? '';
			const mermaidCode = decodeURIComponent(escape(atob(encoded)));
			const title = prompt('Titel für dieses Diagramm:', 'Diagramm') ?? 'Diagramm';
			// The save never rejects; both outcomes are said, the placeholder refusal with its reason.
			void trySaveArtifact({ title, content: mermaidCode, type: 'mermaid' }).then(result => {
				if (result.artifact) addToast(t('artifacts.saved'), 'success');
				else addToast(saveFailureText(result, t('common.save_failed')), 'error');
			});
			return;
		}

		// Artifact toolbar toggle (collapsed → expanded with auto-height)
		const container = hit.container;
		if (hit.kind === 'toggle') {
			container.classList.toggle('artifact-collapsed');
			const expanded = !container.classList.contains('artifact-collapsed');
			rememberOpen(container, expanded);
			// Keep the chevron button's aria-expanded in sync for screen readers.
			container.querySelector('.artifact-chevron')?.setAttribute('aria-expanded', String(expanded));
			if (expanded) {
				// Delay so browser lays out the iframe before measuring
				requestAnimationFrame(() => resizeArtifactFrame(container));
			}
			return;
		}

		// Copying does not open the card: it takes the text and leaves the card as it is.
		if (hit.action === 'copy') { void handleCopyText(container, e.target as Element); return; }

		// Artifact toolbar actions. Auto-expand if collapsed.
		if (container.classList.contains('artifact-collapsed')) {
			container.classList.remove('artifact-collapsed');
			rememberOpen(container, true);
			requestAnimationFrame(() => resizeArtifactFrame(container));
		}
		if (hit.action === 'expand') void handleOpenBig(container);
		else if (hit.action === 'share') handleShare(container);
	}

	/** The ONE "big view" action: open the artifact in the full gallery view
	 *  (ArtifactsView renders every type incl. interactive HTML). A saved artifact
	 *  (has a gallery id) navigates straight there; an unsaved inline artifact is
	 *  saved first, then opened. Replaces the old in-app fullscreen + the separate
	 *  open-gallery/pin buttons with a single coherent full view. */
	async function handleOpenBig(container: HTMLElement) {
		const existingId = container.dataset['artifactId'];
		if (existingId) { await goto(`/app/artifacts?id=${encodeURIComponent(existingId)}`); return; }
		const title = container.dataset['title'] ?? 'Artifact';
		const type = (container.dataset['artifactType'] ?? 'html') as
			'html' | 'svg' | 'markdown' | 'mermaid' | 'csv' | 'tsv' | 'json' | 'text';
		const content = container.dataset['md'] !== undefined
			? decodeDataMd(container)
			: decodeB64(container.dataset['raw'] ?? container.dataset['html'] ?? '');
		if (!content) { addToast('Open failed', 'error'); return; }
		const result = await trySaveArtifact({ title, content, type });
		// The placeholder refusal is said as such; every other failure keeps the general text.
		if (!result.artifact) { addToast(saveFailureText(result, 'Open failed'), 'error'); return; }
		await goto(`/app/artifacts?id=${encodeURIComponent(result.artifact.id)}`);
	}

	/** The text a card's copy button takes: the file of a data card. Markdown and HTML cards have
	 *  no copy button. */
	function copyTextOf(container: HTMLElement): string {
		return container.dataset['raw'] !== undefined ? decodeB64(container.dataset['raw'] ?? '') : '';
	}

	async function handleCopyText(container: HTMLElement, target: Element) {
		// Only the button this view built: message markup can carry a `data-lines` of its own.
		const lines = target.closest(`[data-action="copy"][${OWN_ATTR}]`)?.getAttribute('data-lines') ?? null;
		const { text, removed } = withoutHidden(copyTextOf(container));
		try {
			if (!text) throw new Error('nothing to copy');
			await navigator.clipboard.writeText(text);
		} catch {
			addToast(t('common.copy_failed'), 'error', 4000);
			return;
		}
		const parts: string[] = [];
		if (lines !== null) parts.push(tf('artifacts.copied_lines', { n: lines }));
		else parts.push(removed || containedChat ? t('artifacts.copied') : t('common.copied'));
		if (removed) parts.push(t('artifacts.copy_removed_hidden'));
		// In a chat that only reads, the copied text is on its way to a new chat: say where it goes.
		if (containedChat) parts.push(t('artifacts.copy_paste_hint'));
		addToast(parts.join(' '), 'success', parts.length > 1 ? 4000 : 1500);
	}

	/** Quick export: share (mobile) / download (desktop) the artifact's SOURCE
	 *  file, dispatched by embedded data. Full print/download live in the gallery
	 *  big view. Reuses the iOS-aware download handlers (Web Share on iOS). */
	function handleShare(container: HTMLElement) {
		if (container.dataset['md'] !== undefined) handleMarkdownDownload(container);
		else if (container.dataset['raw'] !== undefined) handleDataDownload(container);
		else handleHtmlDownload(container);
	}

	/** Decode a base64 `data-*` payload (the inline artifact source). */
	function decodeB64(encoded: string): string {
		if (!encoded) return '';
		try { return decodeURIComponent(escape(atob(encoded))); }
		catch { return ''; }
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
		const filename = `${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')}.md` || 'artifact.md';
		void saveOrShareBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), filename);
	}

	/** Trigger a browser download of `content` as a file. */
	function downloadBlob(content: string, filename: string, mime: string) {
		void saveOrShareBlob(new Blob([content], { type: `${mime};charset=utf-8` }), filename);
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

	function exportMermaidPng(diagram: Element) {
		const svg = diagram.querySelector(':scope > svg') as SVGSVGElement | null;
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
			canvas.toBlob(blob => {
				if (!blob) { addToast('Export failed', 'error'); return; }
				void saveOrShareBlob(blob, `diagram-${Date.now()}.png`);
			}, 'image/png');
		};
		// An undecodable serialized SVG never fires onload — surface it instead of a dead click.
		img.onerror = () => addToast('Export failed', 'error');
		img.src = dataUrl;
	}

	/** Ask iframe to re-measure and post its height via postMessage */
	function resizeArtifactFrame(container: HTMLElement) {
		const iframe = container.querySelector('.artifact-frame') as HTMLIFrameElement | null;
		if (!iframe) return;
		try { iframe.contentWindow?.postMessage('lynox-measure', '*'); } catch { /* cross-origin safe */ }
	}

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
			// The frame is found by the message's source in the registry of frames the app
			// attached, never by a scan of the page, and only this view's own frames are sized.
			const iframe = artifactFrameFor(e.source);
			if (!iframe || !rootEl?.contains(iframe)) return;
			// Remember the content's intrinsic width so fullscreen can fit-to-width
			// a wide doc (e.g. an A4-print artifact) instead of clipping it.
			if (typeof w === 'number' && w > 0) {
				iframe.dataset['cw'] = String(w);
			}
			if (deck) {
				// 100vh slide-decks: size by 16:9 of the rendered width instead of
				// the collapsed scrollHeight (old Math.max(h,200) clamped to 200px).
				const deckW = iframe.clientWidth || iframe.getBoundingClientRect().width;
				iframe.style.height = `${deckFrameHeight(deckW, window.innerHeight)}px`;
			} else {
				iframe.style.height = `${Math.max(h, 200)}px`;
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
	/** The frame document of each cached HTML artifact, by the same key as `richCache`. */
	const frameCache = new Map<string, string>();

	/** A rich block (diagram, artifact, full HTML document) is cached by its language and code. */
	function richKey(f: CodeFence): string {
		return `${f.lang}:${f.code}`;
	}

	function isRich(f: CodeFence): boolean {
		return f.lang === 'mermaid' || f.lang === 'artifact'
			|| (f.lang === 'html' && (f.code.includes('<!DOCTYPE') || f.code.includes('<html')));
	}

	/** One render: the markup per fence, plus, in document order, the frame documents of its frame
	 *  slots and the keys of its artifact cards. */
	interface FenceRender {
		readonly results: string[];
		readonly frames: string[];
		readonly cards: string[];
	}

	/** What each fence becomes: a cached rich block, a placeholder while one is pending, or
	 *  highlighted code. Never rejects. */
	async function renderFences(fences: readonly CodeFence[]): Promise<FenceRender> {
		const frames: string[] = [];
		const cards: string[] = [];
		const seen = new Map<string, number>();
		// Collected in fence order, which is the order the slots and cards appear in the
		// rendered markup: the n-th slot gets the n-th frame document.
		for (const f of fences) {
			if (!isRich(f) || f.lang === 'mermaid') continue;
			const key = richKey(f);
			if (!richCache.has(key)) continue;
			const n = seen.get(key) ?? 0;
			seen.set(key, n + 1);
			cards.push(`${n}:${key}`);
			const frame = frameCache.get(key);
			if (frame !== undefined) frames.push(frame);
		}
		const results = await Promise.all(fences.map(async (f) => {
			if (isRich(f)) {
				const cached = richCache.get(richKey(f));
				if (cached) return cached;
				// Uncached during streaming → show placeholder instead of raw code
				return `<div class="artifact-placeholder"><span class="artifact-placeholder-dot"></span><span>${t('tool.artifact_creating')}</span></div>`;
			}
			try {
				const shikiTheme = getResolvedTheme() === 'light' ? 'github-light' : 'github-dark';
				return await codeToHtml(f.code, { lang: f.lang, theme: shikiTheme });
			} catch {
				// Unhighlighted, but still as text: the code is escaped, never parsed as markup.
				return `<pre><code class="language-${f.lang}">${escapeHtml(f.code)}</code></pre>`;
			}
		}));
		return { results, frames, cards };
	}

	// ── Frames and card state after each render ──────────────

	let rootEl = $state<HTMLDivElement | undefined>(undefined);
	/** Frame documents and card keys of the render that is on screen. */
	let shownFrames: readonly string[] = [];
	let shownCards: readonly string[] = [];
	/** The frames attached after the last render, by slot index. */
	let attached: { html: string; iframe: HTMLIFrameElement }[] = [];
	/** Cards the user opened, by card key: a re-render rebuilds the markup, the state stays. */
	const openCards = new Set<string>();
	/** Each render gets a number; a result is shown only if no later render started. */
	let renderSeq = 0;

	function ownCards(root: HTMLElement): HTMLElement[] {
		return Array.from(root.querySelectorAll<HTMLElement>(`.artifact-container[${OWN_ATTR}]`));
	}

	function rememberOpen(container: HTMLElement, open: boolean): void {
		if (!rootEl) return;
		const i = ownCards(rootEl).indexOf(container);
		const key = shownCards[i];
		if (key === undefined) return;
		if (open) openCards.add(key);
		else openCards.delete(key);
	}

	/**
	 * Put a frame into every slot of the render on screen and restore the cards' open state.
	 *
	 * The n-th slot carrying OWN_MARK gets the n-th frame document of the render. If the counts
	 * differ, something on the page is not what this view built, and no slot gets a frame.
	 *
	 * A slot whose document did not change gets its previous frame element back (it reloads on
	 * insertion, the browser gives a moved frame a new window). The previous frames are matched
	 * by their document, not by their position: when a block before it changes, a frame keeps
	 * its element even if its slot moved to another index. Equal documents are matched in the
	 * order they appear. A frame element only ever shows one document (`attachArtifactFrame`),
	 * so a slot with a new document gets a new element. That one starts at the last measured
	 * height of the frame that held the same position, if no other slot kept that frame, so a
	 * re-render (e.g. a theme flip, which changes every document) does not collapse the card to
	 * the default height.
	 */
	function attachFrames(root: HTMLElement): void {
		const slots = Array.from(root.querySelectorAll<HTMLElement>(`.artifact-frame-slot[${OWN_ATTR}]`));
		const frames = slots.length === shownFrames.length ? shownFrames : [];
		// The previous frames by document, in the order they appeared.
		const byHtml = new Map<string, { html: string; iframe: HTMLIFrameElement }[]>();
		for (const a of attached) {
			const list = byHtml.get(a.html);
			if (list) list.push(a);
			else byHtml.set(a.html, [a]);
		}
		// First pass: every slot whose document had a frame takes that frame back.
		const kept = new Map<number, { html: string; iframe: HTMLIFrameElement }>();
		const claimed = new Set<HTMLIFrameElement>();
		slots.forEach((_slot, i) => {
			const html = frames[i];
			if (html === undefined) return;
			const prev = byHtml.get(html)?.shift();
			if (!prev) return;
			kept.set(i, prev);
			claimed.add(prev.iframe);
		});
		const next: { html: string; iframe: HTMLIFrameElement }[] = [];
		slots.forEach((slot, i) => {
			const html = frames[i];
			if (html === undefined) return;
			const prev = kept.get(i);
			if (prev) {
				// Already in place: appending it again would reload it.
				if (prev.iframe.parentElement !== slot) slot.appendChild(prev.iframe);
				attachArtifactFrame(prev.iframe, html);
				next.push(prev);
				return;
			}
			const iframe = document.createElement('iframe');
			iframe.className = 'artifact-frame';
			iframe.setAttribute('sandbox', 'allow-scripts');
			iframe.setAttribute('scrolling', 'no');
			iframe.setAttribute('loading', 'lazy');
			const before = attached[i];
			if (before && !claimed.has(before.iframe)) {
				iframe.style.height = before.iframe.style.height;
				const cw = before.iframe.dataset['cw'];
				if (cw !== undefined) iframe.dataset['cw'] = cw;
			}
			slot.appendChild(iframe);
			attachArtifactFrame(iframe, html);
			next.push({ html, iframe });
		});
		// A render with no slots at all (the placeholders while a block is rebuilt, e.g. after a
		// theme flip) keeps the last frames, so the rebuilt ones can start at their height.
		if (slots.length > 0) attached = next;

		const cards = ownCards(root);
		if (cards.length !== shownCards.length) return;
		cards.forEach((card, i) => {
			const open = openCards.has(shownCards[i]!);
			card.classList.toggle('artifact-collapsed', !open);
			card.querySelector('.artifact-chevron')?.setAttribute('aria-expanded', String(open));
		});
	}

	// Runs after the DOM update of each render (a user effect runs after the template's).
	$effect(() => {
		void (highlightedHtml || baseHtml);
		const root = rootEl;
		if (!root) return;
		untrack(() => attachFrames(root));
	});

	function show(seq: number, html: string, r: FenceRender | null): void {
		if (seq !== renderSeq) return;
		shownFrames = r ? r.frames : [];
		shownCards = r ? r.cards : [];
		highlightedHtml = html;
	}

	/** The theme the cached blocks were built for. */
	let renderedTheme: ResolvedTheme | null = null;

	/*
	 * PRD-LIGHT-MODE PR 2a — theme-reactive re-render.
	 *
	 * Mermaid SVGs, Shiki-highlighted HTML, and artifact frame documents all bake the
	 * theme palette into their output. When the user toggles theme:
	 *   1. richCache.clear() drops cached SVGs + frame documents.
	 *   2. the fences are rendered again (theme is read via getResolvedTheme()).
	 *   3. highlightedHtml is reassigned, Svelte re-renders.
	 *
	 * Reading getResolvedTheme() inside the $effect tracks it as a dep, so
	 * the effect re-fires on theme change without any explicit subscription.
	 * The flip is compared with the theme the blocks were BUILT for, not with mermaid's: a
	 * message with an HTML artifact and no diagram has to re-render too.
	 */
	$effect(() => {
		const html = baseHtml;
		const theme = getResolvedTheme();
		// On theme change, clear caches so re-render picks up new palette.
		if (renderedTheme !== null && renderedTheme !== theme) {
			richCache.clear();
			frameCache.clear();
		}
		renderedTheme = theme;
		// Fences are found on the parsed fragment, never by a pattern over the sanitized string.
		const parsed = parseFences(html, document);
		const fences = parsed.fences;

		if (fences.length === 0) {
			show(++renderSeq, html, null);
			return;
		}

		// Immediate render — uses cached rich blocks or falls back to shiki. It can resolve
		// after the debounced render below; the render number keeps it from overwriting that.
		const immediate = ++renderSeq;
		void renderFences(fences).then((r) => {
			show(immediate, parsed.render(r.results), r);
		});

		// Debounce uncached rich blocks (prevents iframe flash during streaming)
		const uncached = fences.filter((f) => isRich(f) && !richCache.has(richKey(f)));
		// While streaming, keep iframe artifacts as syntax-highlighted code
		// to avoid flash. Markdown artifacts render live — no iframe, no flash.
		const workset = streaming
			? uncached.filter((f) => f.lang === 'artifact' && isMarkdownArtifact(f.code))
			: uncached;
		if (workset.length === 0) return;

		// Markdown artifacts render fast, without a debounce — the user
		// expects them to appear live during streaming. Iframe artifacts
		// keep the 400 ms debounce to coalesce late fence closings.
		const delay = workset.every((f) => f.lang === 'artifact' && isMarkdownArtifact(f.code)) ? 0 : 400;

		// run-group-starter: a browser render debounce, cleared by the effect's teardown.
		const timer = setTimeout(async () => {
			for (const f of workset) {
				const key = richKey(f);
				try {
					if (f.lang === 'mermaid') richCache.set(key, await renderMermaid(f.code));
					else {
						// artifact + html full docs
						const built = buildArtifact(f.code);
						if (built.frame !== null) frameCache.set(key, built.frame);
						richCache.set(key, built.markup);
					}
				} catch (err) {
					// Failed mermaid would otherwise show a perma-placeholder
					// because renderFences falls back to placeholder for any
					// uncached rich block. Cache an error block so the user
					// sees what happened and can copy the source.
					if (f.lang === 'mermaid') {
						if (isChunkLoadError(err)) {
							// A stale `import('mermaid')` chunk 404'd after a
							// deploy — recover by reloading onto the fresh bundle
							// instead of masking it as a diagram error. The global
							// vite:preloadError listener may already have fired;
							// triggerStaleReload is idempotent + loop-guarded.
							triggerStaleReload();
							richCache.set(key, buildMermaidReloading());
						} else {
							const message = err instanceof Error ? err.message : String(err);
							richCache.set(key, buildMermaidError(f.code, message));
						}
					}
				}
			}
			if (baseHtml === html) {
				const seq = ++renderSeq;
				const r = await renderFences(fences);
				show(seq, parsed.render(r.results), r);
			}
		}, delay);

		return () => clearTimeout(timer);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={rootEl} onclick={handleContainerClick} class="markdown-root prose prose-invert max-w-none min-w-0
	prose-pre:bg-bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-[var(--radius-md)] prose-pre:overflow-x-auto
	prose-code:text-accent-text prose-code:text-xs prose-code:font-mono
	prose-a:text-accent-text prose-a:underline prose-a:decoration-accent-text/40 prose-a:underline-offset-2 hover:prose-a:decoration-accent-text
	prose-headings:text-text prose-headings:font-medium prose-headings:tracking-tight
	prose-p:leading-relaxed prose-li:leading-relaxed
	prose-strong:text-text prose-strong:font-semibold">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- baseHtml: renderSanitizedMarkdown (marked, DOMPurify, then link and table wrapping on the sanitized DOM). highlightedHtml: baseHtml re-parsed into an inert template, each whole fence element replaced by markup this file builds (Shiki output, escaped code, mermaid SVG at mermaid's default strict level with its action buttons (static icons, base64 source), mermaid error and reloading cards (escaped message and source), artifact cards with escaped values, sanitized markdown or an empty frame slot that `attachFrames` fills with a frame on the sandboxed endpoint, static i18n strings), then serialized once (utils/code-fences.ts) -->
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

	/* "Content missing" next to the name, as in the gallery and the chips: the
	   saved file, or the fence the model wrote, holds only the engine's
	   placeholder. Never truncated, the name is.
	   The badge takes the name's auto margin, so it stays beside the name and
	   the buttons keep the right edge. */
	div :global(.artifact-title:has(+ .artifact-lost-badge)) {
		margin-right: 0;
	}
	div :global(.artifact-lost-badge) {
		font-size: 0.625rem;
		color: var(--color-warning);
		flex-shrink: 0;
		white-space: nowrap;
		margin-right: auto;
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
	div :global(.artifact-copy) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		line-height: 1;
		font-size: 0.75rem;
		padding: 0.25rem 0.5rem;
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
	div :global(.artifact-collapsed .artifact-data-body),
	div :global(.artifact-collapsed .artifact-data-more) {
		display: none;
	}
	/* The copy button stays on the closed card: the way out of a chat that only reads must be
	   found without opening the card. The pill may wrap at 390px for it. */
	div :global(.artifact-collapsed .artifact-btn:not(.artifact-copy)) {
		display: none;
	}
	div :global(.artifact-collapsed .artifact-toolbar) {
		flex-wrap: wrap;
	}
	div :global(.artifact-data-more) {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		padding: 0.25rem 0.75rem 0.5rem;
	}

	div :global(.hidden) {
		display: none !important;
	}

</style>
