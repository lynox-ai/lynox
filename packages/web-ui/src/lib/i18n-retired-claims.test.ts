import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Keeps a retired disclosure claim out of every in-product string, not out of the
 * two keys someone happened to fix.
 *
 * THE CLAIM. "Running lynox yourself means only the inference call leaves the
 * host." It was retired on 2026-09-04 because it is false of the engine as
 * shipped: `engine.ts` registers the DuckDuckGo HTML fallback unconditionally
 * when SearXNG does not land, and `http_request` is registered unconditionally
 * too. There is no default self-host path on which only inference leaves.
 *
 * WHY THIS FILE WAS REWRITTEN (2026-09-05). Its first version looked for two
 * NAMED KEYS and forbade four LITERAL STRINGS in them. `config.provider_desc`
 * was a third key carrying a fifth wording of the same claim — "Daten bleiben
 * immer lokal — nur die Inferenz nutzt den Provider." / "Your data stays local —
 * only inference uses the provider." — and was structurally unreachable. The PR
 * that repaired three wordings in this very file walked past the fourth, and so
 * did the test it shipped.
 *
 * That is the lesson worth keeping: **the most dangerous place is the one the fix
 * lives in.** A set drawn by FORM (known strings) or by LOCATION (known keys)
 * cannot contain a member nobody had seen; a set drawn by the CLAIM can. So the
 * question this file asks is no longer "does this sentence appear?" but "does any
 * string assert that only inference leaves the host?", and it asks it of every
 * line in the table.
 *
 * MEASURED IN BOTH DIRECTIONS, because widening a claim detector is how it starts
 * firing on true sentences — the sibling pattern in the private repo had to be
 * narrowed once after it hit honest prose about data centres. Every wording ever
 * retired as this claim must match, and a list of sentences that are TRUE must
 * not. Both lists are asserted below; neither is decoration.
 *
 * The sources are read as text, like `preset-cards-i18n.test.ts` does, so this
 * does not depend on a Svelte-aware import of the runes module.
 */

/**
 * The claim, decomposed into the ways it gets asserted. A hit on any arm is a hit
 * on the claim. Arms are named so a failure says WHICH assertion fired rather
 * than only that something did.
 *
 * Two rules hold these together and both were learned from a false alarm:
 *  - every noun list carries `\b`, so `Netz` does not match inside
 *    `Hostingzentrum` and `Daten` does not match inside `Audiodaten`;
 *  - every arm names the SUBJECT it is about. An arm without one matched
 *    "Keine Daten verlassen das Rechenzentrum in Zürich", which is an accurate
 *    statement about the managed offering.
 */
const CLAIM_ARMS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		'only-X-leaves',
		/only thing that (ever )?leaves|sole thing that leaves|Einzige, was[^.]{0,40}(Netzwerke?|Netze[sn]?|Netz|Hosts?|Maschinen?|Systeme?n?|Servern?)\b[^.]{0,20}verlässt/i,
	],
	[
		'nothing-leaves',
		/(nothing|no data|zero data)[^.]{0,25}leaves?[^.]{0,10}(your|the|this)\s+(networks?|hosts?|machines?|systems?|servers?)\b|(Null|Keine) Daten verlassen[^.]{0,15}(dein|deine|das|den)?\s*(Netzwerke?|Netze[sn]?|Netz|Hosts?|Maschinen?|Systeme?n?|Servern?)\b|(verlässt nichts|nichts verlässt)[^.]{0,25}(Netzwerke?|Netze[sn]?|Netz|Hosts?|Maschinen?|Systeme?n?|Servern?)\b/i,
	],
	['runs-everything-locally', /runs everything locally|l(ä|ae)uft alles lokal/i],
	[
		'only-provider-receives',
		/only your chosen[^.]{0,40}receives prompts|nur dein gewählter[^.]{0,40}erhält Prompts|only communicates with the LLM provider|kommuniziert[^.]{0,20}ausschliesslich mit[^.]{0,30}LLM-Anbieter/i,
	],
	/*
	 * The two arms `config.provider_desc` fell through. `data stays local` and
	 * `Daten bleiben … lokal` are the claim with the subject left unqualified —
	 * the word boundary is what keeps `Audiodaten bleiben lokal` (true, scoped)
	 * out of it.
	 */
	['data-stays-local', /\b(your |the )?data stays local\b|\bDaten\b[^.]{0,20}\bbleiben\b[^.]{0,15}\blokal\b/i],
	[
		'only-inference',
		/only[^.]{0,10}\binference\b[^.]{0,20}(uses|reaches|goes to|touches|leaves)\b|\bnur\b[^.]{0,10}\bInferenz\b[^.]{0,20}(nutzt|erreicht|verlässt|geht an|braucht)\b/i,
	],
];

