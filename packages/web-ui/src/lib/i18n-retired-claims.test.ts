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
 * WHY THIS FILE WAS REWRITTEN. Its first version looked for two NAMED KEYS and
 * forbade four LITERAL STRINGS in them. `config.provider_desc` was a third key
 * carrying a fifth wording of the same claim, and was structurally unreachable —
 * the PR that repaired three wordings in this very file walked past the fourth,
 * and so did the test it shipped. The most dangerous place is the one the fix
 * lives in.
 *
 * ⚠ WHAT THIS IS, STATED HONESTLY. It is NOT a detector "by claim" — nothing
 * built out of regular expressions reads meaning. It matches CLAIM SHAPES over a
 * corpus, and its coverage IS that corpus. The first draft of this rewrite called
 * itself claim-based; an adversary asked for wordings that assert the claim and
 * slip through, and produced **31 on the first pass** — `device`, `laptop`, `box`,
 * `Rechner`, `Gerät`, `Umgebung`, `Installation`, subjects other than "data",
 * `goes out` instead of `leaves`. The vocabulary lists below exist because of
 * that, and they are still lists: **a wording nobody has written down yet will
 * pass.** The honest bound is "everything we have ever seen, plus what one
 * adversarial pass could invent", and the correct response to a new one is to add
 * it here, not to assume it cannot exist.
 *
 * MEASURED IN BOTH DIRECTIONS, because widening is how a claim detector starts
 * failing on true copy. The same adversarial pass produced eight FALSE ALARMS,
 * and the sharpest one was the honest correction itself — "Nur die Inferenz
 * erreicht deinen LLM-Anbieter — Websuche und HTTP-Tool gehen woanders hin"
 * names the very egress the claim forgets, and the first draft rejected it. A
 * guard that reds correct copy is a guard someone deletes. Every case below is
 * asserted in both directions.
 *
 * The sources are read as text, like `preset-cards-i18n.test.ts` does, so this
 * does not depend on a Svelte-aware import of the runes module.
 */

/*
 * Vocabularies, so a widening happens in ONE place instead of inside five
 * regexes — the shape that let `machine` be covered while `laptop` was not.
 */
const HOST_EN =
	'(networks?|hosts?|machines?|systems?|servers?|devices?|laptops?|computers?|boxes|box|hardware|infrastructure|premises)';
const HOST_DE =
	'(Netzwerke?|Netze[sn]?|Netz|Hosts?|Maschinen?|Systeme?n?|Servern?|Server|Rechnern?|Rechner|Ger(ä|ae)te?n?|Umgebungen?|Umgebung|Installationen?|Installation|Infrastrukturen?|Infrastruktur)';
/**
 * The possessor decides who the sentence is about. `your host` is the self-host
 * claim; `our servers in Zurich` is an accurate statement about what WE run.
 */
const YOURS_EN = '(your|the|this|that)';
const YOURS_DE = '(dein|deine|deinen|deinem|das|den|die|der)';
/** A trailing manner clause turns "nothing leaves" into a claim about HOW, not WHETHER. */
const MANNER =
	'(?![^.]{0,40}\\b(unencrypted|without|encrypted|ohne|verschl(ü|ue)sselt|unverschl(ü|ue)sselt)\\b)';
/**
 * Checked on the span BETWEEN the egress verb and the host noun, not from the
 * start of the sentence: in "Nothing leaves the servers in our Zurich data
 * centre" the `our` is thirty characters in, and a sentence-anchored lookahead
 * did not reach it — the first attempt at this exclusion missed that sentence
 * and kept the false alarm.
 */
const NOT_OURS = '(?![^.]{0,60}\\b(our|unsere[rnms]?|unser)\\b)';

/**
 * The claim, decomposed into the shapes it gets asserted in. A hit on any arm is
 * a hit. Arms are named so a failure says WHICH shape fired, not only that
 * something did.
 */
