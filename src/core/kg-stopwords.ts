/**
 * Single source of truth for "this string is not a real entity".
 *
 * Used by:
 *   - {@link ./entity-extractor-v2.ts} as a post-filter on LLM tool-call output.
 *     Even with a strict prompt, Haiku occasionally returns common nouns at
 *     ≥0.8 confidence; this guards write-time.
 *   - {@link ./entity-extractor.ts} (the regex tier) as the same write-time filter.
 *   - {@link ./kg-cleanup.ts} as the rule for the historical purge.
 *   - {@link ../scripts/subject-sweep.ts} as the garbage-sweep archive predicate
 *     (incl. the person-shape class via {@link isJunkPersonShape}).
 *
 * Keeping the gate in one file means the prompt, the runtime filter, and the
 * cleanup endpoint can never drift apart.
 *
 * Extending the set: add lowercase singular AND plural for safety. Only add
 * generic nouns / verbs / adjectives — never add tokens that could be a real
 * proper noun (e.g. don't add "apple", "amazon").
 */

/**
 * Bad single-word names. Lowercase. Matched against `name.toLowerCase()`
 * exactly (no substring) so we don't nuke legitimate compounds like
 * "Personal Access Token" or "GitHub Tools".
 */
export const KG_COMMON_NOUNS: ReadonlySet<string> = new Set([
  // Prepositions / conjunctions / particles / WH-words
  'in', 'on', 'at', 'to', 'of', 'for', 'with', 'by', 'from', 'into',
  'when', 'where', 'how', 'why',
  // Verbs that v1 mis-promoted to entities
  'sync', 'syncs', 'syncing', 'synced',
  'provides', 'provided', 'providing',
  'generates', 'generated', 'generating',
  'validation', 'validates', 'validate',
  'create', 'creates', 'created', 'creating', 'creation',
  'update', 'updates', 'updated', 'updating',
  'delete', 'deletes', 'deleted', 'deleting',
  'fetch', 'fetches', 'fetched', 'fetching',
  'process', 'processes', 'processed', 'processing',
  'manage', 'manages', 'managed', 'managing',
  'review', 'reviews', 'reviewed', 'reviewing',
  'launch', 'launches', 'launched', 'launching',
  'build', 'builds', 'built', 'building',
  'log', 'logs', 'logging', 'logged',
  'monitor', 'monitors', 'monitoring', 'monitored',
  'support', 'supports', 'supported', 'supporting',
  // Generic concept nouns
  'tools', 'tool', 'einzeltools',
  'workflow', 'workflows',
  'timeline', 'timelines',
  'pipeline', 'pipelines',
  'dashboard', 'dashboards',
  'setup', 'config', 'configuration',
  'project', 'projects',
  'notification', 'notifications',
  'message', 'messages',
  'name', 'names',
  'street', 'number', 'numbers',
  'personal',
  'direct', 'interactive',
  // Adjective fragments
  'standard', 'default', 'custom',
  'strict', 'strictest',
  // Generic business/process nouns observed polluting the graph (2026-07 cleanup).
  // These reached the graph as bare person/org entities @≥0.8 — never a proper noun.
  'management', 'compliance', 'data', 'input', 'inputs', 'output', 'outputs',
  'page', 'pages', 'website', 'websites', 'information', 'feedback',
  'segment', 'segments', 'estimate', 'estimates',
  'note', 'notes', 'owner', 'owners', 'shareholder', 'shareholders',
  'identifying', 'deployment', 'deployments', 'dismissal',
  'clarification', 'confirmation', 'communication', 'communications',
  'count', 'counts', 'agreement', 'agreements', 'opt', 'import', 'imports',
  'service', 'services', 'testimonial', 'testimonials', 'meeting', 'meetings',
  'online', 'offline', 'news',
  // English function words mis-promoted to person/org.
  // NOTE: do not add 'will' (given name Will) or brand-collision nouns like
  // 'target' — matching is exact single-word, so those would drop real entities.
  'as', 'before', 'has', 'have', 'had', 'must', 'would', 'work', 'works',
  // German function/generic words
  'ist', 'sitzt', 'als', 'vor', 'hat', 'muss', 'wird',
]);

