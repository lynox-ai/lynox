/**
 * Thin re-export layer for the speak (TTS) facade.
 *
 * Mirrors `core/transcribe.ts`: HTTP API and (future) integrations import from
 * `core/speak.js` so the structured sub-tree at `core/speak/` stays internal.
 */

export {
  speak,
  speakStream,
  getActiveSpeakProvider,
  hasSpeakProvider,
  prepareForSpeech,
  mistralVoxtralTtsProvider,
  speakMistralVoxtral,
  speakMistralVoxtralStream,
  hasMistralVoxtralTts,
  listMistralVoices,
  VOXTRAL_TTS_MODEL,
  DEFAULT_VOICE,
} from './speak/index.js';

export type {
  Lang,
  SpeakOpts,
  RichSpeakOpts,
  SpeakResult,
  SpeakStreamMeta,
  SpeakProvider,
  SpeakProviderName,
  AudioChunkCallback,
  VoiceInfo,
} from './speak/index.js';
