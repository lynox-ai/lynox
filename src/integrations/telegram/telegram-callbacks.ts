/** Unified callback store for Telegram inline button responses. */

export interface FollowUpEntry {
  label: string;
  task: string;
}

export interface InquiryEntry {
  options?: string[] | undefined;
}

// Chat follow-ups (from regular runs) — keyed by chatId
const chatFollowUps = new Map<number, FollowUpEntry[]>();

// Task follow-ups (from worker notifications) — keyed by taskId
const taskFollowUps = new Map<string, FollowUpEntry[]>();

// Task inquiries (from worker questions) — keyed by taskId
const taskInquiries = new Map<string, InquiryEntry>();

// ── Chat follow-ups (f: prefix) ──────────────────────────────────────────────

export function setChatFollowUps(chatId: number, entries: FollowUpEntry[]): void {
  chatFollowUps.set(chatId, entries);
}

export function getChatFollowUp(chatId: number, index: number): FollowUpEntry | undefined {
  return chatFollowUps.get(chatId)?.[index];
}

export function clearChatFollowUps(chatId: number): void {
  chatFollowUps.delete(chatId);
}

// ── Task follow-ups (t: prefix) ──────────────────────────────────────────────

export function setTaskFollowUps(taskId: string, entries: FollowUpEntry[]): void {
  taskFollowUps.set(taskId, entries);
}

export function getTaskFollowUp(taskId: string, index: number): FollowUpEntry | undefined {
  return taskFollowUps.get(taskId)?.[index];
}

export function clearTaskFollowUps(taskId: string): void {
  taskFollowUps.delete(taskId);
}

// ── Task inquiries (q: prefix) ───────────────────────────────────────────────

export function setTaskInquiry(taskId: string, entry: InquiryEntry): void {
  taskInquiries.set(taskId, entry);
}

export function getTaskInquiry(taskId: string): InquiryEntry | undefined {
  return taskInquiries.get(taskId);
}

export function clearTaskInquiry(taskId: string): void {
  taskInquiries.delete(taskId);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function clearAll(): void {
  chatFollowUps.clear();
  taskFollowUps.clear();
  taskInquiries.clear();
}
