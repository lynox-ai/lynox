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

## Provider

| Property              | Mistral Voxtral TTS                     |
|-----------------------|-----------------------------------------|
| Hosting               | Mistral La Plateforme, Paris (EU)       |
| Model                 | `voxtral-mini-tts-latest`               |
| Default voice         | `en_paul_neutral` (English)             |
| Languages             | 9 supported; voice catalog currently EN-only |
| Streaming             | SSE; ~1 s time-to-first-audio from Zurich |
| Pricing (as of 2026)  | $0.016 / 1 000 characters (~$0.02/min spoken) |
| Training              | Customer text is not used to train models (per Mistral's terms) |

German text is read with an English voice. The accent is light and acceptable for business replies — long inputs read with noticeably more prosodic nuance than very short ones (prosody is planned over the whole input). A dedicated German voice will become the default once Mistral ships one.

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

At $0.016 per 1 000 characters, typical use is well inside existing tier budgets. A user listening to 30 replies of ~300 characters per month pays about 15 cents. Heavy use (500 replies, 500 characters each) still lands at roughly $4 / month. Phase 1 ships without per-tier gating — if a pathological pattern emerges, per-tenant character counts are logged and can be reviewed.

## Troubleshooting

- **No speaker icon appears next to replies** — the TTS provider reports unavailable. Check that `MISTRAL_API_KEY` is set on the server; the icon is deliberately hidden (not disabled) to keep unavailable controls out of the UI.
- **"Could not play audio" toast** — network error or the browser blocked playback. Reload and try again; autoplay policies require a user gesture to start audio, which the button press satisfies.
- **Audio starts but cuts off early** — the network stream was interrupted. The next click re-synthesizes from the beginning.
- **German pronunciation sounds off** — the default voice is English. Long replies sound noticeably better than very short ones because prosody is planned over the full input; a German voice will replace the current default as soon as Mistral ships one.
