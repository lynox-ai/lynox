import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Keeps retired disclosure wordings out of every in-product string, and pins the
 * replacements that took their place.
 *
 * THE CLAIM. "Running lynox yourself means only the inference call leaves the
 * host." Retired 2026-09-04: it is false of the engine as shipped, because
 * `engine.ts` registers the DuckDuckGo HTML fallback unconditionally when SearXNG
 * does not land, and `http_request` is registered unconditionally too.
 *
 * WHAT CHANGED HERE, AND WHAT DELIBERATELY DID NOT.
 *
 * The previous version looked at two NAMED KEYS and forbade four literal strings
 * *in those keys*. `config.provider_desc` was a third key carrying a fifth wording
 * of the same claim, so it was structurally unreachable — the PR that repaired
 * three wordings in this very file walked past the fourth, and so did the test it
 * shipped. **The most dangerous place is the one the fix lives in.** So the scan
 * below runs over the WHOLE file and the whole model catalog. That part is a
 * strict improvement and it costs nothing: a literal that was retired cannot be
 * honest copy, so there is no false-alarm surface to trade against.
 *
 * ⚠ WHAT THIS IS NOT, because two adversarial rounds settled it. A detector for
 * the CLAIM — one that catches wordings nobody has written down yet — was built
 * here and REMOVED. It matched claim shapes through six vocabulary-driven arms,
 * and it did not survive being attacked:
 *
 *   - round 1: an adversary produced **31 wordings** that assert the claim and
 *     slip through (`device`, `laptop`, `box`, `Rechner`, `Gerät`, `Umgebung`,
 *     subjects other than "data", "goes out" instead of "leaves"), and **8 false
 *     alarms** — including the honest correction the retirement prescribes.
 *   - round 2, on the widened version: **30 more misses**, **4 more false
 *     alarms**, and — worse — the three exclusions added to stop the false alarms
 *     **silenced 14 sentences that do assert the claim** ("Nothing leaves your
 *     machine — our servers never see it" reads as managed-residency prose to a
 *     lexical rule). The discrimination rested on the word "our", so true managed
 *     copy that says "the servers in Zurich" went red while the false claim that
 *     says "our" went quiet. Exactly backwards.
 *
 * The finding curve was rising, not falling, which is the signal that the cut is
 * wrong rather than the implementation. A lexical rule cannot decide whether a
 * sentence is TRUE, and that — not vocabulary — is the question. The measurements
 * (42 + 30 asserting wordings, 28 + 4 true sentences) are kept in the register
 * under `DEF-retired-claim-detector-cannot-be-lexical` so the next attempt starts
 * from data instead of from zero, and so nobody rebuilds this one by accident.
 *
 * The sources are read as text, like `preset-cards-i18n.test.ts` does, so this
 * does not depend on a Svelte-aware import of the runes module.
 */

/**
 * Distinctive fragments of wordings that were REMOVED as this claim, taken from
 * the pull requests that removed them. Literal, case-insensitive, and checked
 * across the whole of both sources — not per key.
 *
 * Every entry is a phrase that was published and then retracted. That is the
 * whole membership rule, and it is why this list has no false-alarm direction to
 * measure: none of these can be a true statement about the engine as shipped.
 *
 * ⚠ ONE CONSEQUENCE, STATED SO IT IS NOT LATER FOUND AS A BUG. This forbids
 * REUSING a retracted phrase, not asserting a claim. So a sentence that repairs
 * one by appending exceptions — "Nothing leaves your machine except the inference
 * call, the web search and the HTTP tool", "Mit whisper.cpp läuft alles lokal,
 * ausser der Websuche" — still fails here, because it still ships the retracted
 * phrase, and the second one contradicts itself besides. That is deliberate: the
 * fix is to write the sentence from what egress DEPENDS ON ("What leaves your
 * machine: the inference call, a web search when the agent searches, …"), which
 * is the shape the retirement prescribes anyway. Narrowing this list to let an
 * "except" clause through would be the first step back toward judging meaning,
 * and that road is closed for the reason in the header.
 */
