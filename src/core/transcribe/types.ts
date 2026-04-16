/**
 * Transcription provider interface.
 *
 * Facade composes core glossary + (optional) session glossary over the provider's
 * raw text. The provider only speaks to its API with documented parameters.
 */

export type TranscribeLanguage = 'de' | 'en' | 'auto' | (string & {});

export interface TranscribeOpts {
  readonly language?: TranscribeLanguage | undefined;
  readonly tenantId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface RichTranscribeOpts extends TranscribeOpts {
  /** Session used to build the dynamic glossary. Sessionless calls get core glossary only. */
  readonly session?: TranscribeSessionContext | undefined;
  /** Disable the glossary post-process pass (bench/debug). Glossary is on by default. */
  readonly skipGlossary?: boolean | undefined;
}

export type SegmentCallback = (text: string) => void;

export interface TranscribeProvider {
  readonly name: 'whisper-cpp' | 'mistral-voxtral';
  readonly isAvailable: boolean;
  transcribe(buf: Buffer, filename: string, opts: TranscribeOpts): Promise<string | null>;
  transcribeStream?(buf: Buffer, filename: string, onSegment: SegmentCallback, opts: TranscribeOpts): Promise<string | null>;
}

/**
 * Minimal session surface the glossary session-builder reads.
 * Intentionally structural (not `Session`) so the builder is testable with
 * plain object stubs and doesn't pull the full engine graph into tests.
 */
export interface TranscribeSessionContext {
  readonly sessionId?: string | undefined;
  readonly threadId?: string | undefined;
  /** Current thread title + a small window of recent thread titles. */
  readonly threadTitles?: readonly string[] | undefined;
  /** CRM contact names scoped to this user/session. */
  readonly contactNames?: readonly string[] | undefined;
  /** Registered API/tool profile names. */
  readonly apiProfileNames?: readonly string[] | undefined;
  /** Knowledge-graph entity labels. */
  readonly kgEntityLabels?: readonly string[] | undefined;
  /** Custom workflow / pipeline names. */
  readonly workflowNames?: readonly string[] | undefined;
}
