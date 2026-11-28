/**
 * The word a read in the owner's view of the actor trail gets, by the action the engine writes for
 * it (`GET <route template>`, `_recordedMandateRead`): a noun for what was read, since the kind
 * ("Read access") stands before it. Words as decided (U-306 B1(c), 2026-11-17). A route without a word
 * shows only its route, as before; the route stays next to every word, muted, as the proof.
 *
 * The settings pages share one form, "Settings: {page}", with the page's name read from the key
 * the settings index shows it under, so a renamed page is renamed here too.
 */

/** Word keys under `access_trail.read.`, by action. */
const WORDS: Readonly<Record<string, string>> = {
	'GET /api/triggers/paused-count': 'paused_plan_count',
	'GET /api/voice/info': 'voice_info',
	'GET /api/sessions/:id/pending-prompt': 'pending_prompt',
	'GET /api/onboarding/status': 'onboarding_status',
	'GET /api/threads/:id/messages': 'thread_messages',
	'GET /api/threads': 'threads',
	'GET /api/threads/:id': 'thread',
	'GET /api/knowledge/queue': 'knowledge_queue',
	'GET /api/knowledge/queue/count': 'knowledge_queue_count',
	'GET /api/runs/:runId/stream': 'run_stream',
	'GET /api/sessions/:id/changeset': 'changeset',
	'GET /api/artifacts': 'artifacts',
	'GET /api/usage/summary': 'usage_summary',
	'GET /api/vault/key': 'vault_key',
	'GET /api/history/stats': 'history_stats',
	'GET /api/history/runs': 'history_runs',
	'GET /api/workflows': 'workflows',
	'GET /api/bulk/runs': 'bulk_runs',
	'GET /api/merges': 'merges',
	'GET /api/bulk/runs/:id': 'bulk_run',
	'GET /api/bulk/runs/:id/targets': 'bulk_run_targets',
	'GET /api/approvals': 'approvals',
	'GET /api/workflows/library': 'workflow_library',
	'GET /api/triggers': 'triggers',
	'GET /api/inbox/items': 'inbox_items',
	'GET /api/inbox/cold-start': 'inbox_cold_start',
	'GET /api/inbox/rules': 'inbox_rules',
	'GET /api/mail/accounts': 'mail_accounts',
	'GET /api/knowledge/entries': 'knowledge_entries',
	'GET /api/knowledge/blocks': 'knowledge_blocks',
	'GET /api/memory/:ns': 'memory_namespace',
	'GET /api/kg/stats': 'kg_stats',
	'GET /api/kg/entities': 'kg_entities',
	'GET /api/kg/graph': 'kg_graph',
	'GET /api/metrics': 'metrics',
	'GET /api/crm/contacts': 'crm_contacts',
	'GET /api/crm/deals': 'crm_deals',
	'GET /api/subjects': 'subjects',
	'GET /api/datastore/collections': 'datastore_collections',
	'GET /api/files': 'files',
	'GET /api/inbox/items/:id': 'inbox_item',
	'GET /api/inbox/items/:id/audit': 'inbox_item_audit',
	'GET /api/inbox/items/:id/full': 'inbox_item_full',
	'GET /api/inbox/items/:id/thread': 'inbox_item_thread',
	'GET /api/inbox/items/:id/context': 'inbox_item_context',
	'GET /api/threads/:id/debug-export': 'thread_export',
	'GET /api/history/runs/:id/tool-calls': 'run_tool_calls',
	'GET /api/files/read': 'file_read',
	'GET /api/files/download': 'file_download',
	'GET /api/workflows/:id': 'workflow',
	'GET /api/workflows/:id/steps': 'workflow_steps',
	'GET /api/artifacts/:id': 'artifact',
	'GET /api/kg/entities/:id': 'kg_entity',
	'GET /api/crm/contacts/:name/interactions': 'contact_interactions',
	'GET /api/crm/contacts/:name/deals': 'contact_deals',
	'GET /api/subjects/:id/footprint': 'subject_footprint',
	'GET /api/datastore/:collection': 'datastore_collection',
	'GET /api/auth/token': 'auth_token',
	'GET /api/push/vapid-key': 'vapid_key',
	'GET /api/access-trail': 'access_trail',
	'GET /api/config': 'config',
	'GET /api/runs/active': 'runs_active',
	'GET /api/tasks': 'tasks',
	'GET /api/providers/status': 'providers_status',
	'GET /api/provider/status': 'provider_status',
	'GET /api/history/cost/daily': 'history_cost_daily',
	'GET /api/secrets/status': 'secrets_status',
	'GET /api/secrets': 'secrets',
	'GET /api/inbox/counts': 'inbox_counts',
	'GET /api/approvals/count': 'approvals_count',
	'GET /api/inbox/undo/recent': 'inbox_undo_recent',
	'GET /api/inbox/contacts/:email': 'inbox_contact',
	'GET /api/history/runs/:id': 'history_run',
	'GET /api/usage/current': 'usage_current',
	'GET /api/thread-insights': 'thread_insights',
	'GET /api/transcribe/info': 'transcribe_info',
	'GET /api/crm/stats': 'crm_stats',
	'GET /api/workflows/stats/cost': 'workflows_stats_cost',
	'GET /api/workflows/stats/steps': 'workflows_stats_steps',
	'GET /api/workflows/:id/stamp-preview': 'workflow_stamp_preview',
	'GET /api/workflows/:id/takeover-preview': 'workflow_takeover_preview',
	'GET /api/tasks/:id/stamp-preview': 'task_stamp_preview',
	'GET /api/triggers/:id/takeover-preview': 'trigger_takeover_preview',
	'GET /api/triggers/:id/confirm-recipients-preview': 'trigger_recipients_preview',
	'GET /api/api-profiles/:id': 'api_profile',
	'GET /api/api-profiles/:id/client': 'api_profile_client',
	'GET /api/connections/records': 'connection_records',
	'GET /api/oauth/connect/:id': 'oauth_connect',
	'GET /api/google/oauth-url': 'google_oauth_url',
};

