# @lynox-ai/web-ui

Svelte 5 component library and standalone web interface for [lynox](https://github.com/lynox-ai/lynox).

## Usage

### As a component library

```bash
npm install @lynox-ai/web-ui
```

```svelte
<script>
  import { ChatView, AppShell, ThreadList, configure } from '@lynox-ai/web-ui';
  import '@lynox-ai/web-ui/style';

  configure({ apiBase: '/api/engine' });
</script>

<AppShell>
  <ThreadList slot="sidebar" />
  <ChatView slot="main" />
</AppShell>
```

### As a standalone app

```bash
cd packages/web-ui
pnpm run dev        # Dev server (needs Engine running)
pnpm run build      # Build standalone SvelteKit app
```

## Exported components

AppShell, ChatView, ThreadList, CommandPalette, StatusBar, ContextPanel, MemoryView, HistoryView, KnowledgeGraphView, MemoryInsightsView, ArtifactsView, ArtifactsHub, WorkflowsView, WorkflowsHub, ActivityHub, KnowledgeHub, ContactsView, DataStoreView, FileBrowserView, TasksView, BackupsView, ApiStoreView, ConfigView, KeysView, IntegrationsView, SettingsIndex, MarkdownRenderer, ChangesetReview, ToastContainer.

## Stores

- `chat` — SSE streaming, thread resume, interleaved content blocks
- `threads` — Load, archive, delete, rename threads
- `artifacts` — Save, load, delete artifacts
- `context-panel` — Side panel state
- `toast` — Toast notifications

## Stack

SvelteKit 2 · Svelte 5 · Tailwind v4 · Shiki · Mermaid · Marked · DOMPurify

## License

[Elastic License 2.0](LICENSE)
