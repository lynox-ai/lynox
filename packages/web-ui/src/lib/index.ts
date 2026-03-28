// Components
export { default as ChatView } from './components/ChatView.svelte';
export { default as AppShell } from './components/AppShell.svelte';
export { default as StatusBar } from './components/StatusBar.svelte';
export { default as ContextPanel } from './components/ContextPanel.svelte';
export { default as CommandPalette } from './components/CommandPalette.svelte';
/** @deprecated Use AppShell instead */
export { default as AppLayout } from './components/AppLayout.svelte';
export { default as MemoryView } from './components/MemoryView.svelte';
export { default as HistoryView } from './components/HistoryView.svelte';
export { default as SettingsIndex } from './components/SettingsIndex.svelte';
export { default as ConfigView } from './components/ConfigView.svelte';
export { default as KeysView } from './components/KeysView.svelte';
export { default as IntegrationsView } from './components/IntegrationsView.svelte';
export { default as KnowledgeGraphView } from './components/KnowledgeGraphView.svelte';
export { default as ContactsView } from './components/ContactsView.svelte';
export { default as BackupsView } from './components/BackupsView.svelte';
export { default as ApiStoreView } from './components/ApiStoreView.svelte';
export { default as DataStoreView } from './components/DataStoreView.svelte';
export { default as FileBrowserView } from './components/FileBrowserView.svelte';
export { default as TasksView } from './components/TasksView.svelte';
export { default as MarkdownRenderer } from './components/MarkdownRenderer.svelte';
export { default as ToastContainer } from './components/ToastContainer.svelte';

// Toast
export { addToast, getToasts } from './stores/toast.svelte.js';
export type { Toast } from './stores/toast.svelte.js';

// Config
export { configure, getApiBase } from './config.svelte.js';

// i18n
export { t, setLocale, getLocale, initLocale } from './i18n.svelte.js';
export type { Locale } from './i18n.svelte.js';

// Chat store
export {
	sendMessage,
	abortRun,
	replyPermission,
	newChat,
	downloadExport,
	exportAsMarkdown,
	exportAsJSON,
	getMessages,
	getIsStreaming,
	getPendingPermission,
	getChatError,
	clearError
} from './stores/chat.svelte.js';

export type {
	ChatMessage,
	ToolCallInfo,
	PermissionPrompt,
	FileAttachment
} from './stores/chat.svelte.js';

// Context Panel
export { setContext, clearContext, getContext, closePanel } from './stores/context-panel.svelte.js';
export type { ContextType, ContextInfo } from './stores/context-panel.svelte.js';
