// === MailContext — everything the engine needs to run mail ===
//
// One cohesive bundle the Engine holds as a single field:
//   stateDb      — SQLite (dedup + accounts)
//   credStore    — vault-backed per-account credentials
//   registry     — accountId → live MailProvider map (used by tools)
//   watcher      — multi-account polling orchestrator
//
// The lifecycle:
//   new MailContext(stateDb, credStore)
//   await ctx.init()              // loads accounts + instantiates providers
//   await ctx.addAccount(config, creds)  // runtime add
//   await ctx.removeAccount(id)
//   const result = await ctx.testAccount(id)
//   await ctx.close()             // closes all providers + stops watcher
//
// The MailContext exposes `tools()` that returns the 5 ToolEntry objects,
// backed by its registry. Engine registers them on its own ToolRegistry.

import type { ToolEntry } from '../../types/index.js';
import type { GoogleAuth } from '../google/google-auth.js';
import type { MailCredentialBackend } from './auth/app-password.js';
import { MailCredentialStore } from './auth/app-password.js';
import { ImapSmtpProvider } from './providers/imap-smtp.js';
import { OAuthGmailProvider } from './providers/oauth-gmail.js';
import {
  MailError,
  isReceiveOnlyType,
  personaFor,
  type MailAccountConfig,
  type MailAccountType,
  type MailAuthType,
  type MailEnvelope,
  type MailProvider,
  type MailSendInput,
  type MailSendResult,
} from './provider.js';
import type { MailStateDb, MailFollowup } from './state.js';
import { createMailTools, InMemoryMailRegistry } from './tools/index.js';
import { MailWatcher, type MailWatcherHandler } from './watch.js';

export interface AddAccountInput {
  config: MailAccountConfig;
  credentials: { user: string; pass: string };
}

export interface TestAccountResult {
  ok: boolean;
  error?: string | undefined;
  code?: string | undefined;
}

/** Safe projection used by the HTTP layer — no secrets. */
export interface MailAccountView {
  id: string;
  displayName: string;
  address: string;
  preset: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** True if credentials for this account are present in the vault. */
  hasCredentials: boolean;
  /** True if this account is currently the default. */
  isDefault: boolean;
  /** Semantic role — drives tone, auto-reply policy, and receive-only block. */
  type: MailAccountType;
  /** Auth/transport flavor — UI uses this to pick the right edit form. */
  authType: MailAuthType;
  /** Resolved persona (custom override or type default). */
  persona: string;
  /** True if this type is hard-blocked from sending. */
  receiveOnly: boolean;
}

/**
 * Default no-op watcher handler — Phase 0 just dedups and discards. Phase 1
 * wires this to classification + notifications.
 */
const DEFAULT_HANDLER: MailWatcherHandler = async () => { /* no-op */ };

// ── MailHooks — extension points for CRM / tasks / notifications ───────────
//
// Phase 0.2 ships the INTERFACE with empty defaults. Phase 2 wires the real
// implementations in `engine.ts` that delegate to CRM (src/core/crm.ts),
// TaskManager (src/core/task-manager.ts), and NotificationRouter.
//
// The interface is intentionally minimal — hooks only fire at well-defined
// points and carry the minimum context needed. No LLM calls inside hooks;
// those happen at the layer that constructs the hook call (the watcher, the
// agent, or a Phase-1 classifier).

export interface ContactDiscoveryDecision {
  action: 'create' | 'ask' | 'skip';
  reason?: string | undefined;
}

export interface DealSignal {
  accountId: string;
  threadKey: string | undefined;
  signal: 'proposal_sent' | 'acceptance_received' | 'refusal_received' | 'deadline_set';
  detail: string;
}

export interface OutboundContext {
  input: MailSendInput;
  result: MailSendResult;
  isReply: boolean;
  originalMessageId?: string | undefined;
}

export interface MailHooks {
  /** Fires for every fresh (post-dedup, post-prefilter) inbound envelope. */
  onInboundMail?: (accountId: string, envelope: MailEnvelope) => Promise<void>;

  /** Fires after a successful mail_send or mail_reply. */
  onOutboundSent?: (accountId: string, ctx: OutboundContext) => Promise<void>;

  /**
   * Fires when a pending follow-up's reminder_at has passed. The hook is
   * expected to create a task, notify the user, or both. The follow-up is
   * marked 'reminded' before this fires so reminders never duplicate.
   */
  onFollowupDue?: (followup: MailFollowup) => Promise<void>;

  /** Fires when a pending follow-up was resolved because a reply arrived. */
  onFollowupResolved?: (followup: MailFollowup, replyEnvelope: MailEnvelope) => Promise<void>;

