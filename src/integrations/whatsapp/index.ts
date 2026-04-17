// === WhatsApp integration — barrel export ===

export { WhatsAppContext } from './context.js';
export { WhatsAppStateDb } from './state.js';
export { WhatsAppClient } from './client.js';
export { dispatchWebhook } from './webhook.js';
export { verifySignature } from './signature.js';
export { parseWebhook, threadIdForPhone } from './webhook-parser.js';
export {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  hasCredentials,
} from './auth.js';
export type {
  WhatsAppCredentials,
  WhatsAppMessage,
  WhatsAppContact,
  WhatsAppThreadSummary,
  MetaWebhookEvent,
  MessageDirection,
  MessageKind,
} from './types.js';