/** The settings pages' reads, by action, to the key their page is named under in the settings index. */
const SETTINGS_PAGES: Readonly<Record<string, string>> = {
	'GET /api/llm/catalog': 'settings.config',
	'GET /api/tools/available': 'tools.heading',
	'GET /api/mail/presets': 'settings.channels.mail',
	'GET /api/google/status': 'settings.channels.google',
	'GET /api/search/reranker/capability': 'settings.channels.search',
	'GET /api/inbox/notification-prefs': 'settings.channels.notifications',
	'GET /api/api-profiles': 'settings.apis',
	'GET /api/backups': 'settings.workspace.backups',
	'GET /api/migration/preview': 'settings.account.migration',
};

/** What a word is built from: a key of its own, or the settings form with a page key. */
export type ReadWord = { readonly key: string } | { readonly settings: string };

/** The word of a read's action, or null for a route that has none (it then shows its route only). */
export function readWord(action: string): ReadWord | null {
	// A HEAD read is the GET route's, without the body: the engine writes `HEAD <route>` for it.
	const get = action.startsWith('HEAD ') ? `GET ${action.slice('HEAD '.length)}` : action;
	const own = WORDS[get];
	if (own !== undefined) return { key: `access_trail.read.${own}` };
	const page = SETTINGS_PAGES[get];
	return page === undefined ? null : { settings: page };
}

/** Every action with a word, for the test that holds the list to the engine's routes. */
export const WORDED_ACTIONS: readonly string[] = [...Object.keys(WORDS), ...Object.keys(SETTINGS_PAGES)];

/**
 * What a read returns, declared per route (U-306 N1): the word must not say less than the route
 * gives. `state` is a status, a count, a setting or a definition the person could not act on
 * alone; every other kind is content the owner must be told was read, and the word must name it
 * in both languages (`CARRY_TERMS`, held by `access-trail-words-routes.svelte.test.ts`). A new
 * route without a declaration fails that test, so it cannot arrive with a word that plays it down.
 */
export type Carry =
	| 'state' | 'messages' | 'mail' | 'other_mails' | 'task' | 'answer' | 'result' | 'io' | 'values'
	| 'content' | 'summary' | 'title' | 'interaction' | 'cost' | 'rows' | 'memory' | 'contact'
	| 'changes' | 'deals' | 'graph' | 'artifact' | 'file' | 'export' | 'names' | 'tasks' | 'rules'
	| 'steps' | 'workflow';