const RETIRED_FRAGMENTS: readonly string[] = [
	'nothing leaves your machine',
	'nothing leaves your network',
	'nothing leaves the host',
	'zero data leaves your network',
	'no data leaves the host',
	'null daten verlassen dein netzwerk',
	'verlässt nichts dein netz',
	'runs everything locally',
	'läuft alles lokal',
	'only your chosen llm provider receives prompts',
	'only communicates with the llm provider',
	'kommuniziert ausschliesslich mit dem von dir konfigurierten llm-anbieter',
	'the only thing that leaves that host',
	'das einzige, was diesen host verlässt',
	'daten bleiben immer lokal',
	'your data stays local',
	'only inference uses the provider',
	'nur die inferenz nutzt den provider',
];

/**
 * A retired phrase must match as a PHRASE, not as the prefix of a longer word.
 *
 * The first version compared with `includes()`, and `nothing leaves the host` is
 * a prefix of `nothing leaves the hosting …`. Measured against what shipped:
 * "Nothing leaves the hosting cluster unencrypted", "Nothing leaves the hosting
 * provider without an SCC" and "Nothing leaves the hostname resolver" all fired.
 * All three are TRUE, none of them reuses the retracted phrase, and a required
 * check that reds correct copy is the one that gets deleted rather than fixed.
 *
 * ⚠ This is a different thing from the deliberate behaviour below it: a sentence
 * that repairs a retracted phrase by appending exceptions ("nothing leaves your
 * machine EXCEPT …") still ships the retracted phrase and still fails, on
 * purpose. `hosting` is not that — it is a different word that happens to start
 * with one.
 *
 * Only a TRAILING boundary is added. A leading one would be inert: every
 * fragment starts at a word start already, and the failure measured here is
 * entirely about what follows.
 */
/**
 * One fragment as a phrase pattern.
 *
 * Extracted rather than inlined so the ESCAPING can be tested. No fragment in the
 * list above contains a regex metacharacter today, so removing the escape survives
 * every case built from that list — an equivalent mutant, and an untested line.
 * Called directly with a metacharacter, it is neither.
 */