/** The arm a text trips, or null. This is the whole detector; everything else drives it. */
export function claimArmFor(text: string): string | null {
	for (const [name, rx] of CLAIM_ARMS) if (rx.test(text)) return name;
	return null;
}

/**
 * Every wording removed as this claim, with where it came from — collected from
 * the pull requests that removed them, not invented. The last two are the pair
 * that prompted this rewrite.
 */
const RETIRED_WORDINGS: ReadonlyArray<readonly [string, string]> = [
	['trust page, DE note', 'LLaMA, Qwen oder Mistral lokal. Null Daten verlassen dein Netzwerk.'],
	['trust page, EN note', 'Run LLaMA, Qwen, or Mistral locally. Zero data leaves your network.'],
	['landing card, EN', 'lynox stays on your infrastructure — only your chosen LLM provider receives prompts.'],
	['trust page, DE prose', 'Das Einzige, was diesen Host verlässt, ist der Inferenz-Call an den LLM-Anbieter.'],
	['trust page, DE Ollama', 'zeigst du auf ein Ollama on-prem, verlässt nichts dein Netz.'],
	['trust page, EN prose', 'The only thing that leaves that host is the inference call to whichever LLM provider you pointed lynox at.'],
	['trust page, EN Ollama', 'point at an on-prem Ollama and nothing leaves your network.'],
	['sub-processors, EN', 'When you run lynox on your own infrastructure, the software only communicates with the LLM provider whose API key you configure.'],
	['sub-processors, DE', 'Wenn du lynox auf deiner eigenen Infrastruktur betreibst, kommuniziert die Software ausschliesslich mit dem von dir konfigurierten LLM-Anbieter.'],
	['voice hint, EN', 'With whisper.cpp nothing leaves your machine.'],
	['voice settings, EN', 'With whisper.cpp it runs everything locally.'],
	['voice settings, DE', 'Mit whisper.cpp läuft alles lokal.'],
	['model catalog residency', 'Your machine — nothing leaves the host'],
	['Art. 30 record, search', 'SearXNG runs as local Docker sidecar (no data leaves the host).'],
	['plural EN, must survive the word boundary', 'Nothing leaves the hosts you run this on.'],
	['plural DE, must survive the word boundary', 'Keine Daten verlassen deine Systeme.'],
	['model catalog notes', 'Local models via Ollama — nothing leaves your machine.'],
	['config.provider_desc, DE (this PR)', 'Wohin werden KI-Anfragen gesendet? Daten bleiben immer lokal — nur die Inferenz nutzt den Provider.'],
	['config.provider_desc, EN (this PR)', 'Where are AI requests sent? Your data stays local — only inference uses the provider.'],
];

/**
 * Constructed, and labelled as such: every wording above trips at least two arms,
 * so deleting either of the two arms added for `config.provider_desc` left the
 * suite green. An arm no case separates is an arm nobody can show is doing
 * anything — it survives every mutation and reads as coverage.
 *
 * Each row below is a plausible phrasing of the same claim that trips exactly ONE
 * arm, which is what makes that arm killable. They are not presented as sentences
 * anyone shipped; the list above holds those, and its provenance stays clean.
 */
const ARM_SEPARATORS: ReadonlyArray<readonly [string, string, string]> = [
	['data-stays-local', 'EN, no "only inference" half', 'Your data stays local.'],
	['data-stays-local', 'DE, no "only inference" half', 'Deine Daten bleiben lokal.'],
	['only-inference', 'EN, no "stays local" half', 'Only inference ever leaves the machine.'],
	['only-inference', 'DE, no "stays local" half', 'Nur die Inferenz verlässt den Rechner.'],
];

/**
 * Sentences that are TRUE and must survive. The live product strings are here on
 * purpose: a false alarm on correct copy turns a required check red for the wrong
 * reason, which is how a guard gets deleted instead of fixed.
 *
 * The last two encode a distinction the registry draws explicitly — the inference
 * call may legitimately be described as lasting only for that request. Saying how
 * LONG it lasts is not saying it is the only thing that goes out.
 */
