/**
 * Mistral Voxtral TTS provider.
 *
 * POST https://api.mistral.ai/v1/audio/speech (JSON):
 *   { model, input, voice, stream?: boolean }
 * Auth: Authorization: Bearer <MISTRAL_API_KEY>
 *
 * Plain response:  application/json, body `{"audio_data": "<base64 MP3>"}`.
 * Stream response: text/event-stream, SSE frames:
 *   event: speech.audio.delta
 *   data: {"type":"speech.audio.delta","audio_data":"<base64_chunk>"}
 *
 * Endpoint rejects `language` outright (422 extra_forbidden) — re-verified
 * 2026-08-02 against the live API, still true on the pinned v26.03 model. Do
 * not attempt to pass `language`.
 *
 * The catalog is NOT EN-only, which this comment claimed until 2026-08-02. All
 * 30 voices, enumerated via `offset`/`limit` (see VOICES_BASE_URL): 8 `en_us`,
 * 16 `en_gb`, **6 `fr_fr`** (`fr_marie_*`). Still no German voice.
 *
 * "Multilingual" in Mistral's docs (English, French, Spanish, Portuguese,
 * Italian, Dutch, German, Hindi, Arabic) means cross-lingual voice cloning —
 * and the model really does articulate German correctly: the same German
 * sentence (umlauts + a compound noun) synthesised with `en_paul_neutral` and
 * with `fr_marie_neutral`, then transcribed back, returned identical to the
 * source both times. What a German listener hears as an accent is SPEAKER
 * IDENTITY, not mispronunciation. Removing it needs a German voice in the
 * catalog — or a non-Voxtral path for non-English text.
 *
 * No usage or rate-limit headers are exposed. Character counting for per-tenant
 * cost attribution happens facade-side. EU-hosted (Mistral La Plateforme, Paris).
 */

import { getErrorMessage } from '../utils.js';
import type {
  AudioChunkCallback,
  SpeakOpts,
  SpeakProvider,
  SpeakResult,
  SpeakStreamMeta,
  VoiceInfo,
} from './types.js';

/**
 * Pinned model version. Was `voxtral-mini-tts-latest`; pinned to the concrete
 * v26.03 tag 2026-07-26 — `-latest` aliases violate our no-floating-tag rule
 * (rate-limit surprises on a silent server-side bump), and v26.03 is the newest
 * documented release (better cross-lingual pronunciation of DE text than v26.02).
 */
export const VOXTRAL_TTS_MODEL = 'voxtral-mini-tts-2603';

/**
 * Default voice — English, reads DE text with a light English accent. Rafael
 * approved on the Phase 0 p300/p3000 DE samples. `de_*` are still NOT available:
 * re-checked 2026-08-02 against the live catalog (30 voices — 8 en_us, 16 en_gb,
 * 6 fr_fr; no German).
 *
 * ⚠️ "The live fetch below will surface `de_*` automatically the moment Mistral
 * ships them — nothing to do here until then" used to stand here and is FALSE.
 * The fetch paginates with `page`, which this endpoint ignores, so it only ever
 * sees the first 10 slugs — a German voice would land past that and stay
 * invisible. There IS something to do first, and it is the pagination fix (see
 * VOICES_BASE_URL). The same false promise sat on FALLBACK_VOICES below.
 */
export const DEFAULT_VOICE = 'en_paul_neutral';

const API_URL = 'https://api.mistral.ai/v1/audio/speech';
// Mistral caps `page_size` at 10 regardless of what we request — confirmed
// 2026-04-21 against the live API.
//
// ⚠️ "We paginate explicitly to fetch all voices" used to stand here and is
// FALSE. Measured 2026-08-02 against the live API: the `page` parameter is
// IGNORED. Pages 0, 1 and 7 return byte-identical items and `page_size=200`
// also returns 10, while the response still reports `total: 30,
// total_pages: 3` (and echoes `page: 1` whatever you send). The loop below
// therefore fetches the same first 10 voices three times; the dedup-by-id
// keeps the result honest, so the picker shows 10 of 30 rather than
// duplicates — but 20 voices are unreachable, INCLUDING the six French
// `fr_marie_*` ones. `offset`/`limit` is what actually paginates this
// endpoint and returns all 30.
const VOICES_BASE_URL = 'https://api.mistral.ai/v1/audio/voices';
// Hard page ceiling so a buggy `total_pages` response can't spin forever.
// 30 voices × 10/page = 3 pages today; 100 pages would be 1000 voices.
const VOICES_MAX_PAGES = 100;
// Asked for, not assumed: the endpoint caps a page at 10 today, so this is an
// upper bound rather than a promise. The loop never relies on getting `limit`
// entries back — it advances by what arrived.
const VOICES_PAGE_LIMIT = 100;

