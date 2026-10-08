/**
 * The sentence a finished workflow run shows its owner.
 *
 * ⚠ WHY THIS IS A MODULE AND NOT FOUR TEMPLATE LITERALS IN THE VIEW. The composition went
 * wrong twice in two days, both times in a way no test could see, because a Svelte
 * component cannot be imported in vitest here and the only instrument was a regex over its
 * source text:
 *  · the restart marker ended in a colon and omitted its amount when the earlier attempt
 *    had cost nothing — and this run's own cost was concatenated right after, so the
 *    notice read "the earlier run already cost: ($0.1200)" about a run that cost zero. A
 *    false statement about money, which is the one direction the run claim exists to
 *    protect.
 *  · the replay marker promised "the cost below", and the failed branch prints no cost at
 *    all, so the promise referred to nothing. The wording it replaced had been correct.
 * Both are statements, and a statement belongs where it can be read back. The function is
 * pure and takes its translator, so every shape it can produce is drivable.
 *
 * It composes, it does not decide: whether the run succeeded is the caller's branch, and
 * the two markers are facts the server sent.
 */
export type RunNoticeInput = {
  status?: string | undefined;
  costUsd?: number | undefined;
  error?: string | undefined;
  /** The server replayed an earlier run under this key instead of running again. */
  idempotent?: boolean | undefined;
  /** Set when this run REPLACED an earlier attempt under the same key. */
  restartedFrom?: string | undefined;
  /** What that earlier attempt had already cost — possibly 0 for a run that failed early. */
  previousCostUsd?: number | undefined;
  stepErrors?: Array<{ stepId: string; error?: string | undefined; costUsd: number }> | undefined;
};

/**
 * The caller's translator. Takes `vars` because one of these strings carries a `{cost}`
 * slot, and the house has `tf` for exactly that — a naive `t(key).replace('{x}', v)` is
 * documented in `i18n.svelte.ts` as a hazard, since a value containing a `$`-substitution
 * pattern is interpreted by `String.replace`. The first version of this module used the
 * hazardous form; an amount is the one value that cannot be allowed to rewrite its own
 * sentence.
 */
export type Translate = (key: string, vars?: Record<string, string>) => string;

const money = (n: number): string => `$${n.toFixed(4)}`;

/**
 * What happened to an earlier attempt under the same key, as a parenthetical.
 *
 * Empty when there was none. Each form is a COMPLETE sentence fragment carrying its own
 * label, so nothing that follows it can be mistaken for part of it.
 */
function earlierAttempt(data: RunNoticeInput, t: Translate, printsCost: boolean): string {
  // ⚠ The replay has TWO wordings and the branch decides, which is the repair for a round
  // trip this file already made: the first version promised "the cost below is that run's"
  // everywhere, and the failed branch prints no cost, so the promise pointed at nothing.
  // The second version dropped the promise everywhere — and in the completed branch it had
  // been true and load-bearing: it is the sentence that keeps a replayed `($0.2500)` from
  // reading as a fresh charge. So the caveat is made conditional instead of removed.
  if (data.idempotent === true) {
    return ` ${t(printsCost ? 'workflow_library.run_replayed_cost' : 'workflow_library.run_replayed')}`;
  }
  if (data.restartedFrom === undefined) return '';
  return typeof data.previousCostUsd === 'number' && data.previousCostUsd > 0
    ? ` ${t('workflow_library.run_restarted_cost', { cost: money(data.previousCostUsd) })}`
    : ` ${t('workflow_library.run_restarted_free')}`;
}

export type RunNotice =
  /** A green banner. */
  | { kind: 'notice'; text: string }
  /** A red one. */
  | { kind: 'error'; text: string };

export function composeRunNotice(data: RunNoticeInput, t: Translate): RunNotice {
  const failedSteps = (data.stepErrors ?? []).filter(s => s.error !== undefined && s.error !== '');
  const stepDetail = failedSteps.map(s => `${s.stepId}: ${s.error}`).join('; ');

  if (data.status === 'completed') {
    // Non-fatal step errors (on_failure 'continue'/'notify') are a caveat on a success,
    // not a failure — they belong in the green banner.
    const cost = typeof data.costUsd === 'number' && data.costUsd > 0 ? ` (${money(data.costUsd)})` : '';
    const earlier = earlierAttempt(data, t, cost !== '');
    return {
      kind: 'notice',
      text: `${t('workflow_library.run_done')}${earlier}${cost}${stepDetail ? ` — ${stepDetail}` : ''}`,
    };
  }

  // ⚠ The failed branch prints NO cost, which is why no marker here may promise a number.
  const detail = stepDetail || (data.error ?? '');
  const head = `${t('workflow_library.run_failed')}${earlierAttempt(data, t, false)}`;
  return { kind: 'error', text: detail ? `${head} — ${detail}` : head };
}

/**
 * Which sentence a 409 shows its owner, and in which banner.
 *
 * ⚠ WHY THIS IS A FUNCTION. In the view this was an `if/else if` chain, and the witnesses
 * for it were regexes over the component's source — because a Svelte component cannot be
 * imported in vitest here. A refuter then changed ONE line: it prepended
 * `run_outcome_unknown` to the chain's first condition, which left the asserted suffix
 * intact, and 46 of 46 tests stayed green while the headline defect of that very commit
 * came back — that code rendered "already running" and its own sentence became dead code.
 *
 * A regex over text cannot see reachability. A mapping can be driven. Same reason
 * `attemptIsOver` was extracted, one defect later.
 *
 * `notice` is the green banner, `error` the red one. Exactly one is ever filled, which is
 * a property of the return type rather than of two assignments the next edit can separate.
 */
export type RefusalBanner = { kind: 'notice' | 'error'; key: string };

export function refusalBanner(code: string | undefined): RefusalBanner {
  switch (code) {
    // The attempt is ALIVE: its run is starting or still going. Not a failure, so the
    // green banner — and the key survives, which `attemptIsOver` decides separately.
    case 'run_claim_in_flight':
    case 'run_in_progress':
      return { kind: 'notice', key: 'workflow_library.run_already_running' };
    // Spent, outcome never recorded: it may still be running. Its own sentence says so and
    // points at the run history; the view asks before releasing the key.
    case 'run_outcome_unknown':
      return { kind: 'error', key: 'workflow_library.run_outcome_unknown' };
    // Spent and over in a status the route does not act on.
    case 'run_claim_held':
      return { kind: 'error', key: 'workflow_library.run_claim_held' };
    // A code this build does not know, or one a proxy mangled. Says only what a 409
    // guarantees — the server refused this start — and asserts nothing about an earlier
    // run, which the previous fallback did without warrant.
    default:
      return { kind: 'error', key: 'workflow_library.run_refused' };
  }
}
