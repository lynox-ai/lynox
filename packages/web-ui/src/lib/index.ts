// Components
export { default as ChatView } from './components/ChatView.svelte';
export { default as AppShell } from './components/AppShell.svelte';
export { default as StatusBar } from './components/StatusBar.svelte';
export { default as ContextPanel } from './components/ContextPanel.svelte';
export { default as CommandPalette } from './components/CommandPalette.svelte';
export { default as MemoryView } from './components/MemoryView.svelte';
export { default as HistoryView } from './components/HistoryView.svelte';
export { default as SettingsIndex } from './components/SettingsIndex.svelte';
export { default as ConfigView } from './components/ConfigView.svelte';
export { default as KeysView } from './components/KeysView.svelte';
export { default as IntegrationsView } from './components/IntegrationsView.svelte';
export { default as KnowledgeGraphView } from './components/KnowledgeGraphView.svelte';
export { default as MemoryInsightsView } from './components/MemoryInsightsView.svelte';
export { default as ContactsView } from './components/ContactsView.svelte';
export { default as BackupsView } from './components/BackupsView.svelte';
export { default as ApiStoreView } from './components/ApiStoreView.svelte';
export { default as DataStoreView } from './components/DataStoreView.svelte';
export { default as FileBrowserView } from './components/FileBrowserView.svelte';
export { default as TasksView } from './components/TasksView.svelte';
export { default as ArtifactsView } from './components/ArtifactsView.svelte';
export { default as KnowledgeHub } from './components/KnowledgeHub.svelte';
export { default as ArtifactsHub } from './components/ArtifactsHub.svelte';
export { default as ActivityHub } from './components/ActivityHub.svelte';
export { default as WorkflowsView } from './components/WorkflowsView.svelte';
export { default as WorkflowsHub } from './components/WorkflowsHub.svelte';
export { default as MarkdownRenderer } from './components/MarkdownRenderer.svelte';
export { default as ChangesetReview } from './components/ChangesetReview.svelte';
export { default as ToastContainer } from './components/ToastContainer.svelte';
export { default as MobileAccess } from './components/MobileAccess.svelte';

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
	clearError,
	getSessionModel,
	getContextWindow,
	getContextBudget,
	getSessionId,
	resumeThread,
	submitChangesetReview,
	getPendingChangeset,
	getChangesetLoading,
	getRetryStatus,
	getIsOffline,
} from './stores/chat.svelte.js';

export type {
	ChatMessage,
	ToolCallInfo,
	PipelineInfo,
	PipelineStepInfo,
	PermissionPrompt,
	FileAttachment,
	ContextBudget,
	ChangesetFileInfo,
} from './stores/chat.svelte.js';

// Thread store
export {
	loadThreads,
	archiveThread,
	unarchiveThread,
	deleteThread,
	renameThread,
	toggleFavorite,
	getThreads,
	getIsLoadingThreads,
	onActiveThreadRemoved,
} from './stores/threads.svelte.js';
export type { Thread } from './stores/threads.svelte.js';

// Artifact store
export {
	loadArtifacts,
	getArtifact,
	saveArtifact,
	deleteArtifact,
	getArtifacts,
	getIsLoadingArtifacts,
} from './stores/artifacts.svelte.js';
export type { Artifact, ArtifactMeta, ArtifactType } from './stores/artifacts.svelte.js';

// Context Panel
export { setContext, clearContext, getContext, closePanel } from './stores/context-panel.svelte.js';
export type { ContextType, ContextInfo } from './stores/context-panel.svelte.js';
