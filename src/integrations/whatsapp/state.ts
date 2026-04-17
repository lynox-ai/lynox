// === WhatsApp state DB — messages + contacts cache ===
//
// Lives in ~/.lynox/whatsapp-state.db. Phase 0 stores:
//   - whatsapp_messages  — one row per Meta wa_id (inbound + outbound + echoes)
//                          for dedup and inbox rendering
//   - whatsapp_contacts  — phone → display name cache from webhook envelopes
//
// Credentials stay in the encrypted vault, never in this file.

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { getLynoxDir } from '../../core/config.js';
import { ensureDirSync } from '../../core/atomic-write.js';
import type {
  MessageDirection,
  MessageKind,
  WhatsAppContact,
  WhatsAppMessage,
  WhatsAppThreadSummary,
} from './types.js';

function defaultDbPath(): string {
  return join(getLynoxDir(), 'whatsapp-state.db');
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
   INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   CREATE TABLE IF NOT EXISTS whatsapp_messages (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     phone_e164 TEXT NOT NULL,
     direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
     kind TEXT NOT NULL,
     text TEXT,
     media_id TEXT,
     transcript TEXT,
     mime_type TEXT,
     timestamp INTEGER NOT NULL,
     is_echo INTEGER NOT NULL DEFAULT 0,
     is_read INTEGER NOT NULL DEFAULT 0,
     raw_json TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE INDEX IF NOT EXISTS idx_wa_msgs_thread ON whatsapp_messages(thread_id, timestamp);
   CREATE INDEX IF NOT EXISTS idx_wa_msgs_phone ON whatsapp_messages(phone_e164, timestamp);

   CREATE TABLE IF NOT EXISTS whatsapp_contacts (
     phone_e164 TEXT PRIMARY KEY,
     display_name TEXT,
     profile_name TEXT,
     last_seen_at INTEGER NOT NULL
   );`,
];

interface MessageRow {
  id: string;
  thread_id: string;
  phone_e164: string;
  direction: MessageDirection;
  kind: MessageKind;
  text: string | null;
  media_id: string | null;
  transcript: string | null;
  mime_type: string | null;
  timestamp: number;
  is_echo: number;
  is_read: number;
  raw_json: string;
  created_at: string;
}

interface ContactRow {
  phone_e164: string;
  display_name: string | null;
  profile_name: string | null;
  last_seen_at: number;
}

interface VersionRow { version: number }

export interface WhatsAppStateDbOptions {
  path?: string | undefined;
}

export class WhatsAppStateDb {
  private readonly db: Database.Database;

  constructor(opts?: WhatsAppStateDbOptions) {
    const path = opts?.path ?? defaultDbPath();
    if (path !== ':memory:') {
      ensureDirSync(join(path, '..'));
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.runMigrations();
  }

  private runMigrations(): void {
    const runSql = (sql: string): void => { this.db.exec(sql); };
    runSql(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
    const current = (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get() as VersionRow).version;
    for (let i = current; i < MIGRATIONS.length; i++) {
      runSql(MIGRATIONS[i]!);
    }
  }

  // ── Messages ──

  /** Insert a message if new. Returns true when inserted, false when already known (dedup). */
  upsertMessage(msg: WhatsAppMessage): boolean {
    const existing = this.db.prepare('SELECT id FROM whatsapp_messages WHERE id = ?').get(msg.id);
    if (existing) return false;
    this.db.prepare(`
      INSERT INTO whatsapp_messages (
        id, thread_id, phone_e164, direction, kind, text, media_id, transcript,
        mime_type, timestamp, is_echo, is_read, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.threadId,
      msg.phoneE164,
      msg.direction,
      msg.kind,
      msg.text,
      msg.mediaId,
      msg.transcript,
      msg.mimeType,
      msg.timestamp,
      msg.isEcho ? 1 : 0,
      0,
      msg.rawJson,
    );
    return true;
  }

  setTranscript(messageId: string, transcript: string): void {
    this.db.prepare('UPDATE whatsapp_messages SET transcript = ? WHERE id = ?').run(transcript, messageId);
  }

  markRead(messageId: string): void {
    this.db.prepare('UPDATE whatsapp_messages SET is_read = 1 WHERE id = ?').run(messageId);
  }

  markThreadRead(threadId: string): void {
    this.db.prepare('UPDATE whatsapp_messages SET is_read = 1 WHERE thread_id = ? AND direction = ?').run(threadId, 'inbound');
  }

  getMessagesForThread(threadId: string, limit = 100): WhatsAppMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM whatsapp_messages WHERE thread_id = ? ORDER BY timestamp ASC LIMIT ?
    `).all(threadId, Math.max(1, Math.min(limit, 500))) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessageById(messageId: string): WhatsAppMessage | null {
    const row = this.db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  // ── Contacts ──

  upsertContact(contact: WhatsAppContact): void {
    this.db.prepare(`
      INSERT INTO whatsapp_contacts (phone_e164, display_name, profile_name, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone_e164) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, whatsapp_contacts.display_name),
        profile_name = COALESCE(excluded.profile_name, whatsapp_contacts.profile_name),
        last_seen_at = excluded.last_seen_at
    `).run(contact.phoneE164, contact.displayName, contact.profileName, contact.lastSeenAt);
  }

  getContact(phoneE164: string): WhatsAppContact | null {
    const row = this.db.prepare('SELECT * FROM whatsapp_contacts WHERE phone_e164 = ?').get(phoneE164) as ContactRow | undefined;
    if (!row) return null;
    return {
      phoneE164: row.phone_e164,
      displayName: row.display_name,
      profileName: row.profile_name,
      lastSeenAt: row.last_seen_at,
    };
  }

  // ── Inbox view ──

  listThreadSummaries(limit = 50): WhatsAppThreadSummary[] {
    interface SummaryRow {
      thread_id: string;
      phone_e164: string;
      last_timestamp: number;
      last_text: string | null;
      last_transcript: string | null;
      last_kind: MessageKind;
      unread_count: number;
      has_voice: number;
      display_name: string | null;
    }
    const rows = this.db.prepare(`
      SELECT
        m.thread_id              AS thread_id,
        m.phone_e164             AS phone_e164,
        MAX(m.timestamp)         AS last_timestamp,
        (SELECT text       FROM whatsapp_messages WHERE thread_id = m.thread_id ORDER BY timestamp DESC LIMIT 1) AS last_text,
        (SELECT transcript FROM whatsapp_messages WHERE thread_id = m.thread_id ORDER BY timestamp DESC LIMIT 1) AS last_transcript,
        (SELECT kind       FROM whatsapp_messages WHERE thread_id = m.thread_id ORDER BY timestamp DESC LIMIT 1) AS last_kind,
        SUM(CASE WHEN direction = 'inbound' AND is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
        MAX(CASE WHEN kind = 'voice' AND direction = 'inbound' AND is_read = 0 THEN 1 ELSE 0 END) AS has_voice,
        c.display_name           AS display_name
      FROM whatsapp_messages m
      LEFT JOIN whatsapp_contacts c ON c.phone_e164 = m.phone_e164
      GROUP BY m.thread_id
      ORDER BY last_timestamp DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 200))) as SummaryRow[];

    return rows.map(r => ({
      threadId: r.thread_id,
      phoneE164: r.phone_e164,
      displayName: r.display_name,
      lastMessageAt: r.last_timestamp,
      lastMessagePreview: previewFor(r.last_kind, r.last_text, r.last_transcript),
      unreadCount: r.unread_count ?? 0,
      hasVoiceNote: (r.has_voice ?? 0) > 0,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToMessage(row: MessageRow): WhatsAppMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    phoneE164: row.phone_e164,
    direction: row.direction,
    kind: row.kind,
    text: row.text,
    mediaId: row.media_id,
    transcript: row.transcript,
    mimeType: row.mime_type,
    timestamp: row.timestamp,
    isEcho: row.is_echo !== 0,
    rawJson: row.raw_json,
  };
}

function previewFor(kind: MessageKind, text: string | null, transcript: string | null): string {
  if (text && text.length > 0) return clip(text, 120);
  if (transcript && transcript.length > 0) return `🎤 ${clip(transcript, 110)}`;
  switch (kind) {
    case 'voice': return '🎤 Sprachnachricht';
    case 'image': return '🖼️ Bild';
    case 'document': return '📄 Dokument';
    case 'location': return '📍 Standort';
    case 'contact': return '👤 Kontakt';
    case 'sticker': return 'Sticker';
    case 'reaction': return 'Reaktion';
    default: return '[nicht unterstützter Inhalt]';
  }
}

function clip(s: string, max: number): string {
  const norm = s.replace(/\s+/g, ' ').trim();
  return norm.length > max ? `${norm.slice(0, max - 1)}…` : norm;
}
