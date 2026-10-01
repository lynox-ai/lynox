import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The voice catalogue fetch shipped paginating with a parameter the endpoint
 * ignores: it asked for `page`, got the same first ten entries every time,
 * deduplicated them, and returned ten of thirty voices as the catalogue —
 * including none of the six French ones, the only non-English voices Mistral has.
 *
 * ⚠ The stub mirrors the MEASURED endpoint (2026-08-02, live API), not an ideal
 * one, and that is the point of it: `offset`/`limit` paginate, `page`/`page_size`
 * do not. A stub that honoured `page` would have shared the caller's wrong
 * assumption and passed — which is exactly what the previous test in
 * `index.test.ts` did by handing back the next page per CALL rather than per URL.
 *
 * ⚠⚠ `SERVER_PAGE` is 7 on purpose. It was 10, which is the most plausible wrong
 * constant to hardcode, so every case was blind to `offset += 10` — a review had
 * to find that by mutation. A page size matching no constant in the file means an
 * offset advancing by anything other than what arrived produces a different
 * request sequence, and the sequence is asserted.
 */

const SERVER_PAGE = 7;

const EN_US = 8;
const EN_GB = 16;
const FR = 6;
const TOTAL = EN_US + EN_GB + FR; // 30

function mk(slug: string, lang: string, name?: string): Record<string, unknown> {
  // ⚠ `name` is overridable, and two entries below deliberately share one. With
  // `name` always derived from `slug`, the id and the description were perfectly
  // collinear, so no assertion could tell "deduped by id" from "deduped by name" —
  // a review killed a `description`-keyed dedup only by changing the FIXTURE. The
  // fixture was the weak link, not the assertions.
  return { slug, name: name ?? slug.replace(/_/g, ' '), languages: [lang], id: `uuid-${slug}` };
}

/** 30 voices in the provider's shape: 8 en_us, 16 en_gb, 6 fr_fr. */
function catalogue(): Array<Record<string, unknown>> {
  return [
    ...Array.from({ length: EN_US }, (_, i) => mk(`en_us_voice${i}`, 'en_us')),
    ...Array.from({ length: EN_GB }, (_, i) => mk(`en_gb_voice${i}`, 'en_gb')),
    // Named rather than generated: their absence is the user-visible symptom.
    // Two share a display name and differ by slug: dedup must key on the id.
    mk('fr_marie_neutral', 'fr_fr', 'Marie'), mk('fr_marie_calm', 'fr_fr', 'Marie'),
    mk('fr_marie_bright', 'fr_fr'), mk('fr_marie_soft', 'fr_fr'),
    mk('fr_marie_warm', 'fr_fr'), mk('fr_marie_clear', 'fr_fr'),
  ];
}

const requested: string[] = [];

/** The offsets actually asked for, as values — not as substrings of a URL. */
function offsets(): string[] {
  return requested.map((u) => new URL(u).searchParams.get('offset') ?? '');
}

interface StubOpts {
  honourOffset?: boolean;
  reportTotal?: boolean;
  totalOverride?: number;
  unusableAt?: number[];
  page?: number;
  failAtOffset?: number;
}

function stubMistral(opts: StubOpts = {}) {
  const honourOffset = opts.honourOffset ?? true;
  const reportTotal = opts.reportTotal ?? true;
  const page = opts.page ?? SERVER_PAGE;
  const all = catalogue().map((e, i) =>
    opts.unusableAt?.includes(i) === true ? { name: 'no slug, no voice, no id' } : e,
  );
  return vi.fn(async (input: string) => {
    requested.push(String(input));
    const u = new URL(String(input));
    const offset = honourOffset ? Number(u.searchParams.get('offset') ?? '0') : 0;
    if (opts.failAtOffset !== undefined && offset === opts.failAtOffset) {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({
        items: all.slice(offset, offset + page),
        ...(reportTotal ? { total: opts.totalOverride ?? all.length } : {}),
        page: 1, page_size: page, total_pages: Math.ceil(all.length / page),
      }),
    } as unknown as Response;
  });
}

/** A fresh module, because the catalogue is cached in module scope. */
async function freshListVoices(): Promise<() => Promise<Array<{ id: string; language?: string }>>> {
  vi.resetModules();
  const mod = await import('./mistral-voxtral-tts.js');
  return mod.listMistralVoices;
}

