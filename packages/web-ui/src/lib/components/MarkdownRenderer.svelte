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
</style>