/**
 * Currency- or per-period pricing fragments AND digit-only ratios with
 * unit suffixes ("10/1k", "5/100m"). Case-insensitive.
 *
 * Two alternations:
 *   1. Optional currency + number + slash + named period   →  "CHF 39/mo"
 *   2. Plain number + slash + number(+ optional k/m/b)     →  "10/1k", "5/100"
 */
export const KG_PRICING_RE =
  /^(?:(?:chf|eur|usd|gbp|\$|€|£)\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:\d+[kmb]?|mo|mos|month|months|yr|yrs|year|years|k|hour|hours|hr|hrs|h|day|days|d|week|weeks|wk|min|mins|sec)$/i;

/**
 * Slash-separated enum/verb pairs (e.g. "lead/qualified", "create/update").
 * Dropped when either half is a known generic term. Handles pairs with
 * digits/hyphens that {@link KG_FRAGMENT_PAIR_RE} (all-lowercase-only) misses.
 */
export const KG_ENUM_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/i;

/**
 * Phrase-fragment slash pairs: two all-lowercase alphabetic words (≥3 chars each).
 * Catches "death/disability", "risk/safety", "home/lynox". This DELIBERATELY also
 * drops all-lowercase github repos (e.g. "torvalds/linux") — an accepted recall
 * trade to kill the fragment flood; a real repo reaches the graph via the v2 LLM
 * tier with context. Slash-entities with uppercase, digits, or a short (<3) half
 * (AC/DC, TCP/IP, S/4HANA) survive.
 */
export const KG_FRAGMENT_PAIR_RE = /^[a-z]{3,}\/[a-z]{3,}$/;

/**
 * Returns true if `name` is a generic noun, pricing fragment, or slash-enum
 * with at least one generic half. Case-insensitive on the input.
 *
 * Single source of truth for both the v2 extractor post-filter and the
 * historical cleanup pass.
 */
export function isCleanupTarget(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (KG_PRICING_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (!lower.includes(' ') && KG_COMMON_NOUNS.has(lower)) return true;
  if (KG_FRAGMENT_PAIR_RE.test(lower)) return true;
  if (KG_ENUM_RE.test(lower)) {
    const parts = lower.match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/i);
    if (parts) {
      const left = parts[1];
      const right = parts[2];
      if ((left && KG_COMMON_NOUNS.has(left)) || (right && KG_COMMON_NOUNS.has(right))) return true;
    }
  }
  return false;
}

/**
 * Owners that make a possessive a TOPIC rather than a name. Deliberately tiny: the rule
 * fires on the owner, so "Aurelva Women's Health" and "Levi's" — real names carrying a
 * possessive — are untouched, while "Client's compliance risk" is caught by its owner.
 */
const GENERIC_OWNERS = ['client', 'user', 'company', 'assistant', 'customer', 'operator', 'team', 'business'];
const GENERIC_POSSESSIVE_RE = new RegExp(`^(the\\s+)?(${GENERIC_OWNERS.join('|')})['\u2019]s\\s+\\S`, 'i');
const BARE_GENERIC_RE = new RegExp(`^(the\\s+)?(${GENERIC_OWNERS.join('|')})$`, 'i');

/**
 * Function words that may legitimately appear lowercase inside a name, in both languages
 * this product serves. German matters as much as English here: "Zentralstelle für Handelsdaten"
 * is a real organisation and "für" is the only lowercase token in it.
 */
const NAME_CONNECTIVES: ReadonlySet<string> = new Set([
  'of', 'and', 'the', 'for', 'at', 'by', 'in', 'on', 'to', 'vs', 'a',
  'für', 'und', 'mit', 'auf', 'im', 'am', 'an', 'zur', 'zum', 'von', 'der', 'den', 'die', 'das',
  'de', 'du', 'van', 'la', 'le', 'el', 'di', 'da',
]);

/**
 * A `v`-prefixed version token ("v2", "v10") reads as lowercase prose but is not.
 *
 * Only the `v` form is checked, and that is not an oversight: this is consulted solely from
 * the lowercase-initial branch below, so a digit-initial token ("4.6", "2024") can never
 * reach it. An earlier version matched `/^v?\d/` and documented "4.6" as a case it handles
 * — a dead half no test could kill, because nothing could reach it.
 */