export function phraseRe(fragment: string): RegExp {
	// The fragment is data, not a pattern — escape it before it becomes one, or an
	// entry containing `.` or `(` would quietly match more than itself.
	return new RegExp(`${fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'i');
}

const FRAGMENT_RE: ReadonlyArray<readonly [string, RegExp]> = RETIRED_FRAGMENTS.map((f) => [
	f,
	phraseRe(f),
]);

/** The retired fragments a text carries, as phrases. */
function fragmentsIn(text: string): string[] {
	return FRAGMENT_RE.filter(([, rx]) => rx.test(text)).map(([f]) => f);
}

describe('i18n — retired disclosure wordings stay retired', () => {
	const i18n = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');
	// The model catalog renders its own residency notes (LLMSettings.svelte) and is not on the
	// private repo's watch list, so it is scanned here too.
	const catalog = readFileSync(
		fileURLToPath(new URL('../../../../src/core/llm/catalog.ts', import.meta.url)),
		'utf8',
	);
	const SOURCES: ReadonlyArray<readonly [string, string]> = [
		['i18n.svelte.ts', i18n],
		['llm/catalog.ts', catalog],
	];

	it('reads sources that actually contain the table — the scan is not passing on an empty read', () => {
		expect(i18n.length).toBeGreaterThan(50_000);
		expect(i18n).toContain("'config.provider_desc'");
		expect(catalog.length).toBeGreaterThan(10_000);
	});

	/*
	 * Both directions of the boundary, because a matcher change can only be judged
	 * by what it still catches AND what it stops catching.
	 */
	describe('matches a retired phrase as a phrase', () => {
		// Every fragment must still match ITSELF. Trivial to satisfy and not
		// trivial to keep: it is the control on the escaping, which turns each
		// fragment into a pattern. A future entry containing `.` or `(` that came
		// out mangled would show up here and nowhere else.
		for (const f of RETIRED_FRAGMENTS) {
			it(`still catches: ${f}`, () => {
				expect(fragmentsIn(`prose before ${f} and prose after`)).toContain(f);
			});
		}

		// The false-alarm direction, measured on what shipped before this fix: all
		// three fired, all three are TRUE, and none of them reuses the retracted
		// phrase. `host` was matching inside `hosting` and `hostname`.
		for (const honest of [
			'Nothing leaves the hosting cluster unencrypted.',
			'Nothing leaves the hosting provider without an SCC.',
			'Nothing leaves the hostname resolver.',
		]) {
			it(`leaves alone: ${honest}`, () => {
				expect(fragmentsIn(honest)).toEqual([]);
			});
		}

		// And the behaviour that is NOT a false alarm and must survive the fix: a
		// retracted phrase with exceptions bolted on still ships the retracted
		// phrase. Narrowing the list to let this through is the step this file's
		// header closes the door on.
		// The escaping, exercised where it can actually fail. Unescaped, `.` is
		// "any character" and the phrase would match a sentence that does not
		// contain it — a fragment matching more than itself is the direction that
		// turns this list into false alarms on copy nobody wrote.
		it('treats a fragment as text, not as a pattern', () => {
			expect(phraseRe('acme v1.0 leaves').test('acme v1.0 leaves')).toBe(true);
			expect(phraseRe('acme v1.0 leaves').test('acme v1x0 leaves')).toBe(false);
		});

		it('still catches a retracted phrase repaired with an "except" clause', () => {
			expect(
				fragmentsIn('Nothing leaves your machine except the inference call and the web search.'),
			).toContain('nothing leaves your machine');
		});
	});

	it('would find a retired fragment if a source carried one — positive control on the scan', () => {
		const planted = `${i18n}\n\t'planted.key': { de: 'Daten bleiben immer lokal.', en: 'x' },`;
		expect(scan(planted)).not.toHaveLength(0);
	});

	for (const [name, text] of SOURCES) {
		it(`carries no retired wording anywhere in ${name}`, () => {
			expect(scan(text)).toEqual([]);
		});

		// A sentence wrapped across lines is invisible to a per-line scan.
		it(`carries none across a line break in ${name} either`, () => {
			const joined = text.replace(/\s+/gu, ' ');
			expect(fragmentsIn(joined)).toEqual([]);
		});
	}

	/*
	 * The scan can only assert ABSENCE, and absence cannot tell a correction from a
	 * deletion: copy reworded into something vague carries no retired fragment at all.
	 * These pin the PRESENCE of the replacements. #1305 merged after #1306 and carried
	 * the old voice string back in — a branch cut before the fix, touching the same file.
	 */
	const lineWith = (key: string): string | undefined =>
		i18n.split('\n').find((l) => l.includes(`'${key}'`));

	it('keeps the voice STT keys and their scoped replacements', () => {
		const phase0 = lineWith('config.voice_stt_privacy');
		const rendered = lineWith('voice.stt_privacy');
		expect(phase0, 'config.voice_stt_privacy').toBeDefined();
		expect(rendered, 'voice.stt_privacy').toBeDefined();
		expect(phase0).toContain('With whisper.cpp the audio stays on your machine.');
		expect(phase0).toContain('verlässt kein Audio dein System');
		expect(rendered).toContain('the audio stays on your machine');
		expect(rendered).toContain('bleibt das Audio auf deinem System');
	});

	it('keeps the provider description scoped to what it depends on', () => {
		const line = lineWith('config.provider_desc');
		expect(line, 'config.provider_desc').toBeDefined();
		expect(line).toContain('hängt von deiner Konfiguration ab');
		expect(line).toContain('depends on your configuration');
	});
});

/** Every line carrying a retired fragment, as `line:fragment` so a failure names the key. */
function scan(source: string): string[] {
	const out: string[] = [];
	source.split('\n').forEach((line, i) => {
		for (const f of fragmentsIn(line)) out.push(`${i + 1}:${f}`);
	});
	return out;
}
