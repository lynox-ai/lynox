/**
 * Thin re-export layer for back-compat.
 *
 * The provider-abstracted implementation lives in `./transcribe/`. HTTP API
 * and Telegram bot continue to import `core/transcribe.js` — this file keeps
 * those import paths working and lets new callers opt into the richer facade
 * by importing `core/transcribe/index.js` directly.
 */

export {
  HAS_WHISPER,
  hasTranscribeProvider,
  getActiveTranscribeProvider,
  transcribeAudio,
  transcribeAudioStream,
  transcribe,
  transcribeWithStream,
  mistralVoxtralProvider,
  whisperCppProvider,
  hasMistralVoxtral,
  hasWhisperCpp,
} from './transcribe/index.js';

export type {
  TranscribeOpts,
  RichTranscribeOpts,
  SegmentCallback,
  TranscribeProvider,
  TranscribeSessionContext,
} from './transcribe/index.js';
