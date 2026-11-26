/**
 * Why the instance's network policy keeps a watch from its page, as a kind (`watchPolicyRefusal`
 * in task-manager.ts reads it from the host check's refusal). The poll records it as a sentence in
 * the instance language (`worker-notices.ts`, `watchPolicyRefused`); the tool that creates a watch
 * tells the model the English words. The setting names (`network_policy`, `enforce_https`) stay as
 * the operator writes them, in both languages.
 */
export type WatchPolicyReason =
  | { kind: 'protocol' }
  | { kind: 'deny_all' }
  | { kind: 'allow_list'; host: string }
  | { kind: 'https' }
  /** A refusal no setting names as it is (an unknown policy, a private address): the host check's own words, in English. */
  | { kind: 'other'; detail: string };

export interface WatchPolicyWords {
  /** Why, after "The watched page was not read:" / "not watched:", lower case, ending in a period. */
  why: string;
  /** What can be done, or '' when nothing the owner or the operator sets would help. */
  wayOut: string;
}

const ALSO_HTTPS_EN = 'The address must also be https://, since this instance only reads HTTPS pages (enforce_https).';
const ALSO_HTTPS_DE = 'Die Adresse muss ausserdem mit https:// beginnen, weil diese Instanz nur HTTPS-Seiten liest (enforce_https).';

/** `alsoHttps`: the address is http:// under enforce_https and its https:// form is refused too, for `reason`. */
export function watchPolicyWordsEn(reason: WatchPolicyReason, alsoHttps = false): WatchPolicyWords {
  const words = ((): WatchPolicyWords => {
    switch (reason.kind) {
      case 'protocol': return { why: 'it is not an http or https address.', wayOut: '' };
      case 'deny_all': return { why: 'this instance\'s network_policy is deny-all, so lynox reads no web page.', wayOut: 'Only the operator can change network_policy.' };
      case 'allow_list': return { why: `its host ${reason.host} is not in this instance's network allow-list.`, wayOut: 'The operator can add the host to the allow-list (network_policy).' };
      case 'https': return { why: 'this instance only reads HTTPS pages (enforce_https).', wayOut: 'Watch the https:// address instead.' };
      case 'other': return { why: `this instance's network settings refuse it: ${/[.!?]$/.test(reason.detail) ? reason.detail : `${reason.detail}.`}`, wayOut: '' };
    }
  })();
  return alsoHttps ? { why: words.why, wayOut: `${words.wayOut} ${ALSO_HTTPS_EN}` } : words;
}

/**
 * The same in German. An `other` refusal is told without the host check's English words: they
 * name no setting the owner could change, and a German sentence does not carry an English one.
 */
export function watchPolicyWordsDe(reason: WatchPolicyReason, alsoHttps = false): WatchPolicyWords {
  const words = ((): WatchPolicyWords => {
    switch (reason.kind) {
      case 'protocol': return { why: 'sie ist keine http- oder https-Adresse.', wayOut: '' };
      case 'deny_all': return { why: 'die network_policy dieser Instanz ist deny-all, darum liest lynox keine Webseite.', wayOut: 'Nur der Betreiber kann network_policy ändern.' };
      case 'allow_list': return { why: `ihr Host ${reason.host} steht nicht in der Netzwerk-Allow-List dieser Instanz.`, wayOut: 'Der Betreiber kann den Host in die Allow-List aufnehmen (network_policy).' };
      case 'https': return { why: 'diese Instanz liest nur HTTPS-Seiten (enforce_https).', wayOut: 'Beobachte stattdessen die https://-Adresse.' };
      case 'other': return { why: 'die Netzwerkeinstellungen dieser Instanz lassen die Seite nicht zu.', wayOut: '' };
    }
  })();
  return alsoHttps ? { why: words.why, wayOut: `${words.wayOut} ${ALSO_HTTPS_DE}` } : words;
}
