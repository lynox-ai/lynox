<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { codeToHtml } from 'shiki';
	import { saveArtifact } from '../stores/artifacts.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { t } from '../i18n.svelte.js';

	let { content }: { content: string } = $props();

	let highlightedHtml = $state('');

	const baseHtml = $derived(
		DOMPurify.sanitize(marked.parse(content, { async: false }) as string)
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
		let fullHtml: string;
		if (clean.includes('<html')) {
			fullHtml = clean.replace(/<head[^>]*>/, `$&${CSP_META}`);
		} else {
			fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${CSP_META}${defaultStyles}</head><body>${clean}</body></html>`;
		}
		const encoded = btoa(unescape(encodeURIComponent(fullHtml)));
		const escaped = fullHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		const displayTitle = title || 'Artifact';
		const safeTitle = escapeHtml(displayTitle);

		return `<div class="artifact-container" data-html="${encoded}" data-title="${safeTitle}">
			<div class="artifact-toolbar">
				<span class="artifact-label">${safeTitle}</span>
				<button class="artifact-btn" data-action="save" title="Save">${ICON_SAVE}</button>
				<button class="artifact-btn" data-action="source" title="Source">${ICON_CODE}</button>
				<button class="artifact-btn" data-action="expand" title="Fullscreen">${ICON_EXPAND}</button>
				<button class="artifact-btn" data-action="export" title="Export HTML">${ICON_DOWNLOAD}</button>
			</div>
			<iframe class="artifact-frame" srcdoc="${escaped}" sandbox="allow-scripts" loading="lazy"></iframe>
			<div class="artifact-source-wrap hidden"></div>
		</div>`;
	}

	// ── Icons ────────────────────────────────────────────────

	const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 10.5L4 6.5h3V2h2v4.5h3L8 10.5zM3 12.5h10v1H3v-1z" fill="currentColor"/></svg>`;
	const ICON_CODE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_EXPAND = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const ICON_SAVE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h8l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/><path d="M5 2v4h5V2M5 14v-4h6v4" stroke="currentColor" stroke-width="1.2"/></svg>`;

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

		// Artifact toolbar actions
		const artifactBtn = target.closest('.artifact-btn') as HTMLElement | null;
		if (artifactBtn) {
			const action = artifactBtn.dataset['action'];
			const container = artifactBtn.closest('.artifact-container') as HTMLElement;
			if (!container) return;

			if (action === 'save') handleArtifactSave(container);
			else if (action === 'source') handleArtifactSource(container);
			else if (action === 'expand') handleArtifactExpand(container);
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

	function handleArtifactSave(container: HTMLElement) {
		const encoded = container.dataset['html'] ?? '';
		const html = decodeURIComponent(escape(atob(encoded)));
		const defaultTitle = container.dataset['title'] ?? 'Artifact';
		const title = prompt('Titel:', defaultTitle) ?? defaultTitle;
		saveArtifact({ title, content: html, type: 'html' }).then(result => {
			if (result) addToast(t('artifacts.saved'), 'success');
		});
	}

	// ── Code block processing ────────────────────────────────

	$effect(() => {
		const codeBlockRegex = /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g;
		let html = baseHtml;
		const matches = [...html.matchAll(codeBlockRegex)];

		if (matches.length === 0) {
			highlightedHtml = html;
			return;
		}

		Promise.all(
			matches.map(async (match) => {
				const lang = match[1] ?? 'text';
				const code = decodeEntities(match[2] ?? '');

				if (lang === 'mermaid') {
					try {
						return { original: match[0], result: await renderMermaid(code) };
					} catch {
						return { original: match[0], result: match[0] };
					}
				}

				if (lang === 'artifact') {
					return { original: match[0], result: buildArtifact(code) };
				}

				try {
					return { original: match[0], result: await codeToHtml(code, { lang, theme: 'github-dark' }) };
				} catch {
					return { original: match[0], result: match[0] };
				}
			})
		).then((results) => {
			let result = html;
			for (const { original, result: replacement } of results) {
				if (original) result = result.replace(original, replacement);
			}
			highlightedHtml = result;
		});
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
		background: var(--color-bg-muted);
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
		height: 420px;
		border: none;
		display: block;
		background: #0a0a1a;
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
	}
	div :global(.artifact-fullscreen .artifact-source-wrap) {
		flex: 1;
		height: auto;
		max-height: none;
	}
</style>
