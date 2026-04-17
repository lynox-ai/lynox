// === WhatsAppContext — the engine-level bundle ===
//
// One cohesive object the Engine holds as a single optional field:
//   stateDb   — SQLite (messages + contacts)
//   vault     — encrypted credential store
//   client    — Meta Cloud API client, null until credentials exist
//
// Lifecycle:
//   const ctx = new WhatsAppContext(stateDb, vault);
//   ctx.reload();                      // called after settings UI saves creds
//   ctx.getClient();                   // null if unconfigured
//   ctx.tools();                       // ToolEntry[] for engine registration
//   await ctx.handleWebhookEvent(e);   // called by the HTTP webhook handler

import type { SecretVault } from '../../core/secret-vault.js';
import type { ToolEntry } from '../../types/index.js';
import { loadCredentials, hasCredentials, saveCredentials, clearCredentials } from './auth.js';
import { WhatsAppClient } from './client.js';
import type { MetaWebhookEvent, WhatsAppCredentials } from './types.js';
import { WhatsAppStateDb } from './state.js';
import { createWhatsAppTool } from './tools/index.js';

export class WhatsAppContext {
  private readonly stateDb: WhatsAppStateDb;
  private readonly vault: SecretVault | null;
  private client: WhatsAppClient | null = null;

  constructor(stateDb: WhatsAppStateDb, vault: SecretVault | null) {
    this.stateDb = stateDb;
    this.vault = vault;
    this.reload();
  }

  /** Re-read credentials from env/vault and rebuild the client. Called after settings save. */
  reload(): void {
    const creds = loadCredentials(this.vault);
    this.client = creds ? new WhatsAppClient(creds) : null;
  }

  /** True when a client with credentials is ready. */
  isConfigured(): boolean {
    return this.client !== null;
  }

  getClient(): WhatsAppClient | null {
    return this.client;
  }

  /** Webhook verify token — needed to answer the Meta GET handshake. */
  getWebhookVerifyToken(): string | null {
    const creds = loadCredentials(this.vault);
    return creds?.webhookVerifyToken ?? null;
  }

  /** App-Secret — needed to verify incoming POST webhook signatures. */
  getAppSecret(): string | null {
    const creds = loadCredentials(this.vault);
    return creds?.appSecret ?? null;
  }

  getStateDb(): WhatsAppStateDb {
    return this.stateDb;
  }

  saveCredentials(creds: WhatsAppCredentials): void {
    if (!this.vault) throw new Error('Cannot save WhatsApp credentials without a vault (set LYNOX_VAULT_KEY).');
    saveCredentials(this.vault, creds);
    this.reload();
  }

  clearCredentials(): void {
    clearCredentials(this.vault);
    this.reload();
  }

  hasStoredCredentials(): boolean {
    return hasCredentials(this.vault);
  }

  /** Persist a webhook event. Voice-note transcription happens separately (see webhook.ts). */
  persistEvent(event: MetaWebhookEvent): { messageInserted: boolean } {
    switch (event.type) {
      case 'message':
      case 'echo': {
        if (event.contact) {
          this.stateDb.upsertContact(event.contact);
        }
        const inserted = this.stateDb.upsertMessage(event.msg);
        return { messageInserted: inserted };
      }
      case 'status': {
        // Phase 0: status updates are informational only. Phase 1 surfaces them in the UI.
        return { messageInserted: false };
      }
    }
  }

  tools(): ToolEntry[] {
    return [createWhatsAppTool(this) as ToolEntry];
  }
}