const CLAIM_ARMS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		'only-X-leaves',
		new RegExp(
			`(only|sole) thing that (ever )?(leaves|goes out|exits)[^.]{0,40}\\b(inference|model|provider|prompt|API)` +
				`|Einzige, was[^.]{0,40}${HOST_DE}\\b[^.]{0,20}(verl(ä|ae)sst|verlassen)[^.]{0,30}\\b(Inferenz|Modell|Provider|Anbieter|Prompt|API)` +
				`|einzige ausgehende [^.]{0,20}ist[^.]{0,30}\\b(Inferenz|Modell|Provider|Anbieter|API)`,
			'i',
		),
	],
	[
		'nothing-leaves',
		new RegExp(
			`${MANNER}(nothing|no (data|prompts?|content|files?)|zero (data|prompts?))\\b[^.]{0,25}\\b(leaves?|leave|goes? out|exits?|is (sent|transmitted))\\b${NOT_OURS}[^.]{0,15}${YOURS_EN}\\s+${HOST_EN}\\b` +
				`|${MANNER}\\b(your|the) (data|prompts?|content|files?)\\b[^.]{0,20}\\bnever (leaves?|goes out|exits?)\\b${NOT_OURS}[^.]{0,15}${YOURS_EN}\\s+${HOST_EN}\\b` +
				`|${MANNER}(Null|Keine) (Daten|Inhalte|Prompts?|Dateien)\\b[^.]{0,20}(verlassen|verl(ä|ae)sst|gehen [^.]{0,10}raus)\\b${NOT_OURS}[^.]{0,15}${YOURS_DE}\\s*${HOST_DE}\\b` +
				`|${MANNER}(verl(ä|ae)sst nichts|nichts verl(ä|ae)sst)\\b${NOT_OURS}[^.]{0,25}${YOURS_DE}?\\s*${HOST_DE}\\b` +
				`|${MANNER}\\b(Deine|Ihre) (Daten|Inhalte)\\b[^.]{0,25}(verlassen|verl(ä|ae)sst)\\b[^.]{0,20}\\bnie\\b`,
			'i',
		),
	],
	[
		'runs-everything-locally',
		/(?![^.]{0,40}\b(was|soweit|angeht|betrifft)\b)(runs everything locally|l(ä|ae)uft alles lokal|everything runs on your own \w+|alles bleibt bei dir)/i,
	],
	[
		'only-provider-receives',
		/only your chosen[^.]{0,40}receives prompts|nur dein gew(ä|ae)hlter[^.]{0,40}erh(ä|ae)lt Prompts|only communicates with the LLM provider|kommuniziert[^.]{0,20}ausschliesslich mit[^.]{0,30}LLM-Anbieter|talks? to exactly one thing[^.]{0,30}(internet|provider)|spricht[^.]{0,20}mit genau einem (Dienst|Anbieter)|does ?n['’]?o?t go anywhere but[^.]{0,30}(LLM|provider)/i,
	],
	[
		'data-stays-local',
		new RegExp(
			`(?![^.]{0,30}\\b(stored|gespeichert|storage)\\b)` +
				`\\b(your |the )?(data|content|prompts?) stays? (local|on-prem|on your \\w+)\\b` +
				`|(?![^.]{0,30}\\b(gespeichert|Speicher)\\b)\\b(Daten|Inhalte)\\b[^.]{0,20}\\bbleiben\\b[^.]{0,15}\\b(lokal|on-prem)\\b`,
			'i',
		),
	],
	/*
	 * The claim is about what leaves the HOST. "Only inference reaches the provider"
	 * is TRUE — it is the shape the registry prescribes for the correction — so this
	 * arm requires an egress object rather than firing on "only … inference".
	 */
	[
		'only-inference',
		new RegExp(
			`\\bonly[^.]{0,15}\\b(inference|model|provider) (call|request)?[^.]{0,10}\\b(leaves?|goes out|exits?)\\b[^.]{0,15}${YOURS_EN}\\s+${HOST_EN}\\b` +
				`|\\bonly[^.]{0,15}\\binference\\b[^.]{0,20}\\bleaves\\b` +
				`|\\bnur\\b[^.]{0,20}\\b(Inferenz|Modellaufruf|Modell-Aufruf|Provider-Call)\\b[^.]{0,20}(verl(ä|ae)sst|geht [^.]{0,10}(raus|nach aussen))\\b` +
				`|Ausser dem (Inferenz|Modell)[^.]{0,20}geht nichts nach aussen`,
			'i',
		),
	],
];

/** The arm a text trips, or null. This is the whole detector; everything else drives it. */
export function claimArmFor(text: string): string | null {
	for (const [name, rx] of CLAIM_ARMS) if (rx.test(text)) return name;
	return null;
}

/**
 * Everything that must be caught, with provenance.
 *
 * `shipped` rows are wordings that were actually removed as this claim, taken
 * from the pull requests that removed them. `probe` rows come from one
 * adversarial pass whose only brief was "write copy that asserts this claim and
 * slips through" — they were misses when they were written, which is what makes
 * them worth keeping.
 */
