import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale, t } from './i18n.svelte.js';

// The inbox rules' texts as ux wrote them, byte for byte, in both languages: the rule view's
// proposals, confirming, the count of waiting proposals, the name field, the description kind
// with its hints, the filter by rule and the reading pane's note on a rule held back. A text that
// changes here changes with ux, not on its own.
const WORDING: ReadonlyArray<readonly [key: string, de: string, en: string]> = [
	['inbox.rules_proposals_title', 'Vorschläge des Assistenten', 'Suggestions from the assistant'],
	['inbox.rules_proposals_intro', 'Diese Regeln hat der Assistent vorgeschlagen. Sie wirken erst, wenn du sie bestätigst. Ein Vorschlag legt Mails immer unter „Braucht dich“ ab. Je Konto können höchstens 10 Vorschläge gleichzeitig warten.', 'The assistant suggested these rules. They only apply once you confirm them. A suggestion always puts mail under “Needs you”. Up to 10 suggestions per account can wait at a time.'],
	['inbox.rules_proposals_mandate', 'Bestätigen kann nur der Inhaber dieser Instanz. Brauchst du die Regel, wende dich an den Inhaber.', 'Only the owner of this instance can confirm it. If you need the rule, ask the owner.'],
	['inbox.rules_proposal_badge', 'Vorschlag des Assistenten', 'Suggested by the assistant'],
	['inbox.rules_confirm', 'Bestätigen', 'Confirm'],
	['inbox.rules_confirm_text', 'Regel „{name}“ bestätigen? Wenn {match} „{value}“, dann „{bucket}“. Sie wirkt, sobald du bestätigst.', 'Confirm rule “{name}”? When {match} “{value}”, then “{bucket}”. It applies as soon as you confirm.'],
	['inbox.rules_error_confirm', 'Regel konnte nicht bestätigt werden. Lade die Seite neu und versuch es noch einmal.', 'Could not confirm the rule. Reload the page and try again.'],
	['inbox.rules_pending_count', '{count} Vorschläge warten auf Bestätigung', '{count} suggestions waiting for confirmation'],
	['inbox.rules_pending_count_one', '1 Vorschlag wartet auf Bestätigung', '1 suggestion waiting for confirmation'],
	['inbox.rules_name_label', 'Name (optional)', 'Name (optional)'],
	['inbox.rules_name_placeholder', 'Ohne Namen heisst die Regel wie ihr Prüfwert', 'Without a name, the rule is named after its value'],
	['inbox.rules_match_description', 'Mail passt zur Beschreibung', 'Mail matches description'],
	['inbox.rules_description_placeholder', 'z. B. Mahnungen und Zahlungserinnerungen', 'e.g. dunning letters and payment reminders'],
	['inbox.rules_description_hint', 'Beschreib in einer Zeile, welche Mails gemeint sind (3 bis 300 Zeichen). lynox prüft neue Mails mit dem KI-Modell dagegen. Höchstens 20 Beschreibungsregeln je Konto.', 'Describe in one line which mails you mean (3 to 300 characters). lynox checks new mail against it with the AI model. Up to 20 description rules per account.'],
	['inbox.rules_error_rule_label', 'Kennungen wie „R1“ oder „R2“ verwendet lynox intern, um Regeln zu unterscheiden. Sie dürfen nicht in Name oder Beschreibung stehen; formulier es ohne sie.', 'lynox uses labels like “R1” or “R2” internally to tell rules apart. They must not appear in a name or description; phrase it without them.'],
	['inbox.rules_description_overlap', 'Passen mehrere Beschreibungsregeln auf eine Mail, etwa „Mahnung“ und „Rechnung“, nimmt lynox die genaueste.', 'If several description rules fit a mail, such as “dunning letter” and “invoice”, lynox takes the most specific one.'],
	['inbox.rules_description_out_of_office', 'Abwesenheitsnotizen trifft keine Beschreibungsregel. Feste Regeln greifen bei ihnen weiter.', 'Out-of-office replies never match a description rule. Fixed rules still apply to them.'],
	['inbox.rules_description_handled_hint', 'Mit „{then}“ greift eine Beschreibungsregel nur, wenn auch der Klassifikator die Mail so einordnet. Sonst hält lynox die Regel zurück und zeigt dir die Mail.', 'With “{then}”, a description rule only applies if the classifier sorts the mail the same way. Otherwise lynox holds the rule back and shows you the mail.'],
	['inbox.rules_items_link', 'Mails dieser Regel', 'Mail from this rule'],
	['inbox.rule_filter_chip', 'Regel: {name}', 'Rule: {name}'],
	['inbox.rule_filter_clear', 'Filter aufheben', 'Clear filter'],
	['inbox.rule_filter_empty', 'Zurzeit liegt keine Mail dieser Regel in der Inbox.', 'No mail from this rule is in the inbox right now.'],
	['inbox.rule_withheld_classifier', 'Regel „{name}“ zurückgehalten: Der Klassifikator ordnete diese Mail anders ein, darum zeigt lynox sie dir. Soll die Regel hier immer greifen, mach daraus eine feste Regel.', 'Rule “{name}” held back: the classifier sorted this mail differently, so lynox shows it to you. If the rule should always apply here, turn it into a fixed rule.'],
	['inbox.rule_withheld_unchecked', 'Regel „{name}“ zurückgehalten: Die Prüfung konnte nicht laufen, etwa wegen fehlendem KI-Budget oder Guthaben, darum zeigt lynox dir die Mail. Soll die Regel ohne Prüfung greifen, mach daraus eine feste Regel.', 'Rule “{name}” held back: the check could not run, for example because of no AI budget or credit, so lynox shows you the mail. If the rule should apply without a check, turn it into a fixed rule.'],
	['inbox.rule_withheld_sensitive', 'Regel „{name}“ zurückgehalten: Diese Mail wirkt sensibel. Eine Regel legt solche Mails nie als erledigt ab, darum zeigt lynox sie dir.', 'Rule “{name}” held back: this mail looks sensitive. A rule never files such mail as handled, so lynox shows it to you.'],
	['inbox.rule_withheld_forwarded', 'Regel „{name}“ zurückgehalten: Diese Mail hat eine Person weitergeleitet. Solche Mails legt eine Beschreibungsregel nicht als erledigt ab, darum zeigt lynox sie dir. Soll die Regel auch hier greifen, mach daraus eine feste Regel.', 'Rule “{name}” held back: a person forwarded this mail. A description rule does not file such mail as handled, so lynox shows it to you. If the rule should apply here too, turn it into a fixed rule.'],
	['inbox.rule_withheld_from_sender', 'Feste Regel aus dem Absender', 'Fixed rule from sender'],
	['inbox.rule_withheld_from_subject', 'Feste Regel aus dem Betreff', 'Fixed rule from subject'],
	['inbox.rules_then_escalate', 'Immer unter „Braucht dich“ behalten', 'Always keep under “Needs you”'],
	['inbox.rule_withheld_classifier_unnamed', 'Regel zurückgehalten: Der Klassifikator ordnete diese Mail anders ein, darum zeigt lynox sie dir. Soll die Regel hier immer greifen, mach daraus eine feste Regel.', 'Rule held back: the classifier sorted this mail differently, so lynox shows it to you. If the rule should always apply here, turn it into a fixed rule.'],
	['inbox.rule_withheld_unchecked_unnamed', 'Regel zurückgehalten: Die Prüfung konnte nicht laufen, etwa wegen fehlendem KI-Budget oder Guthaben, darum zeigt lynox dir die Mail. Soll die Regel ohne Prüfung greifen, mach daraus eine feste Regel.', 'Rule held back: the check could not run, for example because of no AI budget or credit, so lynox shows you the mail. If the rule should apply without a check, turn it into a fixed rule.'],
	['inbox.rule_withheld_sensitive_unnamed', 'Regel zurückgehalten: Diese Mail wirkt sensibel. Eine Regel legt solche Mails nie als erledigt ab, darum zeigt lynox sie dir.', 'Rule held back: this mail looks sensitive. A rule never files such mail as handled, so lynox shows it to you.'],
	['inbox.rule_withheld_forwarded_unnamed', 'Regel zurückgehalten: Diese Mail hat eine Person weitergeleitet. Solche Mails legt eine Beschreibungsregel nicht als erledigt ab, darum zeigt lynox sie dir. Soll die Regel auch hier greifen, mach daraus eine feste Regel.', 'Rule held back: a person forwarded this mail. A description rule does not file such mail as handled, so lynox shows it to you. If the rule should apply here too, turn it into a fixed rule.'],
	['inbox.rules_match_from', 'Absender ist', 'Sender is'],
	['inbox.rules_match_from_placeholder', 'z. B. rechnung@lieferant.ch', 'e.g. invoices@supplier.com'],
	['inbox.rules_then_choose_hint', 'Wähl unter „Dann“, was mit diesen Mails geschehen soll. Erst dann lässt sich die Regel speichern.', 'Choose under “Then” what should happen to these mails. Only then can the rule be saved.'],
	['inbox.rules_error_from_address', 'Trag eine ganze Absenderadresse ein, etwa rechnung@lieferant.ch. Die Regel prüft genau diese eine Adresse; Teile wie „noreply@“ oder eine Domain allein gehen nicht. Für mehrere Adressen leg je eine Regel an.', 'Enter one whole sender address, such as invoices@supplier.com. The rule checks exactly this one address; parts such as “noreply@” or a domain alone do not work. For several addresses, add one rule each.'],
	// Nachtrag 4-6 (form refusals, list id, the count, the bucket, the intro, the mandate's note).
	['inbox.rules_error_subject_short', 'Gib mindestens 3 Zeichen ein; kürzere Teile wie „Hi“ träfen fast jede Mail.', 'Enter at least 3 characters; shorter parts such as “Hi” would match almost any mail.'],
	['inbox.rules_error_hidden_chars', 'Der Wert enthält ein unsichtbares Zeichen, einen Zeilenumbruch oder einen Tab. Tipp ihn von Hand ein, statt ihn einzufügen.', 'The value contains an invisible character, a line break or a tab. Type it by hand instead of pasting it.'],
	// Provisional, pending UX.
	['inbox.rules_error_too_long', 'Der Wert darf höchstens 200 Zeichen lang sein.', 'The value can be at most 200 characters long.'],
	['inbox.rules_error_list_id', 'Regeln nach List-ID lassen sich derzeit nicht anlegen, weil lynox die List-ID von Mails noch nicht liest; eine solche Regel würde nie greifen. Leg stattdessen eine Regel mit „Absender ist“ an.', 'Rules by List-ID cannot be added at the moment, because lynox does not read the List-ID of mails yet; such a rule would never apply. Add a rule with “Sender is” instead.'],
	['inbox.rules_list_id_inactive', 'Diese Regel greift derzeit nicht, weil lynox die List-ID von Mails noch nicht liest. Willst du diese Mails jetzt schon sortieren, leg eine Regel mit „Absender ist“ an.', 'This rule does not apply at the moment, because lynox does not read the List-ID of mails yet. To sort these mails now, add a rule with “Sender is”.'],
	['inbox.rules_count_one', '1 Regel', '1 rule'],
	['inbox.rules_count', '{count} Regeln', '{count} rules'],
	['inbox.rules_bucket_handled', 'Erledigt', 'Handled'],
	['inbox.rules_intro', 'Regeln sortieren Mails, bevor lynox sie selbst einordnet. Eine feste Regel prüft eine ganze Absenderadresse oder einen Text im Betreff; Gross- und Kleinschreibung zählt dabei nicht. Eine Beschreibungsregel prüft neue Mails mit dem KI-Modell gegen deine Beschreibung, etwa „Rechnungen von Lieferanten“.', 'Rules sort mail before lynox sorts it itself. A fixed rule checks a whole sender address or a text in the subject; upper and lower case do not matter. A description rule checks new mail against your description with the AI model, such as “invoices from suppliers”.'],
	['inbox.rule_withheld_classifier_mandate', 'Regel „{name}“ zurückgehalten: Der Klassifikator ordnete diese Mail anders ein, darum zeigt lynox sie dir. Eine feste Regel daraus kann der Inhaber anlegen.', 'Rule “{name}” held back: the classifier sorted this mail differently, so lynox shows it to you. The owner can turn it into a fixed rule.'],
	['inbox.rule_withheld_classifier_mandate_unnamed', 'Regel zurückgehalten: Der Klassifikator ordnete diese Mail anders ein, darum zeigt lynox sie dir. Eine feste Regel daraus kann der Inhaber anlegen.', 'Rule held back: the classifier sorted this mail differently, so lynox shows it to you. The owner can turn it into a fixed rule.'],
	['inbox.rule_withheld_unchecked_mandate', 'Regel „{name}“ zurückgehalten: Die Prüfung konnte nicht laufen, etwa wegen fehlendem KI-Budget oder Guthaben, darum zeigt lynox dir die Mail. Eine feste Regel daraus kann der Inhaber anlegen.', 'Rule “{name}” held back: the check could not run, for example because of no AI budget or credit, so lynox shows you the mail. The owner can turn it into a fixed rule.'],
	['inbox.rule_withheld_unchecked_mandate_unnamed', 'Regel zurückgehalten: Die Prüfung konnte nicht laufen, etwa wegen fehlendem KI-Budget oder Guthaben, darum zeigt lynox dir die Mail. Eine feste Regel daraus kann der Inhaber anlegen.', 'Rule held back: the check could not run, for example because of no AI budget or credit, so lynox shows you the mail. The owner can turn it into a fixed rule.'],
	['inbox.rule_withheld_forwarded_mandate', 'Regel „{name}“ zurückgehalten: Diese Mail hat eine Person weitergeleitet. Solche Mails legt eine Beschreibungsregel nicht als erledigt ab, darum zeigt lynox sie dir. Eine feste Regel daraus kann der Inhaber anlegen.', 'Rule “{name}” held back: a person forwarded this mail. A description rule does not file such mail as handled, so lynox shows it to you. The owner can turn it into a fixed rule.'],
	['inbox.rule_withheld_forwarded_mandate_unnamed', 'Regel zurückgehalten: Diese Mail hat eine Person weitergeleitet. Solche Mails legt eine Beschreibungsregel nicht als erledigt ab, darum zeigt lynox sie dir. Eine feste Regel daraus kann der Inhaber anlegen.', 'Rule held back: a person forwarded this mail. A description rule does not file such mail as handled, so lynox shows it to you. The owner can turn it into a fixed rule.'],
];

const localeBefore = getLocale();
afterEach(() => setLocale(localeBefore));

describe('inbox rules wording', () => {
	it.each(WORDING)('%s reads as ux wrote it, in German and in English', (key, de, en) => {
		setLocale('de');
		expect(t(key)).toBe(de);
		setLocale('en');
		expect(t(key)).toBe(en);
	});

	it('names the bucket of a rule that escalates as the inbox does', () => {
		setLocale('de');
		expect(t('inbox.rules_then_escalate')).toContain(`„${t('inbox.zone_needs_you')}“`);
		setLocale('en');
		expect(t('inbox.rules_then_escalate')).toContain(`“${t('inbox.zone_needs_you')}”`);
	});
});
