import type { SecretScope, SecretStoreLike, LynoxUserConfig } from '../types/index.js';
import { channels } from './observability.js';
import type { SecretVault } from './secret-vault.js';

export const SECRET_REF_PATTERN = /\bsecret:([A-Z_][A-Z0-9_]*)\b/g;

/**
 * Infrastructure / engine-internal secret names that the agent must NOT see
 * or resolve. These are channel/engine credentials (mail-account blobs, OAuth
 * tokens, SMTP and IMAP, engine-internal LYNOX_ and MANAGED_) — managed by the
 * platform and the dedicated integration UIs, never authored or referenced by
 * the agent. Single source of truth: the same set the secrets-write API uses
 * to reject non-admin writes (`isAdminOnlySecret` in http-api).
 *
 * Why agent-invisible: a vault-backed secret is auto-consented (see
 * `_loadFromVault`), so without this gate `secret:MAIL_ACCOUNT_<id>` in a tool
 * input expands to the full `{user,pass}` credential and is sent to whatever
 * host the tool targets — a credential-exfil handle reachable via prompt
 * injection. These names are excluded from the session briefing AND left
 * unresolved in tool inputs. They remain in `maskSecrets` so a value that
 * does surface is still redacted.
 */
export const INFRA_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /^LYNOX_/,
  /^MANAGED_/,
  /^MAIL_ACCOUNT_/,
  /^GOOGLE_OAUTH_/,
  /^SMTP_/,
  /^IMAP_/,
];

/** True if `name` is an infrastructure/engine-internal secret (agent-invisible). */
export function isInfraSecret(name: string): boolean {
  return INFRA_SECRET_PATTERNS.some(p => p.test(name));
}

/**
 * Common secret patterns — regex-based detection for accidental secret leaks.
 * Used by ask_user guard and chat input warning.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  // OpenAI (sk-, sk-proj-)
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // Stripe
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}\b/,
  // GitHub (ghu_ added 2026-05-18 — user installation tokens missed previously)
  /\b(ghp|gho|ghs|ghr|ghu|github_pat)_[A-Za-z0-9_]{10,}\b/,
  // AWS
  /\bAKIA[A-Z0-9]{16}\b/,
  // Google
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  // Slack (xoxo + xoxr added — webhook + refresh-token prefixes)
  /\bxox[bpoasr]-[A-Za-z0-9-]{10,}\b/,
  // Shopify (admin / app-secret / partner / custom — added 2026-05-18 after
  // a Shopify integration flow leaked the prefix into the agent transcript)
  /\bshp(at|ss|pa|ca)_[A-Fa-f0-9]{20,}\b/,
  // JWT (three base64-url segments) — catches OAuth ID tokens etc.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/,
  // Generic Bearer tokens (long base64-ish)
  /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/,
  // Generic long hex/base64 secrets (40+ chars, likely tokens)
  /\b[A-Za-z0-9_-]{40,}\b/,
];

/**
 * Check if text likely contains a secret based on common key patterns.
 * Returns the first match or null.
 */