let warn: ReturnType<typeof vi.spyOn>;
const warned = (fragment: string): boolean =>
  warn.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes(fragment));

/**
 * Every OTHER way a diagnostic could leave this function. `console.warn` is the
 * sanctioned one (inside `report`); these four are the channels a fourth branch
 * would plausibly reach for, and a happy walk must be silent on all of them.
 *
 * ⚠⚠ These nine lines REPLACE a 146-line source scanner, and the replacement is not
 * a simplification for its own sake — it is what five rounds of review measured.
 * The scanner read this file as text and asked "does anything write outside
 * `report`". Versions 1-5 each failed: three hand-written assignments called
 * "structural"; a substring grep; a text scan with two false reds; an enumeration
 * of five console methods with a control that stayed green when the enumeration was
 * EMPTIED; and finally a version that still missed `process.emitWarning` — Node's
 * canonical user-facing warning API, which `no-console` does not cover either — and
 * `const { warn } = console; warn(…)`, both measured green with the whole suite
 * passing.
 *
 * A spy does not care about access shape, aliasing, destructuring, or brace
 * counting, because it observes the CALL rather than the text that spells it.
 *
 * ⚠ What it does NOT hold, all measured rather than reasoned, because the retired
 * scanner's whole failure was a list of channels its author believed complete:
 *   · a write DEFERRED to a macrotask. `setTimeout`, `setImmediate` and
 *     `process.nextTick` callbacks run after `afterEach` has restored the spies, and
 *     the bytes reach the real stderr — 12, 12 and 28 writes measured, suite green.
 *     `queueMicrotask` and `Promise.then` ARE caught, so the boundary is the
 *     macrotask queue, not "async". This is not hypothetical: this function already
 *     hangs work on `setTimeout(() => controller.abort(), 2_000)`, and a "fetch timed
 *     out" diagnostic on that timer lands exactly here.
 *   · `logErrorChain` (`src/core/utils.ts`), the repo's own stderr helper, because it
 *     returns early unless `LYNOX_DEBUG` is set and the test env does not set it.
 *     With `LYNOX_DEBUG=1` the same plant is caught. The most idiomatic shape a
 *     fourth diagnostic here would take, and open on lint too.
 *   · `console.log` / `.info` / `.debug`, which vitest routes through its own Console
 *     rather than `process.stdout` — but `no-console` blocks all three, so they are
 *     held by the other mechanism.
 *   · `fs.writeSync(2, …)`, `process._rawDebug(…)` and a prototype-level
 *     `Object.getPrototypeOf(process.stderr).write.call(…)`: open on both.
 *   · a branch no test walks, which is the ordinary path-dependence.
 * The static half belongs in a lint rule (`no-restricted-properties` on
 * `process.std*.write` for this file); filed as a register row rather than built here.
 */
let otherChannels: Record<string, ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  requested.length = 0;
  // `vi.stubEnv` restores whatever was there; assigning and deleting destroys a real
  // value in a developer's shell. A dummy is safe either way — the fetch is stubbed,
  // so nothing leaves the process — but without a key the function returns its
  // fallback, which would make every assertion below pass for a wrong reason.
  vi.stubEnv('MISTRAL_API_KEY', 'test-key-not-a-secret');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  otherChannels = {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    stderr: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    stdout: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    emitWarning: vi.spyOn(process, 'emitWarning').mockImplementation(() => {}),
  };
});

