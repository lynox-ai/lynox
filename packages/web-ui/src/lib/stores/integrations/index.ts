// === Integrations stores — barrel ===
//
// Per-channel sub-stores for Settings → Integrations. P3-PR-A1 extracted these
// from IntegrationsView.svelte; P3-PR-A2 will route each channel to its own
// page (`/settings/channels/{mail,whatsapp,google,notifications,search}`) and
// import only the slice it needs.

export * as googleIntegration from './google.svelte.js';
export * as notificationsIntegration from './notifications.svelte.js';
export * as searchIntegration from './search.svelte.js';
export * as secretsIntegration from './secrets.svelte.js';
export * as managedIntegration from './managed.svelte.js';