const MUST_CATCH: ReadonlyArray<readonly ['shipped' | 'probe', string]> = [
	['shipped', 'LLaMA, Qwen oder Mistral lokal. Null Daten verlassen dein Netzwerk.'],
	['shipped', 'Run LLaMA, Qwen, or Mistral locally. Zero data leaves your network.'],
	['shipped', 'lynox stays on your infrastructure — only your chosen LLM provider receives prompts.'],
	['shipped', 'Das Einzige, was diesen Host verlässt, ist der Inferenz-Call an den LLM-Anbieter.'],
	['shipped', 'zeigst du auf ein Ollama on-prem, verlässt nichts dein Netz.'],
	['shipped', 'The only thing that leaves that host is the inference call to whichever LLM provider you pointed lynox at.'],
	['shipped', 'point at an on-prem Ollama and nothing leaves your network.'],
	['shipped', 'When you run lynox on your own infrastructure, the software only communicates with the LLM provider whose API key you configure.'],
	['shipped', 'Wenn du lynox auf deiner eigenen Infrastruktur betreibst, kommuniziert die Software ausschliesslich mit dem von dir konfigurierten LLM-Anbieter.'],
	['shipped', 'With whisper.cpp nothing leaves your machine.'],
	['shipped', 'With whisper.cpp it runs everything locally.'],
	['shipped', 'Mit whisper.cpp läuft alles lokal.'],
	['shipped', 'Your machine — nothing leaves the host'],
	['shipped', 'SearXNG runs as local Docker sidecar (no data leaves the host).'],
	['shipped', 'Nothing leaves the hosts you run this on.'],
	['shipped', 'Keine Daten verlassen deine Systeme.'],
	['shipped', 'Local models via Ollama — nothing leaves your machine.'],
	['shipped', 'Wohin werden KI-Anfragen gesendet? Daten bleiben immer lokal — nur die Inferenz nutzt den Provider.'],
	['shipped', 'Where are AI requests sent? Your data stays local — only inference uses the provider.'],
	['probe', 'Nothing ever leaves your device — only the model call goes to the provider.'],
	['probe', 'Your data never leaves the machine; only the inference request is sent out.'],
	['probe', 'With whisper.cpp nothing leaves your laptop.'],
	['probe', 'Nothing leaves the hardware you run this on.'],
	['probe', 'Zero prompts leave your network.'],
	['probe', 'The only thing that ever goes out is the inference call.'],
	['probe', 'Your data stays on-prem — only the provider call goes out.'],
	['probe', 'Only the model call leaves the host; everything else is handled on your box.'],
	['probe', 'Self-hosted installs talk to exactly one thing on the internet: your LLM provider.'],
	['probe', 'When you host lynox, your content doesn’t go anywhere but to the LLM you chose.'],
	['probe', 'Everything runs on your own hardware; only the model request leaves it.'],
	['probe', 'Keine Daten verlassen deinen Rechner.'],
	['probe', 'Keine Daten verlassen dein Gerät.'],
	['probe', 'Keine Daten verlassen deine Umgebung.'],
	['probe', 'Keine Daten verlassen deine Installation.'],
	['probe', 'Deine Daten verlassen dein System nie — nur die Anfrage ans Modell geht raus.'],
	['probe', 'Nur der Modellaufruf verlässt deinen Server, sonst nichts.'],
	['probe', 'Inhalte bleiben immer lokal — nur der Provider-Call geht raus.'],
	['probe', 'Nichts verlässt deinen Rechner ausser dem Modell-Aufruf an den Anbieter.'],
	['probe', 'Ausser dem Inferenz-Aufruf geht nichts nach aussen.'],
	['probe', 'Der einzige ausgehende Verkehr ist der Aufruf an deinen LLM-Anbieter.'],
	['probe', 'Alles bleibt bei dir — einzig der Aufruf ans Sprachmodell geht nach aussen.'],
	['probe', 'Selbstgehostet spricht lynox mit genau einem Dienst im Internet: deinem LLM-Anbieter.'],
];

/**
 * Sentences that are TRUE and must survive. The live product strings are here on
 * purpose: a false alarm on correct copy turns a required check red for the wrong
 * reason, which is how a guard gets deleted instead of fixed.
 *
 * `false-alarm` rows are the ones an adversarial pass caught this detector firing
 * on. The last of them is the one that matters most — it names the web search and
 * the HTTP tool, which is exactly the honesty the retired claim was missing, and
 * an earlier draft rejected it.
 */