afterEach(() => {
  // In `afterEach` rather than in one test: `console.warn` inside `report` is the only
  // channel this module is meant to use, so "none of the others fired" is an invariant
  // of every case here, not a property of the happy walk. As a line in one test it had
  // one witness, and changing that test's stub moved the witness with it.
  //
  // ⚠⚠ The assertions run inside `try`/`finally` and the FINALLY is what matters. The
  // first version asserted before the restores with no `finally`, so a failure skipped
  // them — and `vi.spyOn` on an already-spied method hands back the SAME mock with its
  // call history, which `mockRestore` is what clears. Measured: a plant that writes
  // EXACTLY ONCE failed 16 cases, seven of them in their own bodies (a leaked `warn`
  // replaying a previous test's warning at the `warned(...)` assertions), and the
  // `fetch` stub was never unstubbed either. The commit that introduced this called
  // those 16 failures "by design, proof that every case is a witness". They were proof
  // of the leak: the count is 16 for anything, so it carries no information, and the
  // seven secondary messages point a debugger at tests that did nothing wrong. A
  // suspicious number deserves the question, not an explanation.
  try {
    for (const [name, spy] of Object.entries(otherChannels)) {
      expect(spy, `an unexpected write reached ${name} during this test; the catalogue walk sends every diagnostic through \`report\` (console.warn). If this test exercises speakMistralVoxtral* instead, those log to stderr legitimately and this check belongs in the catalogue describes, not here`)
        .not.toHaveBeenCalled();
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    warn.mockRestore();
    for (const spy of Object.values(otherChannels)) spy.mockRestore();
  }
});

describe('the catalogue is paginated by offset, because `page` is ignored', () => {
  it('collects all thirty voices, including the six the old fetch could not reach', async () => {
    vi.stubGlobal('fetch', stubMistral());
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(TOTAL);
    expect(voices.map((v) => v.id)).toContain('fr_marie_neutral');
    expect(voices.filter((v) => v.language === 'fr')).toHaveLength(FR);
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks with offsets that advance by what ARRIVED', async () => {
    vi.stubGlobal('fetch', stubMistral());
    await (await freshListVoices())();

    // The sequence, as values. This is the only assertion separating "advance by
    // what arrived" from "advance by a hardcoded page size" or "by the limit we
    // asked for" — and with a server page of 7, no constant in the file produces it
    // by accident.
    // Six requests for thirty voices at seven per page, and the sixth is the price
    // of not trusting `total`: the walk ends on an EMPTY response rather than on a
    // number the provider reported. An under-reported `total` used to end it early
    // and silently, which is the more expensive side of that trade.
    expect(offsets()).toEqual(['0', '7', '14', '21', '28', '30']);
    for (const u of requested) {
      // `limit` belongs in the contract too. Dropping `&limit=` entirely survived a
      // mutation sweep, and the irony is exact: `limit` is ANOTHER parameter this
      // endpoint currently ignores (it caps at 10), so if it ever starts honouring
      // it the page size jumps tenfold and nothing would have noticed.
      expect(new URL(u).searchParams.get('limit')).toBe('100');
      expect(u).not.toContain('page=');
      expect(u).not.toContain('page_size=');
    }
  });
});

describe('a short catalogue is never silently short', () => {
  it('warns when the offset is ignored, even with no `total` to compare against', async () => {
    // The old failure mode with the provider saying nothing about size. The break
    // that ends the loop already KNOWS the parameter was ignored — a page came back
    // entirely already-seen — so it must say so without needing `total`. The
    // previous version inferred this from a shortfall and was silent here.
    vi.stubGlobal('fetch', stubMistral({ honourOffset: false, reportTotal: false }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(SERVER_PAGE);
    expect(warned('the `offset` parameter is not being honoured')).toBe(true);
    expect(warned('Look at the request.')).toBe(true);
    expect(warned('look at the payload')).toBe(false);
    // The exact count, not a bound: a bound hides a drift in the number of rounds.
    expect(requested.length).toBe(2);
  });

  it('warns on the shortfall the USER suffers, not on the entries that arrived', async () => {
    // ⚠ The measured false negative of the previous version: with a server page of
    // 15 and `total: 30`, two rounds deliver 15 distinct voices and 30 arrivals, so
    // `receivedRaw < total` was false and nothing warned. The quantity that matters
    // is what reached the picker.
    vi.stubGlobal('fetch', stubMistral({ honourOffset: false, page: 15 }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(15);
    expect(warned('15 of 30 voices reached the picker')).toBe(true);
    expect(warned('the `offset` parameter is not being honoured')).toBe(true);
  });

  it('does not let an under-reported `total` end the walk early', async () => {
    // Measured false negative: `total: 10` with thirty voices present made the old
    // `offset >= total` break stop after one request and return ten, silently. That
    // break was pure optimisation — the ceiling and the duplicate check already
    // terminate — so it could only lose data.
    vi.stubGlobal('fetch', stubMistral({ totalOverride: 10 }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(TOTAL);
    expect(voices.map((v) => v.id)).toContain('fr_marie_clear');
  });
});

describe('a payload problem is not reported as a pagination problem', () => {
  it('steps over an unusable entry instead of re-requesting it', async () => {
    vi.stubGlobal('fetch', stubMistral({ unusableAt: [3] }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(TOTAL - 1);
    expect(offsets()).toEqual(['0', '7', '14', '21', '28', '30']);
    // ⚠ The REMEDY and the NUMBERS, not only the identifying phrase. A sweep
    // swapped the two tails — "look at the request" ↔ "look at the payload" — and
    // the suite stayed green with both messages actively misleading, which is the
    // one property the whole counter split exists for. And the counts were free to
    // invert ("31 of 1 entries") because only the phrase was matched.
    expect(warned('1 of 30 arrived entries had no usable voice slug')).toBe(true);
    expect(warned('look at the payload, not the request')).toBe(true);
    expect(warned('not being honoured')).toBe(false);
  });

  it('does NOT truncate when a whole page is unusable, and blames the payload', async () => {
    // ⚠ The measured false POSITIVE of the previous version, and the sharper half:
    // its break fired when no NEW voices arrived, which is true both when the offset
    // is ignored and when a page happens to be entirely unusable. The offset DID
    // advance here, so stopping truncated the catalogue — and then reported the
    // truncation it had caused as a pagination fault, inside the same block whose
    // comment claimed the two causes were separated.
    const wholePage = Array.from({ length: SERVER_PAGE }, (_, i) => SERVER_PAGE + i);
    vi.stubGlobal('fetch', stubMistral({ unusableAt: wholePage }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(TOTAL - SERVER_PAGE);
    expect(voices.map((v) => v.id)).toContain('fr_marie_clear');
    expect(warned('had no usable voice slug')).toBe(true);
    expect(warned('not being honoured')).toBe(false);
  });
});

describe('the provider object really is wired to the catalogue', () => {
  it('reaches the real fetch through `mistralVoxtralTtsProvider.listVoices`', async () => {
    // ⚠ Every other test spies `listVoices` away, so the one line that connects the
    // provider contract to the catalogue — `listVoices() { return listMistralVoices(); }` —
    // had NO witness: a reviewer replaced its body with `Promise.resolve([])` and all 123
    // tests stayed green. Production voice selection was therefore untested at the seam
    // that matters. This calls the real object method.
    vi.stubGlobal('fetch', stubMistral());
    vi.resetModules();
    const mod = await import('./mistral-voxtral-tts.js');

    const voices = await mod.mistralVoxtralTtsProvider.listVoices?.();

    expect(voices).toHaveLength(TOTAL);
    expect(voices?.map((v) => v.id)).toContain('fr_marie_neutral');
    expect(requested.length).toBeGreaterThan(0);
  });
});

describe('concurrent callers share one walk, instead of each starting their own', () => {
  it('makes ONE set of provider requests for two simultaneous cold-cache calls', async () => {
    // ⚠ Measured by a security pass rather than reasoned: the cache is only written when
    // a walk FINISHES, so before this every request arriving DURING a walk saw a miss and
    // started another. The path existed (the settings picker reads the catalogue), but
    // routing voice selection through it made it hot — once per `POST /api/speak` instead
    // of once per page load — so the change widened a pre-existing amplifier.
    //
    // The fixture holds the first response open until both callers are inside.
    //
    // ⚠ And the claim that used to stand here — "a stub that answers immediately … would
    // pass either way" — is FALSE, measured by a reviewer: with an immediate stub and the
    // single-flight REMOVED the test still fails, because the awaits inside the walk keep
    // the cache cold until both calls have started. The gate makes the concurrency
    // deliberate rather than incidental, which is worth having; it is not what makes the
    // assertion able to fail. A sequential pair is the only shape that passes either way.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let released = false;
    const all = catalogue();
    const fetchSpy = vi.fn(async (input: string) => {
      requested.push(String(input));
      if (!released) { released = true; await gate; }
      const off = Number(new URL(String(input)).searchParams.get('offset') ?? '0');
      return {
        ok: true,
        json: async () => ({ items: all.slice(off, off + SERVER_PAGE), total: all.length }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);

    const listVoices = await freshListVoices();
    const first = listVoices();
    const second = listVoices();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toHaveLength(TOTAL);
    expect(b).toHaveLength(TOTAL);
    // Six requests is ONE walk at this page size (5 data pages + the empty tail). Twelve
    // would mean both callers walked.
    expect(offsets()).toEqual(['0', '7', '14', '21', '28', '30']);
  });

  it('starts a NEW walk once the shared one has settled and the cache expired', async () => {
    // The `finally` that clears the in-flight promise: without it a settled promise would
    // be handed to every later caller for the rest of the process.
    //
    // ⚠ Renamed. It used to say "so a failure is not remembered", and it never exercised a
    // failure — `walkMistralVoices` catches its own errors and does not reject, so no
    // rejection path exists to remember. What this actually covers is TTL expiry, and the
    // name now says that. A test name is a claim like any other.
    vi.stubGlobal('fetch', stubMistral());
    const listVoices = await freshListVoices();
    await listVoices();
    const afterFirst = requested.length;
    expect(afterFirst).toBeGreaterThan(0);
    // Past the long TTL: the cache is cold again, and a second walk must actually run.
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    await listVoices();
    expect(requested.length).toBeGreaterThan(afterFirst);
  });
});

describe('the cache keeps a clean result longer than a doubtful one', () => {
  // The cache layer had no test at all, and this change ADDED logic to it: a
  // complete walk is held for an hour, a doubtful one for a minute. Before, an
  // incomplete catalogue was authoritative for sixty minutes off one stderr line
  // while an outright error was retried after one — an incomplete success treated
  // as more trustworthy than a failure.
  it('holds a complete catalogue for the long TTL, not the short one', async () => {
    // ⚠ Time belongs in this assertion. Without it, "the second call did not
    // re-fetch" is satisfied by ANY non-zero TTL, so shortening a clean result's
    // lifetime to a minute survived — the mutant that turns this cache into the
    // doubtful-result one.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', stubMistral());
      const listMistralVoices = await freshListVoices();
      await listMistralVoices();
      const afterFirst = requested.length;
      vi.setSystemTime(Date.now() + 5 * 60_000); // well past the doubtful TTL
      await listMistralVoices();
      expect(requested.length).toBe(afterFirst);
      vi.setSystemTime(Date.now() + 61 * 60_000); // and past the long one
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-probes a doubtful catalogue after a minute, and not after an hour', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', stubMistral({ honourOffset: false }));
      const listMistralVoices = await freshListVoices();
      await listMistralVoices();
      const afterFirst = requested.length;
      // Inside the short TTL: still cached.
      vi.setSystemTime(Date.now() + 30_000);
      await listMistralVoices();
      expect(requested.length).toBe(afterFirst);
      // Past it: asked again, so the condition is re-observed and re-warned.
      vi.setSystemTime(Date.now() + 61_000);
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-probes after a PAYLOAD shortfall too, not only after an ignored offset', async () => {
    // ⚠ Both earlier cache cases used `honourOffset: false` — the one condition that
    // set the doubtful flag — so the TTL had a witness for exactly one of the three
    // diagnostics, and a warned-but-payload-short catalogue was held for an hour.
    // The flag now means "this walk reported something", which is the property the
    // comment claims, and this case is the second cause proving it.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', stubMistral({ unusableAt: [3] }));
      const listMistralVoices = await freshListVoices();
      const voices = await listMistralVoices();
      expect(voices.length).toBe(TOTAL - 1);
      expect(warned('had no usable voice slug')).toBe(true);
      expect(warned('not being honoured')).toBe(false); // offset was honoured
      const afterFirst = requested.length;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  // ⚠ One case per diagnostic where ONLY that one fires. The payload case above
  // trips the shortfall warning as well (29 of 30), so each `doubtful` assignment
  // was individually redundant there and a mutation sweep showed both surviving.
  // A flag that three branches set needs three witnesses, not one that happens to
  // pass through two of them.
  it('does not hold the EN-only fallback for an hour after an empty 200', async () => {
    // ⚠ The other half of the same line, and a review had to point at it: an empty
    // but successful response with no `total` fires NO diagnostic, so `doubtful`
    // stays false and only `voices.length > 0` keeps the five-entry hardcoded
    // fallback out of the long cache. That guard had no witness — exactly the class
    // this commit exists for, on the other half of its own condition.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        requested.push(String(input));
        return { ok: true, json: async () => ({ items: [] }) } as unknown as Response;
      }));
      const listMistralVoices = await freshListVoices();
      const voices = await listMistralVoices();
      // ⚠ Counted, not bounded. `toBeLessThan(TOTAL)` is satisfied by 0 as well, so
      // it could not see the fallback substitution disappearing — the prose said
      // "five-entry hardcoded fallback" and the assertion never counted five.
      expect(voices).toHaveLength(5);
      const afterFirst = requested.length;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-probes when ONLY the pagination warning fired', async () => {
    vi.useFakeTimers();
    try {
      // Offset ignored, no `total` reported, every entry usable: the pagination
      // warning is the only one, so this is the third branch's own witness. Without
      // it the assignment there was redundant — the ignored-offset case also trips
      // the shortfall whenever `total` is present.
      vi.stubGlobal('fetch', stubMistral({ honourOffset: false, reportTotal: false }));
      const listMistralVoices = await freshListVoices();
      const voices = await listMistralVoices();
      expect(voices.length).toBe(SERVER_PAGE);
      expect(warned('not being honoured')).toBe(true);
      expect(warned('reached the picker')).toBe(false);
      expect(warned('had no usable voice slug')).toBe(false);
      const afterFirst = requested.length;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-probes when ONLY the shortfall fired', async () => {
    vi.useFakeTimers();
    try {
      // `total` over-reported, every entry usable, offset honoured: shortfall alone.
      vi.stubGlobal('fetch', stubMistral({ totalOverride: 40 }));
      const listMistralVoices = await freshListVoices();
      const voices = await listMistralVoices();
      expect(voices.length).toBe(TOTAL);
      expect(warned('30 of 40 voices reached the picker')).toBe(true);
      expect(warned('had no usable voice slug')).toBe(false);
      expect(warned('not being honoured')).toBe(false);
      const afterFirst = requested.length;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-probes when ONLY the unusable warning fired', async () => {
    vi.useFakeTimers();
    try {
      // One unusable entry and a `total` the delivered count reaches, so the
      // shortfall stays quiet and the payload warning is the only one.
      vi.stubGlobal('fetch', stubMistral({ unusableAt: [3], totalOverride: TOTAL - 1 }));
      const listMistralVoices = await freshListVoices();
      const voices = await listMistralVoices();
      expect(voices.length).toBe(TOTAL - 1);
      expect(warned('had no usable voice slug')).toBe(true);
      expect(warned('reached the picker')).toBe(false);
      expect(warned('not being honoured')).toBe(false);
      const afterFirst = requested.length;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await listMistralVoices();
      expect(requested.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('two causes at once are reported as two, never as one denying the other', () => {
  it('does not tell the reader to ignore the request it just blamed', async () => {
    // Measured: with the offset ignored AND an unusable entry, all three fired and
    // the third ended "look at the payload, not the request" — one line below a
    // warning that said "Look at the request." The exclusion was only ever asserted
    // where it happened to be true.
    vi.stubGlobal('fetch', stubMistral({ honourOffset: false, unusableAt: [3] }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBeGreaterThan(0);
    expect(warned('the `offset` parameter is not being honoured')).toBe(true);
    expect(warned('had no usable voice slug')).toBe(true);
    // The contradiction, asserted as an absence — and the replacement asserted as a
    // presence, so a silent revert to the flat tail cannot pass.
    expect(warned('look at the payload, not the request')).toBe(false);
    expect(warned('ON TOP of the request problem above')).toBe(true);
  });
});

describe('what was already collected is not thrown away', () => {
  it('keeps the voices it has when a later page fails, instead of the EN-only fallback', async () => {
    // Measured on the previous version: two good pages then a 500 returned the
    // five-entry hardcoded fallback and discarded everything, with no log line — the
    // silent truncation this change exists to prevent, worse on the failure path
    // than on the success one.
    vi.stubGlobal('fetch', stubMistral({ failAtOffset: SERVER_PAGE * 2 }));
    const voices = await (await freshListVoices())();

    expect(voices.length).toBe(SERVER_PAGE * 2);
    expect(voices.length).toBeGreaterThan(5); // not the fallback
    expect(warned('fetch ended early')).toBe(true);
  });
});
