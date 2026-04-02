import type { SecretScope, SecretStoreLike, LynoxUserConfig } from '../types/index.js';
import { channels } from './observability.js';
import type { SecretVault } from './secret-vault.js';

export const SECRET_REF_PATTERN = /\bsecret:([A-Z_][A-Z0-9_]*)\b/g;

/**
 * Common secret patterns — regex-based detection for accidental secret leaks.
 * Used by ask_user guard and chat input warning.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  // OpenAI
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // Stripe
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}\b/,
  // GitHub
  /\b(ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/,
  // AWS
  /\bAKIA[A-Z0-9]{16}\b/,
  // Google
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  // Slack
  /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/,
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
    }
  }

  private _loadFromConfig(config: LynoxUserConfig): void {
    const wellKnown: Array<[string, string | undefined]> = [
      ['ANTHROPIC_API_KEY', config.api_key],
      ['VOYAGE_API_KEY', config.voyage_api_key],
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

  /** Whether a vault is attached */
  get hasVault(): boolean {
    return this.vault !== null;
  }

  /** Number of loaded secrets */
  get size(): number {
    return this.secrets.size;
  }
}
