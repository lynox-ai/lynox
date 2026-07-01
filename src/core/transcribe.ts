/**
 * Thin re-export layer for back-compat.
 *
 * The provider-abstracted implementation lives in `./transcribe/`. The HTTP
 * API still imports `core/transcribe.js` — this file keeps that import path
 * working and lets new callers opt into the richer facade by importing
 * `core/transcribe/index.js` directly.
 */

export {
  HAS_WHISPER,
  hasTranscribeProvider,
  getActiveTranscribeProvider,
  transcribeAudio,
  transcribeAudioStream,
  transcribe,
  transcribeWithStream,
  extractSessionContext,
  mistralVoxtralProvider,
  whisperCppProvider,
  hasMistralVoxtral,
  hasWhisperCpp,
  VOXTRAL_USD_PER_MIN,
} from './transcribe/index.js';

export type {
  TranscribeOpts,
  RichTranscribeOpts,
  SegmentCallback,
  TranscribeProvider,
  TranscribeSessionContext,
} from './transcribe/index.js';
