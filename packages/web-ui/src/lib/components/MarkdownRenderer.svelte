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
	function fixSentenceSpacing(md: string): string {
		const parts = md.split(/(```[\s\S]*?```)/g);
		return parts.map((part, i) =>
			i % 2 === 0 ? part.replace(/([.!?])([A-ZÄÖÜ])/g, '$1\n\n$2') : part
		).join('');
	}

	const baseHtml = $derived(
		DOMPurify.sanitize(marked.parse(closeOpenFences(fixSentenceSpacing(content)), { async: false }) as string)
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

	const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src 'none'">`;

	function buildArtifact(code: string): string {
		const { title, clean } = extractTitle(code);
		const defaultStyles = `<style>body{background:#0a0a1a;color:#e8e8f0;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1rem}*{box-sizing:border-box}</style>`;
		const overflowFix = `<style>html,body{overflow:hidden!important;max-width:100vw}</style>`;
		let fullHtml: string;
		if (clean.includes('<html')) {
			fullHtml = clean.replace(/<head[^>]*>/, `$&${CSP_META}${overflowFix}`);
		} else {
			fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${CSP_META}${defaultStyles}${overflowFix}</head><body>${clean}</body></html>`;
		}
		const encoded = btoa(unescape(encodeURIComponent(fullHtml)));
		const escaped = fullHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);

		return `<div class="artifact-container artifact-collapsed" data-html="${encoded}" data-title="${safeTitle}">
			<div class="artifact-toolbar" data-action="toggle" style="cursor:pointer">
				<span class="artifact-label">${safeTitle}</span>
				<span class="artifact-toggle-hint">Click to open</span>
				<button class="artifact-btn" data-action="screenshot" title="Copy as image">${ICON_CAMERA}</button>
				<button class="artifact-btn" data-action="expand" title="Fullscreen">${ICON_EXPAND}</button>
				<button class="artifact-btn artifact-close-btn" data-action="close" title="Close">${ICON_CLOSE}</button>
				<button class="artifact-btn" data-action="pin" title="Pin to Artifacts">${ICON_SAVE}</button>
				<button class="artifact-btn" data-action="export" title="Download HTML">${ICON_DOWNLOAD}</button>
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
	const ICON_CAMERA = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 5.5A1.5 1.5 0 013.5 4h1.17a1 1 0 00.83-.45l.67-1.1A1 1 0 017 2h2a1 1 0 01.83.45l.67 1.1a1 1 0 00.83.45h1.17A1.5 1.5 0 0114 5.5v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-6z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8.5" r="2" stroke="currentColor" stroke-width="1.3"/></svg>`;
	const ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

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
					resizeArtifactFrame(container);
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
				resizeArtifactFrame(container);
			}

			if (action === 'pin') handleArtifactSave(container);
			else if (action === 'screenshot') handleArtifactScreenshot(container);
			else if (action === 'source') handleArtifactSource(container);
			else if (action === 'expand') handleArtifactExpand(container);
			else if (action === 'close') handleArtifactExpand(container);
			else if (action === 'export') handleArtifactExport(container);
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

	/** Resize iframe to show full content — no scrollbars */
	function resizeArtifactFrame(container: HTMLElement) {
		const iframe = container.querySelector('.artifact-frame') as HTMLIFrameElement | null;
		if (!iframe) return;
		const measure = () => {
			try {
				const doc = iframe.contentDocument;
				if (!doc?.body) return;
				doc.documentElement.style.setProperty('overflow', 'hidden', 'important');
				doc.body.style.setProperty('overflow', 'hidden', 'important');
				const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
				if (h > 0) iframe.style.height = `${h}px`;
			} catch {
				iframe.style.height = '420px';
			}
		};
		const onLoad = () => {
			measure();
			// Re-measure after async scripts (Chart.js, images, fonts)
			setTimeout(measure, 300);
			setTimeout(measure, 800);
			setTimeout(measure, 1500);
		};
		if (iframe.contentDocument?.readyState === 'complete') {
			onLoad();
		} else {
			iframe.addEventListener('load', onLoad, { once: true });
		}
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

	function handleArtifactExport(container: HTMLElement) {
		const encoded = container.dataset['html'] ?? '';
		const html = decodeURIComponent(escape(atob(encoded)));
		const blob = new Blob([html], { type: 'text/html' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `artifact-${Date.now()}.html`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function handleArtifactScreenshot(container: HTMLElement) {
		// Render artifact HTML in a temporary unsandboxed iframe for html2canvas
		const encoded = container.dataset['html'] ?? '';
		if (!encoded) return;
		const html = decodeURIComponent(escape(atob(encoded)));

		const tmp = document.createElement('iframe');
		tmp.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:600px;border:none';
		document.body.appendChild(tmp);

		try {
			const doc = tmp.contentDocument;
			if (!doc) { addToast('Screenshot failed', 'error'); return; }
			doc.open();
			doc.write(html);
			doc.close();

			// Wait for content to render
			await new Promise(r => setTimeout(r, 500));

			const { default: html2canvas } = await import('html2canvas');
			const canvas = await html2canvas(doc.body, {
				backgroundColor: '#0a0a1a',
				scale: 2,
				useCORS: true,
				width: 800,
			});

			canvas.toBlob(blob => {
				if (!blob) return;
				navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
					addToast('Screenshot copied', 'success');
				}).catch(() => {
					const a = document.createElement('a');
					a.href = URL.createObjectURL(blob);
					a.download = `artifact-${Date.now()}.png`;
					a.click();
					URL.revokeObjectURL(a.href);
				});
			}, 'image/png');
		} catch {
			addToast('Screenshot failed', 'error');
		} finally {
			document.body.removeChild(tmp);
		}
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
					// Uncached → show as syntax-highlighted code while waiting
					try {
						return { original: match[0], result: await codeToHtml(code, { lang: 'html', theme: 'github-dark' }) };
					} catch {
						return { original: match[0], result: match[0] };
					}
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
		// While streaming, keep artifacts as syntax-highlighted code (no iframe)
		if (uncached.length === 0 || streaming) return;

		const timer = setTimeout(async () => {
			for (const match of uncached) {
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
		}, 400);

		return () => clearTimeout(timer);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div onclick={handleContainerClick} class="prose prose-invert prose-sm max-w-none
	prose-pre:bg-bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-[var(--radius-md)] prose-pre:overflow-x-auto
	prose-code:text-accent-text prose-code:text-xs prose-code:font-mono
	prose-a:text-accent-text prose-a:no-underline hover:prose-a:opacity-80
	prose-headings:text-text prose-headings:font-light prose-headings:tracking-tight
	prose-p:leading-relaxed prose-li:leading-relaxed
	prose-strong:text-text">
	{@html highlightedHtml || baseHtml}
</div>

<style>
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
	div :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
		margin: 1rem 0;
	}
	div :global(th) {
		text-align: left;
		font-weight: 600;
		color: var(--color-text);
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	div :global(td) {
		padding: 0.4rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-muted);
	}
	div :global(tr:last-child td) {
		border-bottom: none;
	}
	div :global(tr:hover td) {
		background-color: var(--color-bg-subtle);
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
	}
	div :global(ol) {
		list-style-type: decimal;
		padding-left: 1.5rem;
	}
	div :global(li) {
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
		overflow: hidden;
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
