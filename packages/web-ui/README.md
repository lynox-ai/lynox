# @lynox-ai/web-ui

Svelte 5 component library and standalone web interface for [lynox](https://github.com/lynox-ai/lynox).

## Usage

### As a component library

```bash
npm install @lynox-ai/web-ui
```

```svelte
<script>
  import { ChatView, configure } from '@lynox-ai/web-ui';
  import '@lynox-ai/web-ui/style';

  configure({ apiBase: '/api/engine' });
</script>

<ChatView />
```

`AppShell` is the full multi-pane layout used by the standalone app. It uses Svelte 5 snippets (not named slots) for its slots — see `packages/web-ui/src/routes/+layout.svelte` in the lynox repo for a working composition.

### As a standalone app

```bash
cd packages/web-ui
pnpm run dev        # Dev server (needs Engine running)
pnpm run build      # Build standalone SvelteKit app
```

## Exported components

Entry points: `ChatView`, `AppShell`, `SettingsIndex`, `ChannelHub`, `IntelligenceHub`, `AutomationHub`, `InboxView`.

Settings views: `LLMSettings`, `VoiceSettings`, `PrivacyDataSettings`, `SystemSettings`, `MailSettings`, `GoogleSettings`, `NotificationsSettings`, `SearchSettings`, `WorkspaceSecurityView`, `WorkspaceUpdatesView`, `WorkspaceLimitsView`, `KeysView`, `SecretsView`.

Domain views: `KnowledgeGraphView`, `MemoryInsightsView`, `MemoryView`, `HistoryView`, `ContactsView`, `BackupsView`, `ApiStoreView`, `DataStoreView`, `FileBrowserView`, `TasksView`, `ArtifactsView`, `ArtifactsHub`, `WorkflowsView`, `ActivityHub`, `ActivityOverview`, `RulesView`, `MigrationWizard`.

UI: `CommandPalette`, `StatusBar`, `ContextPanel`, `MarkdownRenderer`, `ChangesetReview`, `ToastContainer`, `MobileAccess`, `ColdStartBanner`, `KeyboardShortcutsHelp`, `PromptAnchor`, `StreamingActivityBar`, `ToolToggles`.

Primitives: `Checkbox`, `Icon` (+ `IconName` type).

For the authoritative list, see [`packages/web-ui/src/lib/index.ts`](https://github.com/lynox-ai/lynox/blob/main/packages/web-ui/src/lib/index.ts) in the repo.

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
