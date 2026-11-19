/**
 * The language of the engine's own notices — the pushes and mails the worker, the approval queue
 * and the inbox reminders send in the engine's words.
 *
 * One rule, and this function is its only home:
 * - `de…` or `en…` in `config.language` (`LYNOX_LANGUAGE` or `language` in config.json) decides;
 * - without one, or with a language there is no table for, an instance the control plane
 *   provisioned speaks German — its customers are German-speaking Swiss businesses, and the control
 *   plane sets no `LYNOX_LANGUAGE` — and a self-hosted one speaks English.
 *
 * "Provisioned" is {@link isProvisionedInstance}: any of the control plane's markers in the env,
 * which a process cannot change after exec. A managed customer who does not speak German gets
 * German until the control plane sets the language from the signup.
 *
 * Text a notice quotes (a task title, an error, a run's result) stays as it came: only the
 * engine's own sentences follow this.
 */
import { isProvisionedInstance } from './wire-capture.js';

export type NoticeLanguage = 'de' | 'en';

export function noticeLanguage(
  configured: string | undefined,
  provisioned: boolean = isProvisionedInstance(),
): NoticeLanguage {
  const value = configured?.trim().toLowerCase() ?? '';
  if (value.startsWith('de')) return 'de';
  if (value.startsWith('en')) return 'en';
  return provisioned ? 'de' : 'en';
}
