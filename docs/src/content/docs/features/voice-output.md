---
title: Voice Output
description: Read assistant replies aloud — provider, latency, privacy, configuration.
sidebar:
  order: 7
---

lynox can read any assistant reply back to you. Tap the speaker icon that appears when you hover a reply and the audio plays in the browser. Useful for hands-busy moments, long replies on mobile, or accessibility.

## How it works

Text-to-speech runs server-side. The Web UI sends the reply text to `POST /api/speak`, which streams an MP3 back chunk-by-chunk. Playback starts roughly one second after the click on a typical 300-character reply.

Only one message speaks at a time — clicking a second speaker cancels the first.

## Auto-read replies

A toggle in the StatusBar (the speaker icon next to the run counter) flips lynox into auto-read mode. While on, every assistant reply is spoken back automatically — no clicks required.

The trigger fires per **text block**, not per turn. Long answers that interleave text and tool calls start speaking the first paragraph the moment a tool call begins; subsequent blocks queue up via `audio.onended` so playback chains seamlessly. You hear the assistant within ~1 s of the first paragraph completing instead of waiting for the entire turn (which can run 30 s+ on tool-heavy replies).

Toggling the speaker off mid-stream stops current audio and clears the queue.

## Provider

| Property              | Mistral Voxtral TTS                     |
|-----------------------|-----------------------------------------|
| Hosting               | Mistral La Plateforme (hosted in the EU by default)       |
| Model                 | `voxtral-mini-tts-3-0` (Voxtral TTS 3, pinned; Mistral lists it as Public Preview) |
| Default voice         | `en_paul_neutral` (English)             |
| Languages             | 35+ per Mistral; the voice catalog has voices for many of them |
| Streaming             | SSE; low-latency time-to-first-audio (varies by region/network) |
| Pricing               | $13 / 1 000 000 characters. See [Mistral pricing](https://docs.mistral.ai/inference/pricing) for the current number. |
| Training              | Customer text is not used to train models (per Mistral's terms) |

When no voice is chosen, lynox picks one from Mistral's catalog for the language of the interface, so German text is read with the catalog's German voice. A chosen voice is used for every language. Long inputs read with noticeably more prosodic nuance than very short ones (prosody is planned over the whole input). Should the model answer that it does not support a voice, lynox reads the text with the default voice instead of failing, also when that voice was chosen in the settings.

## Configuration

Set `tts_provider` in your `~/.lynox/config.json`:

```json
{
  "tts_provider": "auto"
}
```

Values:

- `"auto"` (default) — use Mistral if `MISTRAL_API_KEY` is set, otherwise disable.
- `"mistral"` — force Mistral Voxtral TTS. Requests return 503 if the key is missing.

The `LYNOX_TTS_PROVIDER` environment variable overrides the config value.

Requires an API key from [console.mistral.ai](https://console.mistral.ai/):

```bash
export MISTRAL_API_KEY=...
```

The same key powers voice input (transcription). One credential covers both directions.

## Privacy

- Audio is synthesized on Mistral's EU infrastructure and streamed straight back to your browser. No persistent storage by the provider.
- lynox does not retain the audio — the speaker button always re-synthesizes on click.
- The speaker button is hidden entirely when no TTS provider is available — so on self-hosted setups without a Mistral key, no dead control appears.

## Text preparation

Assistant replies are Markdown. Reading them verbatim would produce "asterisk-asterisk" for bold and read URLs character-by-character. Before the TTS call, lynox flattens the text to a spoken-friendly form:

- Fenced code blocks become sentence breaks.
- Inline code unwraps to its content.
- Bullet lists become `"x, y, und z."` connectors — short replies read with better prosody this way.
- Links keep their visible text; bare URLs drop out.
- Headings, emphasis markers, HTML, and blockquote markers are stripped.

## Cost

At $13 per million characters, typical use is well inside existing tier budgets. A user listening to 30 replies of ~300 characters per month pays about 12 cents. Heavy use (500 replies, 500 characters each) still lands at roughly $3.25 / month. Managed tenants gate voice on their credit balance — synthesis draws from the same included-AI budget as other usage — and per-tenant character counts are logged for review.

## Troubleshooting

- **No speaker icon appears next to replies** — the TTS provider reports unavailable. Check that `MISTRAL_API_KEY` is set on the server; the icon is deliberately hidden (not disabled) to keep unavailable controls out of the UI.
- **"Could not play audio" toast** — network error or the browser blocked playback. Reload and try again; autoplay policies require a user gesture to start audio, which the button press satisfies.
- **Audio starts but cuts off early** — the network stream was interrupted. The next click re-synthesizes from the beginning.
- **German text is read with an English voice** — a voice chosen in the settings is used for every language; clear it to let lynox pick the German one. Without Mistral's voice catalog (unreachable at that moment) lynox has no German voice to pick and reads with the default voice. Long replies sound noticeably better than very short ones because prosody is planned over the full input.