/**
 * Fallback voice catalog for the Settings picker when the live `/v1/audio/voices`
 * call is unreachable. A representative EN subset; safe to stay out-of-date
 * because the live fetch overwrites this in the UI the moment Mistral is
 * reachable. Still do not add hardcoded DE entries — there is no German voice to
 * add (live catalog 2026-08-02: 8 en_us, 16 en_gb, 6 fr_fr).
 *
 * ⚠️ "`de_*` slugs will appear automatically once the catalog ships them" used
 * to stand here and is FALSE for the same reason as on DEFAULT_VOICE: the live
 * fetch paginates with `page`, which the endpoint ignores, so it sees only the
 * first 10 slugs. Note this list is also EN-only while six `fr_marie_*` voices
 * exist — the fallback mirrors what the broken fetch can see, not the catalog.
 */
const FALLBACK_VOICES: ReadonlyArray<VoiceInfo> = [
  { id: 'en_paul_neutral',    language: 'en', description: 'Paul — neutral' },
  { id: 'en_alex_neutral',    language: 'en', description: 'Alex — neutral' },
  { id: 'en_mary_neutral',    language: 'en', description: 'Mary — neutral' },
  { id: 'en_john_neutral',    language: 'en', description: 'John — neutral' },
  { id: 'en_sara_neutral',    language: 'en', description: 'Sara — neutral' },
];

// MOVED to `./types.js` so the `SpeakProvider` contract can name it; re-exported
// here because four call sites import it from this module.
export type { VoiceInfo } from './types.js';

let _voicesCache: { voices: VoiceInfo[]; expiresAt: number } | null = null;
const VOICES_TTL_MS = 60 * 60_000; // 1 hour

/**
 * Fetch the Mistral Voxtral voice catalog for the Settings → Compliance
 * picker. Returns the cached list inside the 1h TTL; on first call or after
 * expiry, queries `/v1/audio/voices` with a 2s timeout. On any failure
 * (no key, network error, unexpected shape) returns the hardcoded
 * FALLBACK_VOICES so the UI is never voice-pickerless.
 */
/**
 * Parse one page of the Mistral voices response into our VoiceInfo shape.
 * Separated from the pagination loop so the shape-tolerance logic stays
 * readable. Accepts `items` / `data` / `voices` / bare array containers.
 */
function parseVoicesPage(body: unknown): { voices: VoiceInfo[]; total: number | undefined; rawCount: number } {
  // Mistral's actual response shape (probed 2026-04-21):
  //   { items: [{ slug, name, languages: [...], gender, age, tags, id, ... }], total, page, page_size, total_pages }
  // `slug` is the synthesis-friendly voice selector ('en_paul_neutral').
  // `id` is a provider UUID and not usable as a voice parameter.
  const raw: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['items'])
      ? (body as { items: unknown[] }).items
      : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['data'])
        ? (body as { data: unknown[] }).data
        : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['voices'])
          ? (body as { voices: unknown[] }).voices
          : [];
  // `total` rather than `total_pages`: the loop now advances by an offset, and
  // `total_pages` is derived from a page size this endpoint does not honour.
  const total = body && typeof body === 'object' && typeof (body as { total?: unknown }).total === 'number'
    ? (body as { total: number }).total
    : undefined;
  const voices = raw.flatMap((entry): VoiceInfo[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    // Prefer `slug` (Mistral's synthesis selector). Fall back to `voice` or
    // `id` for other provider shapes. Note: Mistral's `id` is a UUID — accept
    // it last, since using it as a voice param would fail.
    const id = typeof e['slug'] === 'string' ? e['slug']
      : typeof e['voice'] === 'string' ? e['voice']
      : typeof e['id'] === 'string' ? e['id']
      : undefined;
    if (!id) return [];
    // `languages` is an array (['en_us']); take the first and normalize
    // 'en_us' → 'en' for the UI. Single-string `language` accepted as fallback.
    const languages = Array.isArray(e['languages']) ? e['languages'] as unknown[] : null;
    const rawLang = languages && typeof languages[0] === 'string' ? languages[0] as string
      : typeof e['language'] === 'string' ? e['language']
      : id.split('_')[0];
    const language = rawLang ? rawLang.split('_')[0] : undefined;
    // `name` is the human-readable label ('Paul - Neutral').
    const description = typeof e['name'] === 'string' ? e['name']
      : typeof e['description'] === 'string' ? e['description']
      : typeof e['display_name'] === 'string' ? e['display_name']
      : undefined;
    return [language !== undefined ? { id, language, ...(description ? { description } : {}) } : { id, ...(description ? { description } : {}) }];
  });
  // `rawCount` is what the offset must advance by, and it is deliberately NOT
  // `voices.length`: an entry without a usable `slug` is dropped from `voices`
  // but still occupies a position in the provider's list. Advancing by the
  // parsed count would re-request or skip entries — the same off-by-a-page
  // mistake as the bug this replaces, in a new shape.
  return { voices, total, rawCount: raw.length };
}

