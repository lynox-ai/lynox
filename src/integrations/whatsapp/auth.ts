// === WhatsApp BYOK credentials — vault-backed storage ===
//
// One WABA per lynox instance in Phase 0. Credentials live encrypted in the
// SecretVault; env-vars override (standard lynox priority).

import type { SecretVault } from '../../core/secret-vault.js';
import type { WhatsAppCredentials } from './types.js';

const VAULT_KEY = 'WHATSAPP_CREDENTIALS';

const ENV_ACCESS_TOKEN = 'WHATSAPP_ACCESS_TOKEN';
const ENV_WABA_ID = 'WHATSAPP_WABA_ID';
const ENV_PHONE_NUMBER_ID = 'WHATSAPP_PHONE_NUMBER_ID';
const ENV_APP_SECRET = 'WHATSAPP_APP_SECRET';
const ENV_VERIFY_TOKEN = 'WHATSAPP_WEBHOOK_VERIFY_TOKEN';

function parseStored(raw: string): WhatsAppCredentials | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const fields = ['accessToken', 'wabaId', 'phoneNumberId', 'appSecret', 'webhookVerifyToken'] as const;
    for (const f of fields) {
      if (typeof o[f] !== 'string' || o[f] === '') return null;
    }
    return {
      accessToken: o['accessToken'] as string,
      wabaId: o['wabaId'] as string,
      phoneNumberId: o['phoneNumberId'] as string,
      appSecret: o['appSecret'] as string,
      webhookVerifyToken: o['webhookVerifyToken'] as string,
    };
  } catch {
    return null;
  }
}

function credsFromEnv(): WhatsAppCredentials | null {
  const accessToken = process.env[ENV_ACCESS_TOKEN];
  const wabaId = process.env[ENV_WABA_ID];
  const phoneNumberId = process.env[ENV_PHONE_NUMBER_ID];
  const appSecret = process.env[ENV_APP_SECRET];
  const verifyToken = process.env[ENV_VERIFY_TOKEN];
  if (!accessToken || !wabaId || !phoneNumberId || !appSecret || !verifyToken) return null;
  return {
    accessToken,
    wabaId,
    phoneNumberId,
    appSecret,
    webhookVerifyToken: verifyToken,
  };
}

/**
 * Load credentials — env vars win, then vault.
 * Returns null when incomplete (any field missing).
 */
export function loadCredentials(vault: SecretVault | null): WhatsAppCredentials | null {
  const fromEnv = credsFromEnv();
  if (fromEnv) return fromEnv;
  if (!vault) return null;
  const raw = vault.get(VAULT_KEY);
  if (!raw) return null;
  return parseStored(raw);
}

/** Persist credentials — throws if no vault is available. */
export function saveCredentials(vault: SecretVault, creds: WhatsAppCredentials): void {
  vault.set(VAULT_KEY, JSON.stringify(creds), 'any');
}

/** Remove stored credentials. Idempotent. */
export function clearCredentials(vault: SecretVault | null): void {
  if (!vault) return;
  vault.delete(VAULT_KEY);
}

/** True when all credential fields are non-empty. */
export function hasCredentials(vault: SecretVault | null): boolean {
  return loadCredentials(vault) !== null;
}
