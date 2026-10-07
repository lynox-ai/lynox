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
function earlierAttempt(data: RunNoticeInput, t: Translate): string {
  if (data.idempotent === true) return ` ${t('workflow_library.run_replayed')}`;
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
  const earlier = earlierAttempt(data, t);

  if (data.status === 'completed') {
    // Non-fatal step errors (on_failure 'continue'/'notify') are a caveat on a success,
    // not a failure — they belong in the green banner.
    const cost = typeof data.costUsd === 'number' && data.costUsd > 0 ? ` (${money(data.costUsd)})` : '';
    return {
      kind: 'notice',
      text: `${t('workflow_library.run_done')}${earlier}${cost}${stepDetail ? ` — ${stepDetail}` : ''}`,
    };
  }

  // ⚠ The failed branch prints NO cost, which is why no marker here may promise a number.
  const detail = stepDetail || (data.error ?? '');
  const head = `${t('workflow_library.run_failed')}${earlier}`;
  return { kind: 'error', text: detail ? `${head} — ${detail}` : head };
}