function isVersionToken(w: string): boolean {
  return /^v\d/.test(w);
}

/**
 * A lowercase-initial token carrying an interior capital is a BRAND, not prose:
 * "iPhone", "reCAPTCHA", "inDesign", "eBay". Without this, rule 4 refuses "Apple iPhone"
 * and "Google reCAPTCHA" — real product names with the exact shape it looks for.
 */
function isCamelBrand(w: string): boolean {
  return /\p{Lu}/u.test(w.slice(1));
}

/**
 * True if `name` describes a TOPIC rather than naming an ENTITY — the shape that must
 * never be minted as a subject.
 *
 * Structural, not a word list, and that is the design rather than an economy: the word
 * list it would need is unbounded (a production sample produced "Technical Architecture",
 * "Compliance Strategy", "Regulatory Compliance" and "Strategic recommendation for
 * compliance and operational efficiency", sharing no vocabulary and one shape). Each rule
 * below keys on a property a real entity name does not have.
 *
 * ASYMMETRIC BY DESIGN, and the asymmetry is why it can afford to be blunt. A false
 * positive costs the fact its SUBJECT LINK — the fact is still written, still carries its
 * `subject_hint`, and a human can still bind it. A false negative mints a permanent
 * subject nobody can use, and 442 of 592 subjects on the canary instance were exactly
 * that. So the rules lean toward refusing to mint.
 *
 * KNOWN GAPS, both measured against a live 477-subject graph rather than assumed. The
 * example names are INVENTED and reproduce the measured shapes; the graph they came from
 * is a customer list and this repo is public:
 *  - a two-token Title-Case pair of abstract nouns ("Technical Architecture") is
 *    shape-identical to a real product name ("Google Cloud") and passes;
 *  - conversely "Python requests", "Qualvenn framework v2" and "die tageszeitung" are REAL
 *    names that the sentence-case rule flags. Six of 477 live subjects are false positives
 *    of this kind.
 * Separating either pair needs vocabulary, not shape, which is why the extraction prompt —
 * not this filter — is the primary defence and this is the net beneath it.
 *
 * ⚠ NOT AN ARCHIVE ORACLE. `subject-sweep.ts` decides what to soft-archive from
 * {@link isCleanupTarget}, and this must not be substituted for it: there, a false
 * positive REMOVES a real subject, inverting the asymmetry the rules above are tuned for.
 * A dry run over the same graph flagged one engagement carrying 58 memories and two
 * subjects that are people's names. The tuning that is right for refusing a mint is wrong
 * for undoing one.
 *
 * An earlier cut also refused any name over four tokens. It was removed, and the honest
 * account matters more than the removal: it DID catch a class the surviving rules miss —
 * long all-Title-Case clauses, "Strategic Recommendation For Compliance And Operational
 * Efficiency", "Q4 Marketing Budget Planning And Approval Workflow". Those leak today.
 * (An earlier version of this comment claimed the cap "caught NOTHING the others miss".
 * That was measured on a corpus containing no such name — a true statement about the
 * SAMPLE, asserted about the RULE.)
 *
 * It stays removed because every variant costs more than it earns. Measured over the live
 * graph: a cap of 4 wrongly refuses 3 real subjects, a cap of 5 refuses 2, and pairing the
 * cap with "contains a generic noun" still refuses "AI for Science Innovation Factory" and
 * "Shopify Custom App Admin API Access Token" while missing "Technical Architecture
 * Decision Record Summary". A long Title-Case clause and a long Title-Case name are one
 * shape; neither length nor noun-presence separates them.
 *
 * Likewise an all-lowercase-phrase rule stood here, and briefly an article rule after it.
 * Both are gone for the same measured reason: over the live graph neither flagged a single
 * subject, while the article rule refused "die tageszeitung" and "the Ocean Cleanup". So
 * article-led descriptions ("the iPhone") leak. Every rule here has to earn its false
 * positives on the real corpus, not on a plausible example.
 */