export async function listMistralVoices(): Promise<VoiceInfo[]> {
  const now = Date.now();
  if (_voicesCache && _voicesCache.expiresAt > now) return _voicesCache.voices;
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return [...FALLBACK_VOICES];
  // Hoisted so the catch can still see what the loop had collected, and so the
  // cache TTL can depend on whether the walk was clean.
  const partial: VoiceInfo[] = [];
  // ONE flag with ONE meaning: "this walk reported something", and ONE writer for it.
  // Every diagnostic goes through `report`, which sets the flag and warns in a single
  // statement, so a warned catalogue cannot keep the hour-long cache lifetime. Measured
  // on the version before it: 29 of 30 voices with two warnings fired, and the second
  // call five minutes later did not re-fetch.
  //
  // ⚠ What holds that, and what does not. A lint rule in `eslint.config.js` makes a
  // `console` member access an error in this file, so the ordinary ways to add a second
  // warning are caught; destructuring and `globalThis` routes are not, and that rule's
  // comment says which. Spies in the test file catch `console.error`,
  // `process.std{out,err}.write` and `process.emitWarning` on walked paths. A stray
  // `doubtful = true` outside `report` is caught by neither of those two, and IS caught
  // by `holds a complete catalogue for the long TTL, not the short one`, which asserts
  // no re-fetch five minutes on.
  //
  // ⚠ That last sentence said "in silence" until a round planted the flag properly. My
  // probe had been `if (offset < 0) doubtful = true;` — `offset` is never negative, so
  // it never RAN, and its green measured the guard rather than the subject. A guarded
  // plant on an unreachable branch is a broken probe, and this one erred DOWNWARD: it
  // told a reader to build a control that already existed.
  //
  // Earlier mechanisms for this property were built and retired, each defeated by
  // something its author had not enumerated. No count here: two files carried two
  // different ones (seven retired against six), and neither was derivable from the tree.
  // The history and the open shapes are a register row; what belongs here is which
  // mechanism holds which half.
  let doubtful = false;
  const report = (message: string): void => {
    doubtful = true;
    // The ONE sanctioned diagnostic channel of this module. `eslint.config.js` has a
    // block for this file that makes a `console` MEMBER ACCESS an error, so adding a
    // second diagnostic in one of the caught shapes has to WIDEN this exemption, and
    // the widening shows up in a diff.
    //
    // ⚠ What this said first — "needs a second disable comment" — is false, and the
    // commit that wrote it disproved it three paragraphs further down: changing this
    // line to a file-wide `/* eslint-disable no-restricted-syntax */` is still ONE
    // directive and lets every shape through. The barrier is not the COUNT of
    // directives, it is that a change to their SCOPE is visible. That is exactly why
    // the test which counted them was taken out again.
    //
    // ⚠ NOT "forbids every console access", which is what this said first. Measured:
    // `const { warn } = console; warn(…)` is an ObjectPattern and walks through, as do
    // the four `globalThis`/`Reflect` routes — five of the NINE shapes that were run.
    // Nine is the size of the list, not of the set: a later round found five more by
    // trying, three caught and two not. The enumeration is in `eslint.config.js` beside
    // the rule, and it is written there as OPEN.
    //
    // ⚠ The directive must sit on the line IMMEDIATELY above the call: it disables the
    // NEXT line, so with the explanation written after it, it covered a comment line and
    // eslint reported it as unused while the call itself stayed flagged.
    // eslint-disable-next-line no-restricted-syntax
    console.warn(message);
  };
  try {
    const controller = new AbortController();
    // ⚠ This said "2 s per request × up to MAX_PAGES pages means worst case ~200 s"
    // and that was false, contradicted by its own next sentence: ONE controller and
    // ONE timer created before the loop bound the WHOLE loop at 2 s. The wrong half
    // is the one a reader would use for latency reasoning — and the real budget is
    // the tighter one, so a catalogue that grows past what fits in 2 s degrades at a
    // cliff rather than on a slope.
    // Signal controls the whole loop — if the first page is slow we still
    // bail after 2 s without starting page 2.
    const timer = setTimeout(() => controller.abort(), 2_000);
    const voices: VoiceInfo[] = partial;
    try {
      // `offset`/`limit`, because `page`/`page_size` are IGNORED by this endpoint
      // (see the block above VOICES_BASE_URL for the measurement). Dedup by id
      // stays as a belt-and-braces measure.
      //
      // The loop advances by what it RECEIVED, not by the limit it asked for.
      // That matters for the failure mode this fix is about: if a pagination
      // parameter is ignored, every request returns the same first entries, and
      // a loop that assumed its own page size would march the offset past the
      // end and report success on one page of data. Advancing by `rawCount` and
      // stopping when a response is empty or adds nothing new means an ignored
      // parameter shows up as a SHORTFALL against `total` rather than as a
      // plausible-looking list.
      const seen = new Set<string>();
      let offset = 0;
      let total: number | undefined;
      // Four counters, because a review proved that fewer cannot tell the cases
      // apart. `receivedRaw` is arrivals (duplicates counted twice), `unusable`
      // is entries with no usable slug, `dupes` is entries we had already seen,
      // and `voices.length` is what the caller gets. The differences are what
      // name a cause, and an earlier version of this block compared the wrong
      // pair: `receivedRaw < total` passes whenever duplicates happen to fill the
      // count up to `total` — measured, a server page of 15 with `total: 30`
      // delivered 15 voices and warned about nothing.
      let receivedRaw = 0;
      let unusable = 0;
      let dupes = 0;
      // "The pagination parameter is being ignored" is a specific observation and
      // deserves its own flag rather than being inferred from a shortfall: it is
      // knowable WITHOUT `total`, and inferring it from a shortfall also fires when
      // the shortfall has a different cause.
      let ignoredPagination = false;
      for (let round = 0; round < VOICES_MAX_PAGES; round++) {
        const url = `${VOICES_BASE_URL}?offset=${offset}&limit=${VOICES_PAGE_LIMIT}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} at offset ${offset}`);
        const body: unknown = await response.json();
        const parsed = parseVoicesPage(body);
        // Round 0 only: a `total` that changes mid-walk is a provider bug, and
        // re-reading it would let a later response shorten the walk.
        if (round === 0) total = parsed.total;
        // Nothing arrived: the offset cannot advance, so nothing else can either.
        // This is NOT redundant with the duplicate check below — that one needs
        // parseable entries to fire.
        if (parsed.rawCount === 0) break;
        let newThisRound = 0;
        for (const v of parsed.voices) {
          if (seen.has(v.id)) { dupes++; continue; }
          seen.add(v.id);
          voices.push(v);
          newThisRound++;
        }
        offset += parsed.rawCount;
        receivedRaw += parsed.rawCount;
        unusable += parsed.rawCount - parsed.voices.length;
        // ⚠ THE predicate, and its first version was wrong in a way a review had
        // to measure: it broke when no NEW voices arrived, which is true both when
        // the offset is ignored (everything already seen) and when a page happens
        // to be entirely unusable (nothing parseable at all). The second is a
        // payload problem, the offset DID advance, and stopping there truncates the
        // catalogue — and then reported the truncation as a pagination fault. So
        // the break now requires that entries were parseable AND all already seen,
        // which is the only shape that means the offset did not move the window.
        if (parsed.voices.length > 0 && newThisRound === 0) {
          ignoredPagination = true;
          break;
        }
        // ⚠ No `offset >= total` break. It was pure optimisation — the round
        // ceiling and the duplicate check already terminate every sequence — and it
        // could only lose data: a provider that UNDER-reports `total` truncated the
        // walk silently (measured: `total: 10` with 30 voices present returned 10
        // after one request, no warning). One extra request is the cheaper side of
        // that trade.
      }
      // Three separate statements, because three separate causes with three
      // different remedies. The earlier single check could not express any of them
      // without also claiming the others.
      if (ignoredPagination) {
        report(
          '[speak] Mistral voice catalogue: a page came back entirely already-seen — ' +
            'the `offset` parameter is not being honoured. Look at the request.',
        );
      }
      if (total !== undefined && voices.length < total) {
        report(
          `[speak] Mistral voice catalogue: ${voices.length} of ${total} voices reached the picker ` +
            `(${receivedRaw} entries arrived, ${dupes} duplicate, ${unusable} unusable).`,
        );
      }
      if (unusable > 0) {
        // ⚠ The tail is conditional, and it has to be: with BOTH causes present the
        // flat version said "not the request" one line below a warning that said
        // "Look at the request." Two diagnostics contradicting each other, in the
        // block whose comment promises that cannot happen. Measured with the offset
        // ignored and one entry unusable — all three fired, and the third denied
        // what the first had just reported.
        report(
          `[speak] Mistral voice catalogue: ${unusable} of ${receivedRaw} arrived entries had no ` +
            'usable voice slug and were dropped — ' +
            (ignoredPagination
              ? 'a payload problem ON TOP of the request problem above; both need looking at.'
              : 'look at the payload, not the request.'),
        );
      }
    } finally {
      clearTimeout(timer);
    }
    // If Mistral returned an empty first page (mis-deployed shape, etc.) fall
    // back so the UI isn't voice-pickerless.
    const final = voices.length === 0 ? [...FALLBACK_VOICES] : voices;
    // ⚠ A result that warned is cached for 60 s, not an hour. Measured on the
    // earlier version: an incomplete catalogue was served for a full hour off one
    // stderr line, while an outright ERROR was retried after a minute — an
    // incomplete success was treated as more authoritative than a failure.
    const complete = voices.length > 0 && !doubtful;
    _voicesCache = { voices: final, expiresAt: now + (complete ? VOICES_TTL_MS : 60_000) };
    return final;
  } catch (err) {
    // ⚠ Keep what we already collected. Measured on the earlier version: a 2 s
    // abort part-way through a large catalogue, or one 500 on a later page,
    // discarded every voice already in hand and returned the five-entry EN-only
    // fallback with no log line at all — the silent truncation this whole change
    // exists to prevent, worse on the failure path than on the success one.
    // Through `report` as well. Setting the flag here is inert — both writes on this
    // path are hard 60 s — but "every diagnostic goes through report" must not be a
    // sentence with an exception, or it is the same over-claim again.
    //
    // ⚠ This used to add "so the file has exactly ONE `console.warn` and the claim
    // above is literally true". That was a pointer to a claim I then rewrote: the
    // check no longer counts `console.warn` across the FILE, so nothing held the
    // sentence, and the claim it vouched for had stopped existing. The correction of
    // a claim has to sweep every place that repeats it — this file had the claim in
    // two rooms and I only repainted one.
    report(`[speak] Mistral voice catalogue: fetch ended early — ${String(err)}`);
    if (partial.length > 0) {
      _voicesCache = { voices: partial, expiresAt: now + 60_000 };
      return partial;
    }
    // Cache the fallback briefly too (60 s) so a flapping network doesn't
    // spam Mistral every request.
    _voicesCache = { voices: [...FALLBACK_VOICES], expiresAt: now + 60_000 };
    return [...FALLBACK_VOICES];
  }
}