  /**
   * Fires when an inbound mail comes from an unknown sender that the per-
   * type default policy (see PER_TYPE_CRM_DEFAULTS) considers worth tracking.
   * Returns 'create' / 'ask' / 'skip'. The default default is 'ask' so the
   * user is always in the loop.
   */
  onContactDiscovered?: (accountId: string, address: string, context: MailEnvelope) => Promise<ContactDiscoveryDecision>;

  /** Fires when classification detects a deal-related signal (Phase 1+). */
  onDealSignalDetected?: (signal: DealSignal) => Promise<void>;
}

/**
 * Per-type CRM defaults — which types should auto-link inbound mails to CRM
 * contacts, and which should auto-create new contacts without asking?
 *
 * Phase 2's engine-side hook implementation consumes these. Receive-only
 * types are all `off` because compliance mailboxes must never auto-enrich
 * CRM state — that's a human decision.
 */
export interface PerTypeCrmPolicy {
  logInteractions: boolean;
  autoCreateContact: 'always' | 'ask' | 'never';
  dealSignalListening: boolean;
}

export const PER_TYPE_CRM_DEFAULTS: Record<MailAccountType, PerTypeCrmPolicy> = {
  personal:      { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  business:      { logInteractions: true,  autoCreateContact: 'ask',   dealSignalListening: true },
  support:       { logInteractions: true,  autoCreateContact: 'ask',   dealSignalListening: false },
  sales:         { logInteractions: true,  autoCreateContact: 'always', dealSignalListening: true },
  hello:         { logInteractions: true,  autoCreateContact: 'ask',   dealSignalListening: true },
  info:          { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  newsletter:    { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  notifications: { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  abuse:         { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  privacy:       { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  security:      { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
  legal:         { logInteractions: false, autoCreateContact: 'never', dealSignalListening: false },
};

// ── Task-creation safety rules ──────────────────────────────────────────────
//
// When the Phase-2 task integration lands, it MUST respect these invariants.
// They exist as code-level constants rather than prose comments so any
// future code path that violates them will need an explicit override that
// gets caught in review.

export interface TaskCreationSafetyPolicy {
  /** Never auto-create a task without user confirmation OR matching pre-approval. */
  requireConfirmation: boolean;
  /** Hard cap on mail-derived auto-created tasks per 24h window. */
  maxAutoTasksPerDay: number;
  /** Receive-only types NEVER auto-create tasks — always escalate to the user. */
  receiveOnlyAlwaysEscalate: boolean;
  /** Every mail-derived task must carry source tracking (account_id, uid, message_id). */
  requireSourceTracking: boolean;
  /** Rejected suggestions become negative patterns for future matching. */
  learnFromRejections: boolean;
  /** Tasks from compliance types (abuse/privacy/security/legal) carry a sensitive tag. */
  tagComplianceAsSensitive: boolean;
}

export const TASK_CREATION_SAFETY_POLICY: TaskCreationSafetyPolicy = {
  requireConfirmation: true,
  maxAutoTasksPerDay: 5,
  receiveOnlyAlwaysEscalate: true,
  requireSourceTracking: true,
  learnFromRejections: true,
  tagComplianceAsSensitive: true,
};

export class MailContext {
  readonly stateDb: MailStateDb;
  readonly credStore: MailCredentialStore;
  readonly registry: InMemoryMailRegistry;
  readonly watcher: MailWatcher;
  readonly hooks: MailHooks;
  /**
   * Optional GoogleAuth instance — when set, OAuth-Gmail accounts become
   * first-class members of the registry alongside IMAP/SMTP. The boot
   * migration in init() also auto-creates a row for the existing OAuth
   * connection so users who connected Gmail via OAuth before this refactor
   * see their mailbox without re-authorizing.
   */
  readonly googleAuth: GoogleAuth | null;

  private handler: MailWatcherHandler;
  private initialized = false;

  constructor(
    stateDb: MailStateDb,
    credBackend: MailCredentialBackend,
    handler: MailWatcherHandler = DEFAULT_HANDLER,
    hooks: MailHooks = {},
    googleAuth: GoogleAuth | null = null,
  ) {
    this.stateDb = stateDb;
    this.credStore = new MailCredentialStore(credBackend);
    this.registry = new InMemoryMailRegistry();
    this.hooks = hooks;
    this.googleAuth = googleAuth;

    // Wrap the user handler so that every inbound envelope also fires
    // onInboundMail hooks AND resolves any matching follow-ups.
    const wrappedHandler: MailWatcherHandler = async (accountId, envelopes) => {
      for (const env of envelopes) {
        // Resolve any pending follow-ups in this thread that were waiting
        // for a reply from the sender of this inbound.
        for (const sender of env.from) {
          if (!env.threadKey) continue;
          const resolved = this.stateDb.resolveFollowupsByReply(accountId, env.threadKey, sender.address);
          if (this.hooks.onFollowupResolved) {
            for (const followup of resolved) {
              try { await this.hooks.onFollowupResolved(followup, env); } catch { /* swallow */ }
            }
          }
        }

        // Fire inbound hook
        if (this.hooks.onInboundMail) {
          try { await this.hooks.onInboundMail(accountId, env); } catch { /* swallow */ }
        }
      }

      // Delegate to user handler
      await handler(accountId, envelopes);
    };

    this.handler = wrappedHandler;
    this.watcher = new MailWatcher(stateDb, wrappedHandler);
  }

  /**
   * Check every registered account for follow-ups whose reminder is due.
   * Called from the watcher tick (or from a separate interval if preferred).
   * Marks each due follow-up as 'reminded' BEFORE firing the hook so we
   * never double-remind even if the hook is slow.
   */
  async checkDueFollowups(now: Date = new Date()): Promise<number> {
    const due = this.stateDb.dueFollowups(now);
    let fired = 0;
    for (const followup of due) {
      const marked = this.stateDb.markFollowupReminded(followup.id);
      if (!marked) continue; // someone else got to it (race); skip
      fired++;
      if (this.hooks.onFollowupDue) {
        try { await this.hooks.onFollowupDue(followup); } catch { /* swallow */ }
      }
    }
    return fired;
  }

  /**
   * Load all configured accounts from the state DB, instantiate their
   * providers, populate the registry, and attach them to the watcher.
   * Idempotent — repeated calls are a no-op after first init.
   *
   * Boot migration: if `googleAuth` is set and authenticated, ensures a
   * matching `oauth_google` row exists in `mail_accounts` so users who
   * connected Gmail via OAuth before the unification refactor still see
   * their mailbox. Idempotent — re-runs are no-ops once the row exists.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Boot migration must run BEFORE the provider loop so the new row is
    // picked up in the same init() pass.
    await this._migrateOAuthGmailRow();

    const accounts = this.stateDb.listAccounts();
    for (const account of accounts) {
      try {
        const provider = await this._buildProvider(account);
        if (!provider) continue;
        this.registry.add(provider);
        await this.watcher.attach(provider);
      } catch {
        // Non-fatal: one bad account should not block the rest
      }
    }

    // Restore the persisted default. If the DB has a row marked is_default=1
    // and that provider registered successfully, promote it. Otherwise, fall
    // back to the first registered provider (matches pre-v6 first-wins
    // semantics for fresh installs) and persist the choice so subsequent
    // boots stay stable.
    this._reconcileDefault();

    // Start the followup check loop — one timer for all accounts
    this.watcher.startFollowupCheck(() => this.checkDueFollowups().then(() => { /* void */ }));
  }

  /**
   * Sync the in-memory registry default with the persisted is_default flag.
   * Called from init() after providers are registered, and from addAccount
   * / removeAccount whenever the registry shape changes.
   *
   * Rules:
   *   1. Persisted default exists AND its provider is registered → promote.
   *   2. Persisted default exists but its provider failed to register
   *      (e.g. revoked OAuth, expired IMAP creds) → preserve the persisted
   *      choice. The DB row stays marked is_default=1 so when the account
   *      is reconnected it snaps back. The in-memory registry already
   *      holds *some* default from registry.add() seeding, which keeps
   *      tools functional; callers can compare stateDb.defaultAccountId()
   *      with registry.default() to detect the mismatch.
   *   3. No persisted default has ever been set → fresh-install fallback:
   *      pick the first registered provider and persist the choice.
   *   4. No persisted default and nothing registered → leave both null.
   */
  private _reconcileDefault(): void {
    const persistedId = this.stateDb.defaultAccountId();
    const registered = this.registry.list();

    if (persistedId && registered.includes(persistedId)) {
      this.registry.setDefault(persistedId);
      return;
    }
    if (persistedId) {
      // Case 2: do not overwrite the user's choice.
      return;
    }
    if (registered.length === 0) return;
    const fallback = registered[0]!;
    this.stateDb.setDefaultAccount(fallback);
    this.registry.setDefault(fallback);
  }

  /**
   * Set `id` as the default account. Updates both the persisted flag and
   * the in-memory registry. Throws MailError when the id is not registered.
   *
   * Concurrency: this is per-user UI state, not transactional. Two tabs
   * issuing set-default at the same time both succeed and the later writer
   * wins — accepted semantics. Callers that care about strict ordering
   * should fence at a higher layer.
   */
  setDefault(id: string): void {
    if (!this.registry.get(id)) {
      throw new MailError('not_found', `Cannot set default — account "${id}" is not registered`);
    }
    this.stateDb.setDefaultAccount(id);
    this.registry.setDefault(id);
  }

  /**
   * Instantiate the right provider for a configured account. Returns null
   * when prerequisites are missing (e.g. IMAP creds missing from vault, or
   * GoogleAuth absent for an oauth_google row) — the caller skips that
   * account but continues with the rest.
   */
  private async _buildProvider(account: MailAccountConfig): Promise<MailProvider | null> {
    if (account.authType === 'oauth_google') {
      if (!this.googleAuth || !this.googleAuth.isAuthenticated()) return null;
      return new OAuthGmailProvider(account, this.googleAuth);
    }
    if (account.authType === 'imap') {
      // Credentials may be missing if the DB row survived a vault rotation.
      // Skip silently — the user re-enters the password and we re-init.
      if (!this.credStore.has(account.id)) return null;
      return new ImapSmtpProvider(account, this.credStore.buildResolver(account.id));
    }
    // Unknown auth type — defensively skip rather than throw
    return null;
  }

  /**
   * Insert a placeholder `oauth_google` row for the user's primary Gmail
   * mailbox if Google OAuth is authenticated and no such row exists yet.
   * The row stores empty-string IMAP placeholders because the v5 schema
   * still requires them as NOT NULL — relaxing those is out of scope for
   * this PR.
   *
   * The user's email is fetched from the Gmail profile endpoint. Failures
   * here are non-fatal — we just skip the migration and let the next init
   * try again.
   */
  private async _migrateOAuthGmailRow(): Promise<void> {
    if (!this.googleAuth || !this.googleAuth.isAuthenticated()) return;

    // Fetch the *current* Google account email up front. Doing this before
    // the early-return lets us detect a disconnect→reconnect-with-different-
    // account scenario: if an oauth_google row exists but its address no
    // longer matches the live Google profile, the user re-linked to a new
    // mailbox and we drop+recreate the row.
    const email = await this._fetchGoogleProfileEmail();
    if (!email) return; // profile fetch failed; next init retries

    const existing = this.stateDb.listAccounts().find(a => a.authType === 'oauth_google');
    if (existing) {
      if (existing.address.toLowerCase() === email.toLowerCase()) return;
      // Mailbox identity changed — drop the stale row before creating the new
      // one. Forget dedup state too so the new mailbox doesn't silently
      // suppress messages that look identical to old ones.
      this.stateDb.forgetAccount(existing.id);
      this.stateDb.deleteAccount(existing.id);
    }

    const slug = this._slugForEmail(email);
    const id = `gmail-${slug}`;

    // If no row currently holds the default flag, take it. This is the
    // explicit fix for the "DEFAULT badge wandert" bug: users who connected
    // OAuth-Gmail BEFORE the unification refactor never had a row to mark
    // default. When that row is now created by this migration, we reclaim
    // the default for the OAuth account ahead of any later-added IMAP.
    const claimDefault = this.stateDb.defaultAccountId() === null;

    this.stateDb.upsertAccount({
      id,
      displayName: email,
      address: email,
      preset: 'gmail',
      // v5 schema still requires non-null IMAP fields; placeholders are
      // unused by OAuthGmailProvider. A future PR can relax the NOT NULL
      // constraint via a table rebuild.
      imap: { host: '', port: 0, secure: true },
      smtp: { host: '', port: 0, secure: true },
      authType: 'oauth_google',
      oauthProviderKey: 'GOOGLE_OAUTH_TOKENS',
      type: 'personal',
      isDefault: claimDefault,
    });
  }

  /** Returns the live Google profile email, or null on transient failure. */
  private async _fetchGoogleProfileEmail(): Promise<string | null> {
    if (!this.googleAuth) return null;
    try {
      const token = await this.googleAuth.getAccessToken();
      const res = await globalThis.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const profile = await res.json() as { emailAddress?: string };
      return profile.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Build a stable slug from an email address. Preserves `+`, `.`, and `_`
   * inside the local-part so `user@x` and `user+spam@x` and `user.x@y`
   * never collide and silently overwrite each other in the mail_accounts
   * table.
   */
  private _slugForEmail(email: string): string {
    return email.toLowerCase().replace(/[^a-z0-9+._-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * Add a new account or update an existing one. Persists the config to the
   * state DB, writes the credentials to the vault, then instantiates the
   * provider and attaches it to the watcher.
   */
  async addAccount(input: AddAccountInput): Promise<void> {
    this.stateDb.upsertAccount(input.config);
    this.credStore.save(input.config.id, input.credentials);

    // If there's an existing provider for this id, detach + close it first
    const existing = this.registry.get(input.config.id);
    if (existing) {
      await this.watcher.detach(input.config.id);
      await existing.close();
      this.registry.remove(input.config.id);
    }

    const provider = new ImapSmtpProvider(input.config, this.credStore.buildResolver(input.config.id));
    this.registry.add(provider);
    await this.watcher.attach(provider);

    // Reconcile so the first-added account becomes default automatically,
    // but a later add does NOT overwrite the user's existing choice. The
    // bug we're fixing: previously registry.add() always defaulted-when-
    // null, which silently demoted whichever account was registered first.
    this._reconcileDefault();
  }

  /**
   * Remove an account entirely: detach watcher, close provider, drop vault
   * credentials, drop dedup state, delete the DB row.
   */
  async removeAccount(accountId: string): Promise<boolean> {
    const existing = this.registry.get(accountId);
    if (existing) {
      await this.watcher.detach(accountId);
      await existing.close();
      this.registry.remove(accountId);
    }
    this.credStore.delete(accountId);
    this.stateDb.forgetAccount(accountId);
    const removed = this.stateDb.deleteAccount(accountId);

    // If the removed account was the default, fall back to whichever
    // account remains registered (or clear it). Persisted is_default is
    // updated alongside the in-memory registry.
    this._reconcileDefault();
    return removed;
  }

  /**
   * Verify that the configured credentials can open an IMAP session and a
   * SMTP connection. Does not store anything — the caller uses this as a
   * pre-save check in the onboarding UI.
   *
   * Accepts either an already-saved account id or a draft config+credentials
   * pair (preferred in UI flows — no write-then-rollback needed).
   */
  async testAccount(input: string | AddAccountInput): Promise<TestAccountResult> {
    let config: MailAccountConfig;
    let credentials: { user: string; pass: string };

    if (typeof input === 'string') {
      const stored = this.stateDb.getAccount(input);
      if (!stored) return { ok: false, error: `No account "${input}"`, code: 'not_found' };
      config = stored;
      try {
        credentials = this.credStore.resolve(input);
      } catch {
        return { ok: false, error: 'No stored credentials', code: 'auth_failed' };
      }
    } else {
      config = input.config;
      credentials = input.credentials;
    }

    const probe = new ImapSmtpProvider(config, () => credentials);
    try {
      // list() exercises IMAP auth end-to-end without fetching bodies
      await probe.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      if (err instanceof MailError) {
        return { ok: false, error: err.message, code: err.code };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'unknown' };
    } finally {
      await probe.close();
    }
  }

  /** Safe (no-secret) list for the HTTP layer and the UI. */
  listAccounts(): ReadonlyArray<MailAccountView> {
    const defaultId = this.registry.default();
    return this.stateDb.listAccounts().map(account => ({
      id: account.id,
      displayName: account.displayName,
      address: account.address,
      preset: account.preset,
      imap: { host: account.imap.host, port: account.imap.port, secure: account.imap.secure },
      smtp: { host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure },
      hasCredentials: this.credStore.has(account.id),
      isDefault: account.id === defaultId,
      type: account.type,
      authType: account.authType,
      persona: personaFor(account),
      receiveOnly: isReceiveOnlyType(account.type),
    }));
  }

  /**
   * Get the stored config for an accountId, or null if not configured.
   * Used by tools to check type + persona without rehydrating the provider.
   */
  getAccountConfig(accountId: string): MailAccountConfig | null {
    return this.stateDb.getAccount(accountId);
  }

  /**
   * Find a registered account by its email address (case-insensitive).
   * Used by mail_reply's smart reply-from derivation.
   */
  findAccountByAddress(address: string): MailAccountConfig | null {
    const needle = address.toLowerCase();
    for (const account of this.stateDb.listAccounts()) {
      if (account.address.toLowerCase() === needle) return account;
    }
    return null;
  }

  /** Build the 5 mail tools backed by this context's registry + self-reference for type lookups. */
  tools(): ToolEntry[] {
    return createMailTools(this.registry, this);
  }

  /** Close every provider + stop the watcher. Safe to call multiple times. */
  async close(): Promise<void> {
    await this.watcher.stopAll();
    const providers: MailProvider[] = this.registry.list().map(id => this.registry.get(id)!);
    await Promise.allSettled(providers.map(p => p.close()));
    this.registry.clear();
  }
}