/** The term a word must hold for each kind of content, DE and EN. */
export const CARRY_TERMS: Readonly<Record<Exclude<Carry, 'state'>, { readonly de: RegExp; readonly en: RegExp }>> = {
	messages: { de: /Nachrichten/, en: /messages/i },
	mail: { de: /Mail/, en: /email/i },
	other_mails: { de: /Weitere Mails/, en: /Other emails/ },
	task: { de: /Auftrag/, en: /task|instruction/i },
	answer: { de: /Antwort/, en: /answer/i },
	result: { de: /Ergebnis/, en: /result/i },
	io: { de: /Ein- und Ausgaben/, en: /inputs and outputs/ },
	values: { de: /Werte/, en: /values/ },
	content: { de: /Inhalt/, en: /content/i },
	summary: { de: /Zusammenfassung/, en: /summary/i },
	title: { de: /Titel/, en: /title/i },
	interaction: { de: /Interaktion|Verlauf/, en: /interaction|history|thread/i },
	cost: { de: /Kosten|Verbrauch/, en: /cost|usage/i },
	rows: { de: /Tabelle/, en: /table/i },
	memory: { de: /Gedächtnis/, en: /memor/i },
	contact: { de: /Kontakt/, en: /contact/i },
	changes: { de: /[äÄ]nderungen/, en: /change/i },
	deals: { de: /Geschäfte/, en: /deals/i },
	graph: { de: /Wissensgraph/, en: /knowledge graph/i },
	artifact: { de: /Artefakt/, en: /artifact/i },
	file: { de: /Datei/, en: /file/i },
	export: { de: /Export/, en: /export/i },
	names: { de: /Namen|Personen, Firmen/, en: /names|people, companies/i },
	tasks: { de: /Aufgaben/, en: /tasks/i },
	rules: { de: /Regeln/, en: /rules/i },
	steps: { de: /Schritte/, en: /step/i },
	workflow: { de: /Workflow/, en: /workflow/i },
};

