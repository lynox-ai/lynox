---
title: Voice Messages
description: Voice-to-text transcription — provider choice, privacy, configuration.
sidebar:
  order: 6
---

lynox accepts voice input on two surfaces:

- **Web UI (primary)** — record in the browser, transcript is sent back for review or submitted directly as a message.
- **Telegram bot (secondary)** — forward a voice message to the bot and it transcribes before running the task.

Transcription happens server-side. Two providers are supported; you can choose which one runs.

## Keyboard shortcut

In the Web UI, **double-tap ⌘ (macOS) or Ctrl (Windows/Linux)** to start or stop recording — no chord, just two quick taps on the bare modifier within 350 ms. The shortcut is intentionally collision-free with every other browser/OS binding (a bare modifier is never used as a hotkey anywhere else), so it works the same in any focused field. Stop with the same gesture or click the microphone icon.

## Provider matrix

| Provider              | Speed (60 s clip) | German WER (business speech) | Cost        | Hosting                    | When to use                                                       |
|-----------------------|-------------------|-------------------------------|-------------|----------------------------|-------------------------------------------------------------------|
| **Mistral Voxtral**   | ~2 s              | ~10 % on mixed DE/EN          | $0.003/min  | Mistral La Plateforme (Paris) | Default for cloud and BYOK setups. Fast, EU-hosted, no training on your audio. |
| **whisper.cpp**       | several seconds (CPU) | ~23 % on mixed DE/EN      | free        | Local (your server)        | Air-gapped self-host. OSS fallback when no Mistral key is set.    |

Numbers come from the Phase 0 spike on ten self-recorded German-business-speech clips (see PRD `voice-transcription-v2.md`). whisper.cpp uses the ggml-base model on CPU.

## Configuration

### Provider selection

Set `transcription_provider` in your `~/.lynox/config.json`:

```json
{
  "transcription_provider": "auto"
}
```

Values:

- `"auto"` (default) — use Mistral if `MISTRAL_API_KEY` is set, otherwise whisper.cpp.
- `"mistral"` — force Mistral Voxtral. Transcription fails if the key is missing.
- `"whisper"` — force local whisper.cpp. Transcription fails if the binary/model are missing.

The `LYNOX_TRANSCRIBE_PROVIDER` environment variable overrides the config value.

### Mistral Voxtral

Requires an API key from [console.mistral.ai](https://console.mistral.ai/):

```bash
export MISTRAL_API_KEY=...
```

lynox calls the `/v1/audio/transcriptions` endpoint with model `voxtral-mini-2602`. Only the documented parameters are sent (`file`, `model`, `language`). Your recording is transmitted to Mistral's EU infrastructure; per Mistral's terms, customer audio is not used to train models.

### whisper.cpp

Requires the `whisper-cli` binary and a ggml model on the host:

```bash
# macOS
brew install whisper-cpp ffmpeg
# ggml model
curl -L -o ~/.local/share/whisper/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

Defaults to the `base` model; falls back to `tiny` for clips under 10 seconds.

## Glossary repair

Speech-to-text systems mis-hear proper nouns and product vocabulary in predictable ways. lynox applies a two-layer glossary to the raw transcript before returning it:

- **Core glossary** — lynox product vocabulary (`Setup Wizard`, `Go-Live`, `Knowledge Graph`, …). Seeded from known mishearings; extended via PR as new surface-area names ship.
- **Session glossary** — built at call time from your own context: CRM contact names, registered API/tool names, recent thread titles, Knowledge-Graph entity labels, custom workflow names. A short edit-distance match (≤2) rewrites nearby tokens when they are not in a common-language stop list — so `Rolland` becomes `Roland` but `rund` is left alone.

Both passes run in single-digit milliseconds. The glossary never leaves the lynox process; your vocabulary is never part of the audio-transcription API request.

## Privacy

- Mistral-hosted audio: sent to Paris, not retained for training, not stored post-transcription per Mistral's terms.
- whisper.cpp: audio never leaves the server; transient `/tmp` files are deleted after each transcription.
- The Web UI shows a short privacy hint under the voice button indicating which provider is in use.
- No audio is retained by lynox — only the final text goes into the thread history.

## Troubleshooting

- **"Transcription not available"** — check that `MISTRAL_API_KEY` is set or that whisper.cpp is installed.
- **Short clips mis-transcribed** — whisper.cpp uses the `tiny` model for clips ≤10 s; record a slightly longer utterance to get the more accurate `base` model.
- **Product term still wrong** — if a new lynox product name ships and is mis-heard, add it to the core glossary (`src/core/transcribe/glossary/core-terms.ts`). Contact/tool names self-heal from the session glossary.