export function matchesSecretPattern(text: string): string | null {
  // Skip the generic long-string pattern (last one) for short texts to reduce false positives
  const patterns = text.length < 100 ? SECRET_PATTERNS.slice(0, -1) : SECRET_PATTERNS;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * Mask text that matches common secret patterns.
 * Replaces detected secrets with `***<last4>`.
 */
export function maskSecretPatterns(text: string): string {
  let result = text;
  // Apply specific patterns (skip generic last pattern to avoid over-masking)
  for (const pattern of SECRET_PATTERNS.slice(0, -1)) {
    const globalPattern = new RegExp(pattern.source, 'g');
    result = result.replace(globalPattern, (match) => {
      if (match.length <= 4) return '***';
      return `***${match.slice(-4)}`;
    });
  }
  return result;
}

interface InternalSecret {
  name: string;
  value: string;
  scope: SecretScope;
  loadedAt: number;
  ttlMs: number; // 0 = no expiry
}

function maskValue(value: string): string {
  if (value.length <= 4) return '***';
  const suffix = value.slice(-4);
  return `***${suffix}`;
}

export class SecretStore implements SecretStoreLike {
  private readonly secrets = new Map<string, InternalSecret>();
  private readonly consented = new Set<string>();
  private readonly vault: SecretVault | null;

  constructor(config?: LynoxUserConfig | undefined, vault?: SecretVault | undefined) {
    this.vault = vault ?? null;
    this._loadFromEnv();
    if (this.vault) {
      this._loadFromVault();
    }
    if (config) {
      this._loadFromConfig(config);
    }
  }

  private _loadFromEnv(): void {
    // 1. LYNOX_SECRET_* prefix — explicit secret injection
    const prefix = 'LYNOX_SECRET_';
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix) && value) {
        const name = key.slice(prefix.length);
        if (name.length === 0) continue;
        this.secrets.set(name, {
          name,
          value,
          scope: 'any',
          loadedAt: Date.now(),
          ttlMs: 0,
        });
      }
    }

    // 2. Well-known env vars — explicit runtime env always overrides vault.
    //    Without this, vault.getAll() in _loadFromVault() would shadow the env var
    //    and secretStore.resolve() would return a stale vault value.
    const wellKnownEnv: Array<[string, string]> = [
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
      ['GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'],
      // SEARCH_API_KEY / TAVILY_API_KEY pairing removed 2026-05-24 with the
      // Tavily backend. The vault entry (if any) is no longer resolved as a
      // search credential; SearXNG (URL only, no key) is the supported path.
    ];
    for (const [secretName, envVar] of wellKnownEnv) {
      const value = process.env[envVar];
      if (!value) continue;
      if (this.secrets.has(secretName)) continue; // LYNOX_SECRET_* already set
      this.secrets.set(secretName, {
        name: secretName,
        value,
        scope: 'any',
        loadedAt: Date.now(),
        ttlMs: 0,
      });
    }
  }

  private _loadFromVault(): void {
    if (!this.vault) return;
    const entries = this.vault.getAll();
    for (const [name, entry] of entries) {
      // Don't overwrite env/file secrets (they take precedence)
      if (this.secrets.has(name)) continue;
      this.secrets.set(name, {
        name,
        value: entry.value,
        scope: entry.scope,
        loadedAt: Date.now(),
        ttlMs: entry.ttlMs,
      });
      // Auto-consent vault secrets — the user explicitly saved them
      this.consented.add(name);
    }
  }

  private _loadFromConfig(config: LynoxUserConfig): void {
    const wellKnown: Array<[string, string | undefined]> = [
      ['ANTHROPIC_API_KEY', config.api_key],
    ];

    for (const [name, value] of wellKnown) {
      if (!value) continue;
      // Don't overwrite if already loaded
      if (this.secrets.has(name)) continue;
      this.secrets.set(name, {
        name,
        value,
        scope: 'any',
        loadedAt: Date.now(),
        ttlMs: 0,
      });
    }
  }

  getMasked(name: string): string | null {
    const secret = this.secrets.get(name);
    if (!secret) return null;
    return maskValue(secret.value);
  }

  resolve(name: string): string | null {
    const secret = this.secrets.get(name);
    if (!secret) return null;
    if (this.isExpired(name)) return null;
    if (!this.hasConsent(name)) return null;

    channels.secretAccess.publish({ name, action: 'resolve' });
    return secret.value;
  }

  listNames(): string[] {
    return [...this.secrets.keys()];
  }

  /**
   * Secret names the agent may see + reference. Excludes infrastructure secrets
   * (mail-account / OAuth / SMTP/IMAP / engine-internal) so they are never
   * advertised in the session briefing. `listNames()` still returns everything
   * for masking + the settings UI.
   */
  listAgentVisibleNames(): string[] {
    return [...this.secrets.keys()].filter(n => !isInfraSecret(n));
  }

  containsSecret(text: string): boolean {
    for (const secret of this.secrets.values()) {
      if (secret.value.length < 2) continue; // skip single-char values to avoid false positives
      if (text.includes(secret.value)) return true;
    }
    return false;
  }

  maskSecrets(text: string): string {
    let result = text;
    for (const secret of this.secrets.values()) {
      if (secret.value.length < 2) continue;
      // Use split+join for literal replacement (no regex special char issues)
      while (result.includes(secret.value)) {
        result = result.split(secret.value).join(maskValue(secret.value));
      }
    }
    return result;
  }

  recordConsent(name: string): void {
    this.consented.add(name);
    channels.secretAccess.publish({ name, action: 'consent' });
  }

  hasConsent(name: string): boolean {
    return this.consented.has(name);
  }

  isExpired(name: string): boolean {
    const secret = this.secrets.get(name);
    if (!secret) return true;
    if (secret.ttlMs === 0) return false;
    return Date.now() - secret.loadedAt > secret.ttlMs;
  }

  /**
   * Store a secret in the vault and in-memory cache.
   * Requires a vault to be configured.
   */
  set(name: string, value: string, scope?: SecretScope | undefined, ttlMs?: number | undefined): void {
    if (!this.vault) {
      throw new Error('Cannot set secrets without a vault. Set LYNOX_VAULT_KEY to enable the vault.');
    }
    this.vault.set(name, value, scope, ttlMs);
    this.secrets.set(name, {
      name,
      value,
      scope: scope ?? 'any',
      loadedAt: Date.now(),
      ttlMs: ttlMs ?? 0,
    });
    channels.secretAccess.publish({ name, action: 'store' });
  }

  /**
   * Delete a secret from the vault and in-memory cache.
   * Returns true if the secret was deleted.
   */
  deleteSecret(name: string): boolean {
    const hadInMemory = this.secrets.delete(name);
    this.consented.delete(name);
    const hadInVault = this.vault?.delete(name) ?? false;
    if (hadInMemory || hadInVault) {
      channels.secretAccess.publish({ name, action: 'delete' });
    }
    return hadInMemory || hadInVault;
  }

  extractSecretNames(input: unknown): string[] {
    const text = JSON.stringify(input);
    const names: string[] = [];
    const pattern = new RegExp(SECRET_REF_PATTERN.source, 'g');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!names.includes(match[1]!)) {
        names.push(match[1]!);
      }
    }
    return names;
  }

  resolveSecretRefs(input: unknown): unknown {
    const text = JSON.stringify(input);
    const pattern = new RegExp(SECRET_REF_PATTERN.source, 'g');
    const resolved = text.replace(pattern, (_match, name: string) => {
      // Infrastructure secrets are never resolved into agent tool input — leave
      // the literal `secret:NAME` so the credential cannot be exfiltrated to an
      // external host (the value stays in the vault / credStore path only).
      if (isInfraSecret(name)) return `secret:${name}`;
      const value = this.resolve(name);
      // Escape for JSON string context
      return value !== null ? value.replace(/["\\\n\r\t]/g, c => {
        if (c === '"') return '\\"';
        if (c === '\\') return '\\\\';
        if (c === '\n') return '\\n';
        if (c === '\r') return '\\r';
        if (c === '\t') return '\\t';
        return c;
      }) : `secret:${name}`;
    });
    try {
      return JSON.parse(resolved) as unknown;
    } catch {
      return input;
    }
  }

  /**
   * Like extractSecretNames but returns only the names that DON'T resolve
   * (no in-memory match, no vault match). Used by the agent's pre-tool gate
   * to refuse-with-clear-error instead of silently sending literal
   * `secret:NAME` strings to the external service — staging 2026-05-18
   * incident: agent POSTed the unresolved `secret:` reference literal to
   * Shopify because the vault didn't have that name; Shopify echoed the
   * literal in the error message and the agent mis-diagnosed it as
   * "http_request tool limitation" and recommended self-host. With this
   * gate the agent gets "vault has no SHOPIFY_CLIENT_ID, store it via
   * ask_secret first" and can recover correctly.
   */
  findUnresolvedSecretRefs(input: unknown): string[] {
    const names = this.extractSecretNames(input);
    return names.filter((n) => this.resolve(n) === null);
  }

  /** Whether a vault is attached */
  get hasVault(): boolean {
    return this.vault !== null;
  }

  /** Number of loaded secrets */
  get size(): number {
    return this.secrets.size;
  }
}