/** What each worded route returns (U-306 N1). Every key of `WORDS` and `SETTINGS_PAGES`, no other. */
export const CARRIES: Readonly<Record<string, readonly Carry[]>> = {
	'GET /api/triggers/paused-count': ['state'],
	'GET /api/voice/info': ['state'],
	'GET /api/sessions/:id/pending-prompt': ['answer'],
	'GET /api/onboarding/status': ['state'],
	'GET /api/threads/:id/messages': ['messages'],
	'GET /api/threads': ['title', 'summary'],
	'GET /api/threads/:id': ['title', 'summary'],
	'GET /api/knowledge/queue': ['memory'],
	'GET /api/knowledge/queue/count': ['state'],
	'GET /api/runs/:runId/stream': ['answer'],
	'GET /api/sessions/:id/changeset': ['changes', 'file'],
	'GET /api/artifacts': ['artifact'],
	'GET /api/usage/summary': ['cost'],
	'GET /api/vault/key': ['state'],
	'GET /api/history/stats': ['cost'],
	'GET /api/history/runs': ['task', 'answer'],
	'GET /api/workflows': ['workflow', 'cost'],
	'GET /api/bulk/runs': ['state'],
	'GET /api/merges': ['state'],
	'GET /api/bulk/runs/:id': ['state'],
	'GET /api/bulk/runs/:id/targets': ['values'],
	'GET /api/approvals': ['mail'],
	'GET /api/workflows/library': ['workflow'],
	'GET /api/triggers': ['task', 'result'],
	'GET /api/inbox/items': ['mail'],
	'GET /api/inbox/cold-start': ['state'],
	'GET /api/inbox/rules': ['rules'],
	'GET /api/mail/accounts': ['state'],
	'GET /api/knowledge/entries': ['memory'],
	'GET /api/knowledge/blocks': ['memory'],
	'GET /api/memory/:ns': ['content', 'memory'],
	'GET /api/kg/stats': ['state'],
	'GET /api/kg/entities': ['graph'],
	'GET /api/kg/graph': ['graph'],
	'GET /api/metrics': ['state'],
	'GET /api/crm/contacts': ['contact'],
	'GET /api/crm/deals': ['deals'],
	'GET /api/subjects': ['names'],
	'GET /api/datastore/collections': ['state'],
	'GET /api/files': ['file'],
	'GET /api/inbox/items/:id': ['mail'],
	'GET /api/inbox/items/:id/audit': ['mail'],
	'GET /api/inbox/items/:id/full': ['mail'],
	'GET /api/inbox/items/:id/thread': ['mail', 'interaction'],
	'GET /api/inbox/items/:id/context': ['other_mails'],
	'GET /api/threads/:id/debug-export': ['export'],
	'GET /api/history/runs/:id/tool-calls': ['io'],
	'GET /api/files/read': ['content', 'file'],
	'GET /api/files/download': ['file'],
	'GET /api/workflows/:id': ['workflow'],
	'GET /api/workflows/:id/steps': ['result', 'steps'],
	'GET /api/artifacts/:id': ['artifact'],
	'GET /api/kg/entities/:id': ['graph'],
	'GET /api/crm/contacts/:name/interactions': ['contact', 'interaction'],
	'GET /api/crm/contacts/:name/deals': ['contact', 'deals'],
	'GET /api/subjects/:id/footprint': ['rows', 'memory'],
	'GET /api/datastore/:collection': ['content', 'rows'],
	'GET /api/auth/token': ['state'],
	'GET /api/push/vapid-key': ['state'],
	'GET /api/access-trail': ['state'],
	'GET /api/config': ['state'],
	'GET /api/runs/active': ['state'],
	'GET /api/tasks': ['tasks'],
	'GET /api/providers/status': ['state'],
	'GET /api/provider/status': ['state'],
	'GET /api/history/cost/daily': ['cost'],
	'GET /api/secrets/status': ['state'],
	'GET /api/secrets': ['names'],
	'GET /api/inbox/counts': ['state'],
	'GET /api/approvals/count': ['state'],
	'GET /api/inbox/undo/recent': ['state'],
	'GET /api/inbox/contacts/:email': ['contact', 'interaction'],
	'GET /api/history/runs/:id': ['task', 'answer'],
	'GET /api/usage/current': ['cost'],
	'GET /api/thread-insights': ['title', 'cost'],
	'GET /api/transcribe/info': ['state'],
	'GET /api/crm/stats': ['state'],
	'GET /api/workflows/stats/cost': ['cost'],
	'GET /api/workflows/stats/steps': ['state'],
	'GET /api/workflows/:id/stamp-preview': ['steps'],
	'GET /api/workflows/:id/takeover-preview': ['steps'],
	'GET /api/tasks/:id/stamp-preview': ['state'],
	'GET /api/triggers/:id/takeover-preview': ['task', 'result'],
	'GET /api/triggers/:id/confirm-recipients-preview': ['task'],
	'GET /api/api-profiles/:id': ['state'],
	'GET /api/api-profiles/:id/client': ['state'],
	'GET /api/connections/records': ['state'],
	'GET /api/oauth/connect/:id': ['state'],
	'GET /api/google/oauth-url': ['state'],
	'GET /api/llm/catalog': ['state'],
	'GET /api/tools/available': ['state'],
	'GET /api/mail/presets': ['state'],
	'GET /api/google/status': ['state'],
	'GET /api/search/reranker/capability': ['state'],
	'GET /api/inbox/notification-prefs': ['state'],
	'GET /api/api-profiles': ['state'],
	'GET /api/backups': ['state'],
	'GET /api/migration/preview': ['state'],
};

const HTTP_METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE) /;

/**
 * The route a row names, once (U-306 B1(a)): the method with the concrete path when the action
 * is a route and the target its path, else the action with the target after it. A target that is
 * not a path (an http_request's host, a store) is not a second copy of the route, so it stays.
 */
export function routeText(action: string, target: string | null): string {
	const method = HTTP_METHOD.exec(action)?.[1];
	if (method !== undefined && target !== null && target.startsWith('/')) return `${method} ${target}`;
	return target === null || target === '' ? action : `${action} · ${target}`;
}