export function isTopicShapedName(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  // 1. "Client's compliance risk" — a possessive whose owner is a role, not a party.
  if (GENERIC_POSSESSIVE_RE.test(t)) return true;
  // 2. "the user", "Company" — the role standing alone.
  if (BARE_GENERIC_RE.test(t)) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  // (An all-lowercase-phrase rule stood here and was REMOVED. Measured over the 477 live
  //  subjects plus the known bad names, it caught exactly one string the rule below does
  //  not — "de la" — which is not a shape any writer produces. A rule that fires only on
  //  inputs nothing generates is not a safety net, it is an untested branch: nothing can
  //  kill it, so it cannot be shown to work either.)
  // (An article rule stood here for one commit and was REMOVED. It caught "the iPhone"
  //  and "das Angebot" — and refused "die tageszeitung", "die Mobiliar", "das Örtliche",
  //  "the Ocean Cleanup", plus every extractor that writes a real name mid-sentence
  //  ("the Guardian", "the North Face"). Over the live graph it flagged exactly ZERO
  //  subjects, so it was pure downside: a rule that catches nothing here and refuses real
  //  names elsewhere. Article-led descriptions therefore LEAK, and that is the accepted
  //  trade — same conclusion, and the same reason, as the token cap above.)

  // 3. "Compliance and regulatory risks", "MURRANTO Ventures regional preferences" — a
  //    lowercase content word inside a multi-word name is sentence case, i.e. prose.
  //
  //    THIS RULE HAS AN IRREDUCIBLE ERROR RATE, measured rather than feared: "Python
  //    requests" and "Qualvenn framework v2" are real names with exactly the shape of
  //    "lynox platform features", which is not. No structural rule separates them; only
  //    vocabulary would. It is kept because the two directions cost differently on THIS
  //    path — see the asymmetry note above — and it is why {@link isTopicShapedName} must
  //    not be used to decide an ARCHIVE, where the costs invert.
  if (tokens.length > 1 && tokens.some((w, i) =>
    i > 0 && /^\p{Ll}/u.test(w) && !NAME_CONNECTIVES.has(w.toLowerCase())
    && !isVersionToken(w) && !isCamelBrand(w))) return true;
  // 4. The existing generic-noun/pricing/fragment machinery, which this extends.
  return isCleanupTarget(t);
}

/**
 * True if a `person`-typed name has a shape that is almost never a real person, so the
 * extractor can refuse to mint a person subject WITHOUT a stopword entry — which would
 * collide with real names/brands (this is exactly why 'will'/'target' are kept OUT of
 * KG_COMMON_NOUNS). Only shape-based (rules 1–2 of the person gate); the harder
 * "single-token capitalized name needs corroboration" (rule 3) needs the extraction's
 * relations/resolver context and lives at the persist layer, not here.
 *
 * Caller MUST gate on `type === 'person'` — these shapes are legitimate for other kinds
 * (org "IBM", product "S3", "3M"). Multi-token names are always kept.
 */
export function isJunkPersonShape(name: string): boolean {
  const t = name.trim();
  if (!t || t.includes(' ')) return false;   // empty / multi-token → not our concern here
  // Rule 1: acronym / symbol token — all-caps + digits/&/./- , short (CSV, API, S3, R&D).
  // ACCEPTED RECALL TRADE: a short all-caps mononym or initials used AS the person's
  // canonical name (SZA, JR, TJ) is shape-identical to junk (CSV) and gets dropped too —
  // acronym-junk-as-person is far more common than that in a business assistant, and a
  // real person re-enters via their full name when the model has it. Same shape-trade
  // philosophy as the slash-fragment rule.
  if (/^[A-Z0-9][A-Z0-9.&-]*$/.test(t) && t.length <= 6) return true;
  // Rule 1b: any digit in a single token — a real person's single name has none (v2, 360, x1).
  if (/\d/.test(t)) return true;
  // Rule 2: lowercase-initial single token — 'will', 'target', 'data' as they occur
  // mid-sentence. A capitalized single token (Will, Roland) is NOT rejected here — that
  // is rule 3's job (corroboration), so real first names survive. (A lowercase-stylized
  // real mononym like 'bell'/'danah' is dropped — relies on names being proper-cased.)
  if (/^\p{Ll}/u.test(t)) return true;
  return false;
}