const HONEST_WORDINGS: ReadonlyArray<readonly [string, string]> = [
	['voice hint DE, live', 'Lokal via whisper.cpp verlässt kein Audio dein System.'],
	['voice hint EN, live', 'With whisper.cpp the audio stays on your machine.'],
	['catalog residency, live', 'Your machine — the model call stays on the host'],
	['catalog notes, live', 'Local models via Ollama — the model call stays on your machine.'],
	['config.provider_desc DE, live (this PR)', 'Wohin werden KI-Anfragen gesendet? Der Provider erhält den Inferenz-Aufruf; was sonst nach aussen geht, hängt von deiner Konfiguration ab und davon, was der Agent tut.'],
	['config.provider_desc EN, live (this PR)', 'Where are AI requests sent? The provider receives the inference call; what else goes out depends on your configuration and on what the agent does.'],
	['container prose', 'Der Container verlässt das Rechenzentrum nie; er wird dort gebaut und dort betrieben.'],
	['backup prose', 'Kein Backup verlässt das Schweizer Rechenzentrum, in dem die Instanz läuft.'],
	['residency DE', 'Keine Daten verlassen das Rechenzentrum in Zürich.'],
	['residency EN', 'No data leaves the EU region for managed instances.'],
	['residency EN, contractual', 'No customer data leaves the data centre without an SCC in place.'],
	['scoped honesty DE', 'Die Modelle laufen lokal; was sonst noch nach aussen geht, hängt von deiner Installation ab.'],
	['scoped honesty EN', 'With whisper.cpp no audio leaves your machine.'],
	['compound noun DE', 'Nichts verlässt das Hostingzentrum in Zürich.'],
	['compound noun EN', 'Nothing leaves your hosting provider without an SCC.'],
	['noun boundary DE', 'Keine Daten verlassen das Hostingzentrum in Zürich.'],
	['noun boundary EN', 'Nothing leaves the hosting cluster unencrypted.'],
	['scoped subject DE, word boundary', 'Deine Audiodaten bleiben lokal.'],
	['duration, not exclusivity DE', 'Der Inferenz-Aufruf dauert nur so lange wie die Anfrage.'],
	['duration, not exclusivity EN', 'The inference call lasts only for that request.'],
];

describe('i18n — the "only inference leaves" claim stays retired', () => {
	const i18n = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');
	// The model catalog renders its own residency notes (LLMSettings.svelte :1262/:1295) and is
	// not on the private repo's watch list, so it is scanned here too.
	const catalog = readFileSync(
		fileURLToPath(new URL('../../../../src/core/llm/catalog.ts', import.meta.url)),
		'utf8',
	);
	const SOURCES: ReadonlyArray<readonly [string, string]> = [
		['i18n.svelte.ts', i18n],
		['llm/catalog.ts', catalog],
	];

	describe('the detector catches every wording that was retired as this claim', () => {
		for (const [where, text] of RETIRED_WORDINGS) {
			it(`catches ${where}`, () => {
				expect(claimArmFor(text), text).not.toBeNull();
			});
		}
	});

	describe('each arm is carried by a case no other arm covers', () => {
		for (const [arm, where, text] of ARM_SEPARATORS) {
			it(`${arm} — ${where}`, () => {
				expect(claimArmFor(text), text).toBe(arm);
			});
		}
	});

	describe('the detector leaves true sentences alone', () => {
		for (const [where, text] of HONEST_WORDINGS) {
			it(`clears ${where}`, () => {
				expect(claimArmFor(text), text).toBeNull();
			});
		}
	});

	it('reads sources that actually contain the table — the scan is not passing on an empty read', () => {
		expect(i18n.length).toBeGreaterThan(50_000);
		expect(i18n).toContain("'config.provider_desc'");
		expect(catalog.length).toBeGreaterThan(10_000);
	});

	it('would catch the claim if a source carried it — positive control on the scan itself', () => {
		const planted = `${i18n}\n\t'planted.key': { de: 'Daten bleiben immer lokal.', en: 'Your data stays local.' },`;
		expect(scan(planted)).not.toHaveLength(0);
	});

	/*
	 * The claim detector above can only assert ABSENCE. These pin the PRESENCE of the
	 * replacements, and they are not redundant: core#1305 merged after core#1306 and carried
	 * the old voice string back in — a branch cut before the fix, touching the same file. An
	 * absence check would have caught that one because the old wording returned; a
	 * replacement that is simply deleted, or reworded into something vague, trips nothing.
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

	for (const [name, text] of SOURCES) {
		it(`no string in ${name} asserts that only inference leaves the host`, () => {
			expect(scan(text)).toEqual([]);
		});

		// A sentence wrapped across lines is invisible to a per-line scan. The private repo's
		// guard learned this the hard way and reads a whitespace-joined buffer as well; the
		// `[^.]{0,N}` bounds in every arm keep a join from stitching two sentences together.
		it(`no wrapped sentence in ${name} asserts it either`, () => {
			expect(claimArmFor(text.replace(/\s+/gu, ' '))).toBeNull();
		});
	}
});

/** Every line that trips an arm, as `line:arm:text` so a failure names the key. */
function scan(source: string): string[] {
	const out: string[] = [];
	source.split('\n').forEach((line, i) => {
		const arm = claimArmFor(line);
		if (arm !== null) out.push(`${i + 1}:${arm}:${line.trim().slice(0, 120)}`);
	});
	return out;
}
