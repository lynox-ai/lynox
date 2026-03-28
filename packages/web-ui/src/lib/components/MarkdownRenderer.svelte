<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { codeToHtml } from 'shiki';

	let { content }: { content: string } = $props();

	// Custom renderer for code blocks with Shiki
	const renderer = new marked.Renderer();
	const originalCode = renderer.code;

	// Shiki is async — highlight after initial render
	let highlightedHtml = $state('');

	const baseHtml = $derived(
		DOMPurify.sanitize(marked.parse(content, { async: false }) as string)
	);

	$effect(() => {
		// Find code blocks and highlight them with Shiki
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
				const code = match[2]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') ?? '';
				try {
					return { original: match[0], highlighted: await codeToHtml(code, { lang, theme: 'github-dark' }) };
				} catch {
					return { original: match[0], highlighted: match[0] };
				}
			})
		).then((results) => {
			let result = html;
			for (const { original, highlighted } of results) {
				if (original) result = result.replace(original, highlighted);
			}
			highlightedHtml = result;
		});
	});
</script>

<div class="prose prose-invert prose-sm max-w-none
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
</style>