const MUST_CLEAR: ReadonlyArray<readonly ['honest' | 'false-alarm', string]> = [
	['honest', 'Lokal via whisper.cpp verlässt kein Audio dein System.'],
	['honest', 'With whisper.cpp the audio stays on your machine.'],
	['honest', 'Your machine — the model call stays on the host'],
	['honest', 'Local models via Ollama — the model call stays on your machine.'],
	['honest', 'Wohin werden KI-Anfragen gesendet? Der Provider erhält den Inferenz-Aufruf; was sonst nach aussen geht, hängt von deiner Konfiguration ab und davon, was der Agent tut.'],
	['honest', 'Where are AI requests sent? The provider receives the inference call; what else goes out depends on your configuration and on what the agent does.'],
	['honest', 'Der Container verlässt das Rechenzentrum nie; er wird dort gebaut und dort betrieben.'],
	['honest', 'Kein Backup verlässt das Schweizer Rechenzentrum, in dem die Instanz läuft.'],
	['honest', 'Keine Daten verlassen das Rechenzentrum in Zürich.'],
	['honest', 'No data leaves the EU region for managed instances.'],
	['honest', 'No customer data leaves the data centre without an SCC in place.'],
	['honest', 'Die Modelle laufen lokal; was sonst noch nach aussen geht, hängt von deiner Installation ab.'],
	['honest', 'With whisper.cpp no audio leaves your machine.'],
	['honest', 'Nichts verlässt das Hostingzentrum in Zürich.'],
	['honest', 'Nothing leaves your hosting provider without an SCC.'],
	['honest', 'Keine Daten verlassen das Hostingzentrum in Zürich.'],
	['honest', 'Nothing leaves the hosting cluster unencrypted.'],
	['honest', 'Deine Audiodaten bleiben lokal.'],
	['honest', 'Der Inferenz-Aufruf dauert nur so lange wie die Anfrage.'],
	['honest', 'The inference call lasts only for that request.'],
	['false-alarm', 'Keine Daten verlassen unsere Server in Zürich.'],
	['false-alarm', 'Nothing leaves the servers in our Zurich data centre.'],
	['false-alarm', 'No data leaves your server without an audit-log entry.'],
	['false-alarm', 'Nothing leaves the host unencrypted — TLS 1.3 on every hop.'],
	['false-alarm', 'Deine Daten bleiben lokal gespeichert, bis du sie löschst.'],
	['false-alarm', 'Bei whisper.cpp läuft alles lokal, was die Transkription angeht.'],
	['false-alarm', 'Das Einzige, was dein Netz verlässt, ist verschlüsselt.'],
	['false-alarm', 'Nur die Inferenz erreicht deinen LLM-Anbieter — Websuche und HTTP-Tool gehen woanders hin.'],
];

describe('i18n — the "only inference leaves" claim stays retired', () => {
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

	describe('catches every wording that asserts the claim', () => {
		for (const [origin, text] of MUST_CATCH) {
			it(`[${origin}] ${text.slice(0, 60)}`, () => {
				expect(claimArmFor(text), text).not.toBeNull();
			});
		}
	});

	describe('leaves true sentences alone', () => {
		for (const [origin, text] of MUST_CLEAR) {
			it(`[${origin}] ${text.slice(0, 60)}`, () => {
				expect(claimArmFor(text), text).toBeNull();
			});
		}
	});

	/*
	 * The anti-survivor property, enforced rather than hand-maintained.
	 *
	 * An earlier draft added two arms that no case separated: every wording that had
	 * really shipped tripped at least two arms, so deleting either left the suite green
	 * and neither could be shown to do anything. That was patched with four constructed
	 * sentences carrying one arm each — a crutch for a corpus that was too small. The
	 * adversarial rows made the crutch unnecessary AND let the property be checked
	 * directly, which also covers every arm somebody adds later.
	 */
	it('every arm carries at least one case no other arm covers', () => {
		const orphansIfRemoved = (i: number): number => {
			const rest = CLAIM_ARMS.filter((_, j) => j !== i);
			return MUST_CATCH.filter(([, t]) => !rest.some(([, rx]) => rx.test(t))).length;
		};
		const dead = CLAIM_ARMS.map(([name], i) => [name, orphansIfRemoved(i)] as const).filter(
			([, n]) => n === 0,
		);
		expect(dead, 'arms no case depends on — unkillable, and they read as coverage').toEqual([]);
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
	 * The arms can only assert ABSENCE, and absence cannot tell a correction from a
	 * deletion: copy reworded into something vague trips nothing at all. These pin the
	 * PRESENCE of the replacements. #1305 merged after #1306 and carried the old voice
	 * string back in — a branch cut before the fix, touching the same file.
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

		// A sentence wrapped across lines is invisible to a per-line scan. The `[^.]{0,N}`
		// bounds in every arm keep a join from stitching two sentences together.
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