export function hasMistralVoxtralTts(): boolean {
  return !!process.env['MISTRAL_API_KEY'];
}

interface RequestMeta {
  readonly model: string;
  readonly voice: string;
  readonly characters: number;
}

function buildBody(text: string, opts: SpeakOpts, stream: boolean): { body: string; meta: RequestMeta } {
  const model = opts.model ?? VOXTRAL_TTS_MODEL;
  const voice = opts.voice ?? DEFAULT_VOICE;
  return {
    body: JSON.stringify({ model, input: text, voice, stream }),
    meta: { model, voice, characters: text.length },
  };
}

function logRequest(meta: RequestMeta, latencyMs: number, mode: 'plain' | 'stream', tenantId: string | undefined): void {
  process.stderr.write(
    `[voxtral-tts] ${meta.model} ${mode} ${latencyMs}ms ${meta.characters}chars voice=${meta.voice}${tenantId ? ` tenant=${tenantId}` : ''}\n`,
  );
}

function logError(status: number, statusText: string, body: string, tenantId: string | undefined): void {
  process.stderr.write(
    `[voxtral-tts] ${String(status)} ${statusText}${tenantId ? ` (tenant=${tenantId})` : ''}: ${body.slice(0, 300)}\n`,
  );
}

/** One-shot synthesis. Returns decoded MP3 bytes + telemetry, or null on failure. */
export async function speakMistralVoxtral(text: string, opts: SpeakOpts = {}): Promise<SpeakResult | null> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return null;
  if (!text.trim()) return null;

  const { body, meta } = buildBody(text, opts, false);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logError(res.status, res.statusText, await res.text().catch(() => ''), opts.tenantId);
      return null;
    }
    const json = (await res.json()) as { audio_data?: unknown };
    if (typeof json.audio_data !== 'string') {
      process.stderr.write('[voxtral-tts] response missing "audio_data"\n');
      return null;
    }
    const mp3 = decodeBase64(json.audio_data);
    const latencyMs = Date.now() - started;
    logRequest(meta, latencyMs, 'plain', opts.tenantId);
    return {
      mp3,
      characters: meta.characters,
      provider: 'mistral-voxtral-tts',
      model: meta.model,
      voice: meta.voice,
      latencyMs,
    };
  } catch (err: unknown) {
    process.stderr.write(`[voxtral-tts] request failed: ${getErrorMessage(err)}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming synthesis. Emits decoded MP3 byte chunks to `onChunk` as they
 * arrive. Returns stream telemetry (including time-to-first-byte) on success,
 * or null on failure. Streaming is mandatory for the PRD's ≤ 1.5 s TTFA target
 * on replies > ~200 chars (plain mode: 2.17 s at 300 chars; stream: 1.25 s).
 */
export async function speakMistralVoxtralStream(
  text: string,
  onChunk: AudioChunkCallback,
  opts: SpeakOpts = {},
): Promise<SpeakStreamMeta | null> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return null;
  if (!text.trim()) return null;

  const { body, meta } = buildBody(text, opts, true);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let ttfbMs = 0;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logError(res.status, res.statusText, await res.text().catch(() => ''), opts.tenantId);
      return null;
    }
    if (!res.body) {
      process.stderr.write('[voxtral-tts] stream response missing body\n');
      return null;
    }

    for await (const evt of parseSseStream(res.body)) {
      if (evt.event !== 'speech.audio.delta') continue;
      const audio = parseAudioDelta(evt.data);
      if (!audio) continue;
      if (ttfbMs === 0) ttfbMs = Date.now() - started;
      onChunk(audio);
    }
    const latencyMs = Date.now() - started;
    logRequest(meta, latencyMs, 'stream', opts.tenantId);
    return {
      characters: meta.characters,
      provider: 'mistral-voxtral-tts',
      model: meta.model,
      voice: meta.voice,
      latencyMs,
      ttfbMs,
    };
  } catch (err: unknown) {
    process.stderr.write(`[voxtral-tts] stream failed: ${getErrorMessage(err)}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64(s: string): Uint8Array {
  const buf = Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function parseAudioDelta(data: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(data) as { audio_data?: unknown };
    if (typeof parsed.audio_data !== 'string') return null;
    return decodeBase64(parsed.audio_data);
  } catch {
    return null;
  }
}

interface SseEvent { readonly event: string; readonly data: string }

/** Minimal SSE parser over a byte stream. Yields one event per blank-line-delimited frame. */
async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = findFrameEnd(buf)) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^(?:\r?\n){1,2}/, '');
        const evt = parseFrame(frame);
        if (evt) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    if (!raw || raw.startsWith(':')) continue;
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    const value = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export const mistralVoxtralTtsProvider: SpeakProvider = {
  name: 'mistral-voxtral-tts',
  get isAvailable() { return hasMistralVoxtralTts(); },
  speak(text: string, opts: SpeakOpts): Promise<SpeakResult | null> {
    return speakMistralVoxtral(text, opts);
  },
  speakStream(text: string, onChunk: AudioChunkCallback, opts: SpeakOpts): Promise<SpeakStreamMeta | null> {
    return speakMistralVoxtralStream(text, onChunk, opts);
  },
  listVoices(): Promise<VoiceInfo[]> {
    return listMistralVoices();
  },
};
