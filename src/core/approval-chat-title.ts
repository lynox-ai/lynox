/**
 * The title of a chat opened on an approval entry whose draft loaded ("Im Chat öffnen",
 * "In den Chat verschieben", "Im Chat neu erstellen").
 *
 * Such a chat's first line is a fixed sentence the web-ui sends, the same for every entry, so a
 * title taken from it names every such chat alike. The draft's subject would tell them apart, but
 * it is text the agent wrote, possibly after reading someone else's, and a chat title travels on:
 * other chats' dictation reads the titles of chats that are not contained
 * (`transcribe/session-context.ts › readThreadTitles`), and opening an approval chat contains
 * nothing. So the title carries no character of the entry: a fixed phrase in the engine's notice
 * language and the moment the chat was opened, from the engine's clock.
 *
 * The date is assembled from numbers and a fixed month table, not from a locale's formatted
 * string, so what the title can contain does not depend on the runtime's locale data. The user's
 * time zone only moves the numbers; a zone the runtime does not know falls back to the engine's.
 */
import type { NoticeLanguage } from './notice-language.js';

const PHRASE: Readonly<Record<NoticeLanguage, string>> = {
  de: 'Entwurf überarbeiten',
  en: 'Revise draft',
};

const MONTHS: Readonly<Record<NoticeLanguage, readonly string[]>> = {
  de: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

interface WallClock { day: number; month: number; hour: number; minute: number }

function wallClock(at: Date, timeZone: string | null | undefined): WallClock {
  const read = (tz: string | undefined): WallClock => {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(tz !== undefined ? { timeZone: tz } : {}),
      day: 'numeric', month: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(at);
    const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    return { day: num('day'), month: num('month'), hour: num('hour'), minute: num('minute') };
  };
  if (timeZone !== null && timeZone !== undefined && timeZone !== '') {
    try {
      return read(timeZone);
    } catch {
      // An unknown zone: the engine's own clock below.
    }
  }
  return read(undefined);
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "Entwurf überarbeiten · 4. Nov., 15:32" / "Revise draft · 4 Nov, 15:32". */
export function approvalChatTitle(language: NoticeLanguage, at: Date, timeZone?: string | null): string {
  const t = wallClock(at, timeZone);
  const month = MONTHS[language][t.month - 1];
  if (month === undefined || !Number.isInteger(t.day) || !Number.isInteger(t.hour) || !Number.isInteger(t.minute)) {
    return PHRASE[language];
  }
  const day = language === 'de' ? `${String(t.day)}. ${month}` : `${String(t.day)} ${month}`;
  return `${PHRASE[language]} · ${day}, ${two(t.hour)}:${two(t.minute)}`;
}
