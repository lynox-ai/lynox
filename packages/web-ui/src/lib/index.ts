// Components
export { default as ChatView } from './components/ChatView.svelte';
export { default as AppShell } from './components/AppShell.svelte';
export { default as StatusBar } from './components/StatusBar.svelte';
export { default as ContextPanel } from './components/ContextPanel.svelte';
export { default as CommandPalette } from './components/CommandPalette.svelte';
export { default as MemoryView } from './components/MemoryView.svelte';
export { default as HistoryView } from './components/HistoryView.svelte';
export { default as SettingsIndex } from './components/SettingsIndex.svelte';
// ConfigView deleted PRD-IA-V2 P1-PR-A2 — settings live in LLMSettings /
// VoiceSettings / PrivacyDataSettings / SystemSettings (extracted in V1).
// `/settings/config` now 301-redirects to the appropriate extracted page.
export { default as KeysView } from './components/KeysView.svelte';
export { default as SecretsView } from './components/SecretsView.svelte';
// PRD-IA-V2 P3-PR-A2 — `IntegrationsView` retired. The monolithic settings
// page is gone; per-channel sub-pages live at `/app/settings/channels/*`. The
// library export name stays as an alias to `ChannelHub` so any downstream
// consumer (pro/pwa) that still imports `IntegrationsView` keeps rendering
// the hub instead of a missing-component error.
export { default as ChannelHub } from './components/ChannelHub.svelte';
export { default as IntegrationsView } from './components/ChannelHub.svelte';
export { default as MailSettings } from './components/MailSettings.svelte';
export { default as WhatsAppSettings } from './components/WhatsAppSettings.svelte';
export { default as GoogleSettings } from './components/GoogleSettings.svelte';
export { default as NotificationsSettings } from './components/NotificationsSettings.svelte';
export { default as SearchSettings } from './components/SearchSettings.svelte';
export { default as KnowledgeGraphView } from './components/KnowledgeGraphView.svelte';
export { default as MemoryInsightsView } from './components/MemoryInsightsView.svelte';
export { default as ContactsView } from './components/ContactsView.svelte';
export { default as BackupsView } from './components/BackupsView.svelte';
export { default as ApiStoreView } from './components/ApiStoreView.svelte';
export { default as DataStoreView } from './components/DataStoreView.svelte';
export { default as FileBrowserView } from './components/FileBrowserView.svelte';
export { default as TasksView } from './components/TasksView.svelte';
export { default as ArtifactsView } from './components/ArtifactsView.svelte';
export { default as IntelligenceHub } from './components/IntelligenceHub.svelte';
export { default as ArtifactsHub } from './components/ArtifactsHub.svelte';
export { default as ActivityHub } from './components/ActivityHub.svelte';
export { default as ActivityOverview } from './components/ActivityOverview.svelte';
export { default as WorkflowsView } from './components/WorkflowsView.svelte';
export { default as AutomationHub } from './components/AutomationHub.svelte';
export { default as ToolToggles } from './components/ToolToggles.svelte';
export { default as VoiceSettings } from './components/VoiceSettings.svelte';
export { default as PrivacyDataSettings } from './components/PrivacyDataSettings.svelte';
export { default as SystemSettings } from './components/SystemSettings.svelte';
// PRD-IA-V2 P3-PR-B — Workspace & System section components (Self-Host only).
export { default as WorkspaceSecurityView } from './components/WorkspaceSecurityView.svelte';
export { default as WorkspaceUpdatesView } from './components/WorkspaceUpdatesView.svelte';
export { default as WorkspaceLimitsView } from './components/WorkspaceLimitsView.svelte';
export { default as LLMSettings } from './components/LLMSettings.svelte';
// CostLimits deleted PRD-IA-V2 P3-PR-X — settings moved: spend-limits +
// HTTP-cap → WorkspaceLimitsView (`/settings/workspace/limits`),
// context-window → LLMAdvancedView (`/settings/llm/advanced`). Legacy URL
// `/app/hub/cost-limits` now 301-redirects to `/settings/workspace/limits`.
export { default as MarkdownRenderer } from './components/MarkdownRenderer.svelte';
export { default as ChangesetReview } from './components/ChangesetReview.svelte';
export { default as ToastContainer } from './components/ToastContainer.svelte';
export { default as MobileAccess } from './components/MobileAccess.svelte';
export { default as MigrationWizard } from './components/MigrationWizard.svelte';
export { default as PromptAnchor } from './components/PromptAnchor.svelte';
export { default as StreamingActivityBar } from './components/StreamingActivityBar.svelte';
export { default as InboxView } from './components/InboxView.svelte';
export { default as ColdStartBanner } from './components/ColdStartBanner.svelte';
export { default as KeyboardShortcutsHelp } from './components/KeyboardShortcutsHelp.svelte';
export { default as RulesView } from './components/RulesView.svelte';

// Design-system primitives
export { default as Checkbox } from './primitives/Checkbox.svelte';
export { default as Icon } from './primitives/Icon.svelte';
export type { IconName } from './primitives/icons.js';

// Toast
export { addToast, getToasts } from './stores/toast.svelte.js';
export type { Toast } from './stores/toast.svelte.js';

// Config
export { configure, getApiBase, getPipelineStatusV2 } from './config.svelte.js';

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
	getPendingPrompt,
	getRunStartedAt,
	getRunPromptCount,
	getChatError,
	getAuthError,
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
	getSkipExtraction,
	toggleSkipExtraction,
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
	RunOptions,
	PendingPromptHead,
	PromptKind,
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

// Voice auto-send
export { isVoiceAutoSendEnabled, toggleVoiceAutoSend } from './stores/voice-autosend.svelte.js';

// Inbox store (Phase 1b)
export {
	loadInboxCounts,
	loadInboxItems,
	setItemAction,
	setItemSnooze,
	loadItemAudit,
	getInboxCounts,
	getInboxItems,
	isInboxAvailable,
	startInboxVisibilityRefresh,
	loadColdStart,
	startColdStartPolling,
	getColdStartSnapshot,
	getVisibleColdStartActive,
	getVisibleColdStartRecent,
	dismissColdStartForAccount,
	getLastAction,
	undoLastAction,
} from './stores/inbox.svelte.js';
export type {
	InboxItem,
	InboxCounts,
	InboxAuditEntry,
	InboxBucket,
	InboxChannel,
	InboxUserAction,
	ColdStartProgress,
	ColdStartReport,
	ColdStartActiveEntry,
	ColdStartRecentEntry,
	ColdStartSnapshot,
	UndoableAction,
} from './stores/inbox.svelte.js';

// Inbox rules (Phase 1b)
export {
	listInboxRules,
	createInboxRule,
	deleteInboxRule,
} from './api/inbox-rules.js';
export type {
	InboxRule,
	CreateRuleBody,
	InboxRuleMatcherKind,
	InboxRuleAction,
	InboxRuleSource,
	InboxRuleBucket,
} from './api/inbox-rules.js';
export { listMailAccounts } from './api/mail-accounts.js';
export type { MailAccountView } from './api/mail-accounts.js';

// Push Notifications
export {
  initNotifications,
  enablePushNotifications,
  disablePushNotifications,
  testPushNotification,
  getNotificationPermission,
  isSubscribed,
  isLoading,
  isSupported,
  isIosWithoutPwa,
} from './stores/notifications.svelte.js';
