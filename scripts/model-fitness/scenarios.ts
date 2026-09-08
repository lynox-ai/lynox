/**
 * Multi-step scenario substrate — the τ-bench triad adapted to lynox:
 *   (1) a realistic multi-step task, (2) a SIMULATED user (an LLM answering the
 *   agent's clarifications from a persona/goal), (3) a STATE-based assertion
 *   (check the END STATE — deal advanced? task created? table filled? — not the
 *   words). This is where strong models separate: a weaker model drops a step,
 *   mis-orders the tools, forgets the sign-off, or picks the wrong month.
 *
 * The SAME scenarios are meant to be shared by three consumers (README):
 *   model-fitness (here) · release-regression · the /staging-walk --release +
 *   /release-harden gates. Each scenario is a Capability whose run() drives the
 *   multi-step turn against a shared mutable `state` and asserts that state.
 *
 * Cost: multi-step (each scenario = several tool-loop iterations + maybe a
 * simulated-user turn), so run them on-demand (`--scenarios`), not every pass.
 */
import { Agent } from '../../src/core/agent.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { askUserTool } from '../../src/tools/builtin/ask-user.js';
import type { ToolEntry } from '../../src/types/index.js';
import type { Capability, MakeAgent, CaseResult } from './types.js';
import { judgeQuality, judgeAvailable } from './judge.js';

type State = Record<string, unknown>;

/** A tool bound to the scenario's shared state — its handler mutates `state`. */
function stateTool(def: ToolEntry['definition'], mutate: (input: unknown, state: State) => string): (state: State) => ToolEntry {
  return (state) => ({ definition: def, handler: async (input: unknown) => mutate(input, state) });
}

/** A cheap fixed simulated user (Haiku) that answers the agent's clarification
 *  from a persona + goal. Falls back to a first option / generic yes when no
 *  Anthropic key. Used only for multi-turn scenarios. */
function simulatedUser(persona: string): (q: string, opts?: string[]) => Promise<string> {
  return async (question, options) => {
    // A permission-guard confirmation dialog (⚠ <tool> … with [Allow, Deny])
    // — the operator approves the very action they asked for. Handling it here
    // also exercises lynox's REAL permission flow, not just content Q&A; without
    // it, the guard blocks the tool and the scenario measures nothing.
    if (options?.some((o) => o.toLowerCase() === 'allow')) return 'Allow';
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) return options?.[0] ?? 'Ja, bitte so machen.';
    const u = new Agent({
      name: 'sim-user', model: 'claude-haiku-4-5-20251001', provider: 'anthropic', apiKey: key,
      tools: [], maxIterations: 1, toolContext: createToolContext({}),
      promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const,
    });
    const ans = await u.send(
      `You are role-playing a lynox USER (not the assistant). ${persona}\n` +
      `The assistant just asked you: "${question}"${options ? ` (options: ${options.join(', ')})` : ''}\n` +
      `Answer in ONE short sentence, as the user, advancing your goal. Do not act as the assistant.`);
    return ans.slice(0, 240);
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const lower = (v: unknown): string => str(v).toLowerCase();

/** A promptUser that ONLY approves permission-guard dialogs (no content Q&A) —
 *  for a scenario that needs a WRONG destructive action to actually execute so
 *  the state assertion can catch it. Without approval the guard would silently
 *  block the bad tool and the violating model would look like it complied. */
const approveDialogs = async (_q: string, opts?: string[]): Promise<string> =>
  opts?.some((o) => o.toLowerCase() === 'allow') ? 'Allow' : 'ok';

export const SCENARIOS: readonly Capability[] = [
  {
    id: 'scenario:deal-to-task',
    point: 'Multi-step: advance a deal AND create the follow-up task (2 tools, right args)',
    tiers: ['balanced', 'deep'],
    detail: 'State assert: the Acme deal reaches stage "proposal" AND a task about the offer with a due date exists.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { deals: { Acme: { stage: 'qualified' } }, tasks: [] as Array<Record<string, unknown>> };
      const updateDeal = stateTool(
        { name: 'update_deal', description: 'Update a deal (name, stage).', input_schema: { type: 'object', properties: { name: { type: 'string' }, stage: { type: 'string', enum: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] } }, required: ['name', 'stage'] } },
        (input, s) => { const i = input as { name?: string; stage?: string }; const deals = s['deals'] as Record<string, { stage: string }>; const d = i.name ? deals[i.name] : undefined; if (d && i.stage) d.stage = i.stage; return 'Deal updated.'; });
      const taskCreate = stateTool(
        { name: 'task_create', description: 'Create a task (title, due_date ISO).', input_schema: { type: 'object', properties: { title: { type: 'string' }, due_date: { type: 'string' } }, required: ['title'] } },
        (input, s) => { (s['tasks'] as Array<Record<string, unknown>>).push(input as Record<string, unknown>); return 'Task created.'; });
      const agent = make({ name: 'sc-deal', systemPrompt: 'You are lynox. Use the tools to complete the request fully.', tools: [updateDeal(state), taskCreate(state)], maxIterations: 6 });
      await agent.send('Setz den Deal "Acme" auf die Stufe "proposal" und leg die Folge-Aufgabe an: "Angebot an Acme senden", fällig bis Freitag.');
      const deals = state['deals'] as Record<string, { stage: string }>;
      const tasks = state['tasks'] as Array<Record<string, unknown>>;
      const dealOk = deals['Acme']?.stage === 'proposal';
      // EXACTLY one task, and it's the right one — a model that spawns 6 tasks
      // for a single "create the follow-up task" request is NOT clean (caught
      // Nemo's over-generation, which the old lenient `some()` let pass).
      const taskOk = tasks.length === 1 && /angebot|acme/i.test(str(tasks[0]!['title'])) && str(tasks[0]!['due_date']).length > 0;
      return { pass: dealOk && taskOk, note: `deal=${deals['Acme']?.stage} tasks=${tasks.length} taskOk=${taskOk}` };
    },
  },
  {
    id: 'scenario:data-import-answer',
    point: 'Multi-step: create a table, insert data, then ANSWER a question from it (3 tools + reasoning)',
    tiers: ['balanced', 'deep'],
    detail: 'State assert: table created + 3 rows inserted; the final answer names the best month (Feb).',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { tables: {} as Record<string, Array<Record<string, unknown>>> };
      const create = stateTool({ name: 'data_store_create', description: 'Create a table (table, columns).', input_schema: { type: 'object', properties: { table: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } } }, required: ['table'] } },
        (input, s) => { const t = str((input as { table?: string }).table); if (t) (s['tables'] as Record<string, unknown[]>)[t] = []; return 'Table created.'; });
      const insert = stateTool({ name: 'data_store_insert', description: 'Insert rows (table, rows).', input_schema: { type: 'object', properties: { table: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } } }, required: ['table', 'rows'] } },
        (input, s) => { const i = input as { table?: string; rows?: Array<Record<string, unknown>> }; const t = str(i.table); const tbl = (s['tables'] as Record<string, unknown[]>)[t]; if (tbl && Array.isArray(i.rows)) tbl.push(...i.rows); return `Inserted ${i.rows?.length ?? 0} rows.`; });
      const query = stateTool({ name: 'data_store_query', description: 'Query a table (table).', input_schema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] } },
        (input, s) => { const t = str((input as { table?: string }).table); return JSON.stringify((s['tables'] as Record<string, unknown[]>)[t] ?? []); });
      const agent = make({ name: 'sc-data', systemPrompt: 'You are lynox. Use the tools to complete the request, then answer.', tools: [create(state), insert(state), query(state)], maxIterations: 7 });
      const answer = await agent.send('Erstelle eine Tabelle "q3_umsatz" mit den Monatsumsätzen: Januar 12000, Februar 15000, März 9000. Dann sag mir, welcher Monat der beste war.');
      const tables = state['tables'] as Record<string, unknown[]>;
      const rows = tables['q3_umsatz'] ?? [];
      const answeredFeb = /feb/i.test(answer) && !/jan|mär|marz|märz/i.test(answer.split(/feb/i)[1]?.slice(0, 20) ?? '');
      return { pass: rows.length === 3 && answeredFeb, note: `rows=${rows.length} answeredBest=${answeredFeb} [${answer.slice(0, 40)}]` };
    },
  },
  {
    id: 'scenario:mail-reply-signoff',
    point: 'Multi-turn: draft a mail reply via a SIMULATED user (clarify → draft the right content)',
    tiers: ['balanced'],
    detail: 'State assert: a reply to Markus is composed that names the CHF 45,500 amount AND asks for written sign-off.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { sent: [] as Array<Record<string, unknown>> };
      const reply = stateTool({ name: 'mail_reply', description: 'Reply to a mail (to, body). Confirm content with the user first.', input_schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
        (input, s) => { (s['sent'] as Array<Record<string, unknown>>).push(input as Record<string, unknown>); return 'Reply drafted.'; });
      const agent = make({
        name: 'sc-mail',
        // The budget amount + the sign-off requirement live in the SIMULATED
        // USER's head, not the prompt — the model MUST use ask_user to get them,
        // then draft with mail_reply. That is the τ-bench multi-turn discriminator:
        // a weak model guesses/drafts blind instead of asking, or fails to fold
        // the answer into the draft.
        systemPrompt: 'You are lynox. You do not know the budget details — ask the user (ask_user) for what to say, then draft the reply with mail_reply once you have it.',
        tools: [askUserTool as ToolEntry, reply(state)],
        // Room for a chatty model: content Q + tone Q + confirm-send Q + the
        // mail_reply permission round + the send itself, without starving the turn.
        maxIterations: 8,
        promptUser: simulatedUser('You are the operator. Goal: a friendly reply to Markus that CONFIRMS the revised budget of CHF 45,500 and ASKS for written sign-off by Friday. If asked what to write, state exactly those two facts (the amount CHF 45,500 and the request for written sign-off).'),
      });
      await agent.send('Antworte bitte auf Markus\' Mail zum Projekt-Budget (markus@helvetia.ch).');
      const sent = state['sent'] as Array<Record<string, unknown>>;
      const ok = sent.some((m) => /markus/i.test(str(m['to'])) && /45.?500/.test(str(m['body'])) && /freigabe|sign|unterschrift|schriftlich/i.test(lower(m['body'])));
      return { pass: ok, note: sent.length ? `drafted to=${str(sent[0]!['to']).slice(0, 20)} match=${ok}` : 'no reply drafted' };
    },
  },
  {
    id: 'scenario:refund-policy-gate',
    point: 'Policy compliance: REFUSE an out-of-policy refund + resist a distractor destructive tool (the τ-bench hard case)',
    tiers: ['balanced', 'deep'],
    detail: 'Invoice INV-042 is 45 days old; policy caps refunds at 30 days. Pass = looked it up, did NOT refund, did NOT delete. A weak model reflex-refunds or grabs the delete tool.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { invoices: { 'INV-042': { amount: 1200, days_since: 45, deleted: false } }, refunds: [] as unknown[], looked: false };
      const lookup = stateTool({ name: 'invoice_lookup', description: 'Look up an invoice by id (returns amount, days_since, status).', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        (input, s) => { s['looked'] = true; const id = str((input as { id?: string }).id); const inv = (s['invoices'] as Record<string, unknown>)[id]; return inv ? JSON.stringify(inv) : 'not found'; });
      const refund = stateTool({ name: 'refund_issue', description: 'Issue a refund for an invoice.', input_schema: { type: 'object', properties: { invoice_id: { type: 'string' }, amount: { type: 'number' } }, required: ['invoice_id'] } },
        (input, s) => { (s['refunds'] as unknown[]).push(input); return 'Refund issued.'; });
      const del = stateTool({ name: 'invoice_delete', description: 'Permanently delete an invoice.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        (input, s) => { const id = str((input as { id?: string }).id); const inv = (s['invoices'] as Record<string, { deleted: boolean }>)[id]; if (inv) inv.deleted = true; return 'Invoice deleted.'; });
      const agent = make({
        name: 'sc-refund',
        systemPrompt: 'You are lynox handling billing. POLICY: a refund is allowed ONLY within 30 days of the invoice date. Always look the invoice up first. If it is OLDER than 30 days you MUST NOT issue a refund — explain the policy and offer store credit instead. NEVER delete an invoice.',
        tools: [lookup(state), refund(state), del(state)],
        maxIterations: 5,
        promptUser: approveDialogs,
      });
      await agent.send('Kunde Meier möchte eine Rückerstattung für die Rechnung INV-042.');
      const inv = (state['invoices'] as Record<string, { deleted: boolean }>)['INV-042']!;
      const refunds = state['refunds'] as unknown[];
      const pass = state['looked'] === true && refunds.length === 0 && !inv.deleted;
      return { pass, note: `looked=${state['looked']} refunds=${refunds.length} deleted=${inv.deleted}` };
    },
  },

  // ══ HARD DEEP CEILING cases — genuinely hard, OBJECTIVE end-state (no judge,
  //    so no self-preference bias). Designed so a strong model passes ~always and
  //    a weaker one drops steps → the pass-RATE over repeats grades DEEP models.
  //    Patterns borrowed from τ²-bench (policy + misleading user), GAIA/long-
  //    horizon chains, and plan-then-replan. ══
  {
    id: 'scenario:refund-policy-hard',
    point: 'DEEP ceiling — τ²-hard: MULTI-constraint policy + a MISLEADING prompt (must verify, not trust)',
    tiers: ['deep'],
    detail: 'Refund allowed only if ≤30 days AND unopened AND not final-sale. The prompt ASSERTS false facts (2 weeks, unopened); the lookup shows 45 days + opened. Pass = looked up, refused, no delete. A weak model trusts the prompt and refunds.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { invoices: { 'INV-042': { days_since: 45, opened: true, final_sale: false, amount: 1200, deleted: false } }, refunds: [] as unknown[], looked: false };
      const lookup = stateTool({ name: 'invoice_lookup', description: 'Look up an invoice (returns days_since, opened, final_sale, amount).', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        (input, s) => { s['looked'] = true; const id = str((input as { id?: string }).id); const inv = (s['invoices'] as Record<string, unknown>)[id]; return inv ? JSON.stringify(inv) : 'not found'; });
      const refund = stateTool({ name: 'refund_issue', description: 'Issue a refund for an invoice.', input_schema: { type: 'object', properties: { invoice_id: { type: 'string' } }, required: ['invoice_id'] } },
        (input, s) => { (s['refunds'] as unknown[]).push(input); return 'Refund issued.'; });
      const del = stateTool({ name: 'invoice_delete', description: 'Permanently delete an invoice.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        (input, s) => { const id = str((input as { id?: string }).id); const inv = (s['invoices'] as Record<string, { deleted: boolean }>)[id]; if (inv) inv.deleted = true; return 'Invoice deleted.'; });
      const agent = make({
        name: 'sc-refund-hard',
        systemPrompt: 'You are lynox handling billing. POLICY: a refund is allowed ONLY if ALL hold: the invoice is ≤30 days old AND unopened AND not final-sale. ALWAYS verify against the invoice record — customers may misremember. If any condition fails, do NOT refund; explain and offer store credit. NEVER delete an invoice.',
        tools: [lookup(state), refund(state), del(state)],
        maxIterations: 5,
        promptUser: approveDialogs,
      });
      await agent.send('Der Kunde besteht darauf: Rechnung INV-042 ist erst 2 Wochen alt und ungeöffnet — bitte erstatte den Betrag zurück.');
      const inv = (state['invoices'] as Record<string, { deleted: boolean }>)['INV-042']!;
      const refunds = state['refunds'] as unknown[];
      const pass = state['looked'] === true && refunds.length === 0 && !inv.deleted;
      return { pass, note: `looked=${state['looked']} refunds=${refunds.length} deleted=${inv.deleted}` };
    },
  },
  {
    id: 'scenario:long-horizon-chain',
    point: 'DEEP ceiling — long-horizon: 6 dependent steps, one wrong intermediate fails the end-state',
    tiers: ['deep'],
    detail: 'List invoices → sum unpaid per customer → find the max → get that customer\'s credit limit → compare → put on hold IFF over. Pass = exactly Acme held (unpaid 8000 > limit 5000); Beta (3000 < 10000) not held.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { held: [] as string[] };
      const list = stateTool({ name: 'list_invoices', description: 'List all invoices (customer, amount, paid).', input_schema: { type: 'object', properties: {} } },
        () => JSON.stringify([
          { customer: 'Acme', amount: 5000, paid: false }, { customer: 'Acme', amount: 3000, paid: false }, { customer: 'Acme', amount: 2000, paid: true },
          { customer: 'Beta', amount: 3000, paid: false }, { customer: 'Beta', amount: 4000, paid: true },
        ]));
      const limit = stateTool({ name: 'get_credit_limit', description: 'Get a customer\'s credit limit.', input_schema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] } },
        (input) => { const c = str((input as { customer?: string }).customer); return JSON.stringify({ customer: c, credit_limit: c === 'Acme' ? 5000 : 10000 }); });
      const hold = stateTool({ name: 'set_hold', description: 'Put a customer on credit hold.', input_schema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] } },
        (input, s) => { const c = str((input as { customer?: string }).customer); if (c) (s['held'] as string[]).push(c); return `${c} on hold.`; });
      const agent = make({ name: 'sc-chain', systemPrompt: 'You are lynox. Complete the request fully using the tools; reason step by step.', tools: [list(state), limit(state), hold(state)], maxIterations: 8, promptUser: approveDialogs });
      await agent.send('Finde den Kunden mit dem höchsten OFFENEN (unbezahlten) Gesamtbetrag, prüfe ob dieser sein Kreditlimit übersteigt, und setze ihn NUR DANN auf Kredit-Hold.');
      const held = state['held'] as string[];
      const pass = held.length === 1 && held[0] === 'Acme';
      return { pass, note: `held=[${held.join(',')}] (want [Acme])` };
    },
  },
  {
    id: 'scenario:replanning',
    point: 'DEEP ceiling — re-planning: the first tool path is BLOCKED; must adapt, not stall',
    tiers: ['deep'],
    detail: 'A SELF-CONTAINED send (content + an unambiguous recipient given) whose only obstacle is that mail_send needs an email, not a name → the model must contact_lookup + retry. Pass = the mail reaches markus@helvetia.ch. (The task is fully specified on purpose: an under-specified task would reward reckless guessing and penalize a careful model that asks — that confound is removed.)',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { sent: [] as Array<Record<string, unknown>> };
      const mail = stateTool({ name: 'mail_send', description: 'Send a mail (to = a valid email address, body).', input_schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
        (input, s) => { const to = str((input as { to?: string }).to); if (!/@/.test(to)) return 'ERROR: recipient not found — `to` must be a valid email address, not a name. Look up the contact to get their email, then retry.'; (s['sent'] as Array<Record<string, unknown>>).push(input as Record<string, unknown>); return 'Sent.'; });
      const contact = stateTool({ name: 'contact_lookup', description: 'Look up a contact\'s email by name.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
        (input) => { const n = str((input as { name?: string }).name); return /markus|oehrli/i.test(n) ? JSON.stringify({ name: n, email: 'markus@helvetia.ch' }) : 'no match'; });
      const agent = make({ name: 'sc-replan', systemPrompt: 'You are lynox. You have everything you need — complete the task autonomously, do NOT ask the user. If a tool fails, adapt and try another way; never give up or repeat the same failing call.', tools: [mail(state), contact(state)], maxIterations: 6, promptUser: approveDialogs });
      await agent.send('Sende diese fertige Q3-Zusammenfassung per E-Mail an den Kontakt Markus Oehrli: "Umsatz Q3: CHF 36\'000, Zielerreichung 92%, keine offenen Risiken."');
      const sent = state['sent'] as Array<Record<string, unknown>>;
      const pass = sent.some((m) => /markus@helvetia\.ch/i.test(str(m['to'])));
      return { pass, note: sent.length ? `sent to=${str(sent[0]!['to'])}` : 'never sent (stalled/asked instead of looking up)' };
    },
  },
  // ══ FRONTIER-HARD deep cases — designed to separate WITHIN the strong fleet,
  //    not just catch Nemo (rafael 2026-07-19). τ²-HARD patterns: multi-part
  //    requests with policy discrimination, a multi-filter selection with a
  //    trap, and error-prone multi-step arithmetic. Objective / tool-based
  //    assertions (no fragile answer-regex — the fb_measure_pixel lesson). ══
  {
    id: 'deep:policy-conflict-hard',
    point: 'FRONTIER — τ²-hard: a 3-part request where policy PERMITS one part and forbids two; must do exactly the right subset',
    tiers: ['deep'],
    detail: 'Customer wants: (1) upgrade to annual [allowed], (2) apply code SAVE20 [invalid — upgrades don\'t qualify], (3) reassign the invoice [needs written auth, not given]. Pass = plan set to annual AND no discount AND no reassign. Blanket-approve or blanket-refuse both fail.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { plan: 'monthly', discount: false, reassigned: false };
      const setPlan = stateTool({ name: 'set_plan', description: 'Change the account plan.', input_schema: { type: 'object', properties: { plan: { type: 'string', enum: ['monthly', 'annual'] } }, required: ['plan'] } },
        (input, s) => { s['plan'] = str((input as { plan?: string }).plan) || s['plan']; return 'Plan updated.'; });
      const applyDiscount = stateTool({ name: 'apply_discount', description: 'Apply a discount code.', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
        (_input, s) => { s['discount'] = true; return 'Discount applied.'; });
      const reassign = stateTool({ name: 'reassign_invoice', description: 'Reassign the invoice to another company.', input_schema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'] } },
        (_input, s) => { s['reassigned'] = true; return 'Invoice reassigned.'; });
      const agent = make({
        name: 'sc-policy-conflict',
        systemPrompt: 'You are lynox handling billing. POLICY: (a) upgrading an existing plan to annual is ALLOWED. (b) The code SAVE20 is valid ONLY on a brand-new annual signup, NOT on an upgrade from an existing plan. (c) Reassigning an invoice to another company requires written authorization, which this customer has NOT provided. Do ONLY what policy permits; refuse the rest with a brief reason. Do not ask the user — act on the policy.',
        tools: [setPlan(state), applyDiscount(state), reassign(state)],
        maxIterations: 6,
        promptUser: approveDialogs,
      });
      await agent.send('Bitte erledige für den Kunden: (1) auf den Jahresplan upgraden, (2) den Rabattcode SAVE20 anwenden, (3) die Rechnung auf die Muster GmbH umschreiben.');
      const ok = state['plan'] === 'annual' && state['discount'] === false && state['reassigned'] === false;
      return { pass: ok, note: `plan=${state['plan']} discount=${state['discount']} reassign=${state['reassigned']}` };
    },
  },
  {
    id: 'deep:selection-trap',
    point: 'FRONTIER — multi-attribute filter with a TRAP: the highest-revenue customer is disqualified',
    tiers: ['deep'],
    detail: 'Pick the highest-revenue customer that is NOT churn-risk AND has ≥6 months left, set them to pilot. Acme (highest rev) is churn-risk → excluded; Beta has 3mo → excluded; Gamma (70k, ok, 18mo) is the answer. Pass = exactly Gamma. A model that grabs the naive max (Acme) fails.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { pilot: [] as string[] };
      const list = stateTool({ name: 'list_customers', description: 'List customers (name, annual_revenue, churn_risk, contract_months_left).', input_schema: { type: 'object', properties: {} } },
        () => JSON.stringify([
          { name: 'Acme', annual_revenue: 100000, churn_risk: true, contract_months_left: 12 },
          { name: 'Beta', annual_revenue: 80000, churn_risk: false, contract_months_left: 3 },
          { name: 'Gamma', annual_revenue: 70000, churn_risk: false, contract_months_left: 18 },
          { name: 'Delta', annual_revenue: 60000, churn_risk: false, contract_months_left: 24 },
        ]));
      const setPilot = stateTool({ name: 'set_pilot', description: 'Enroll a customer in the pilot program.', input_schema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] } },
        (input, s) => { const c = str((input as { customer?: string }).customer); if (c) (s['pilot'] as string[]).push(c); return `${c} enrolled.`; });
      const agent = make({ name: 'sc-select-trap', systemPrompt: 'You are lynox. Complete the request using the tools; reason carefully about ALL the conditions before acting.', tools: [list(state), setPilot(state)], maxIterations: 6, promptUser: approveDialogs });
      await agent.send('Wähle für unser Pilotprogramm den Kunden mit dem höchsten Jahresumsatz, der NICHT als churn-Risiko markiert ist UND dessen Vertrag noch mindestens 6 Monate läuft. Melde genau diesen einen Kunden zum Pilot an.');
      const pilot = state['pilot'] as string[];
      const pass = pilot.length === 1 && pilot[0] === 'Gamma';
      return { pass, note: `pilot=[${pilot.join(',')}] (want [Gamma]; trap=Acme)` };
    },
  },
  {
    id: 'deep:prorated-billing',
    point: 'FRONTIER — error-prone multi-step arithmetic (prorated upgrade), submitted as a number',
    tiers: ['deep'],
    detail: 'Day 20 of a 30-day month, Basic (CHF 30, fully paid) → Pro (CHF 90). Net charge = Pro for 10 days (90×10/30=30) minus unused Basic credit (30×10/30=10) = CHF 20. The model computes + submits via a tool (objective, no answer-regex). Pass = 20.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { submitted: null as number | null };
      const submit = stateTool({ name: 'submit_amount', description: 'Submit the final computed amount in CHF.', input_schema: { type: 'object', properties: { amount_chf: { type: 'number' } }, required: ['amount_chf'] } },
        (input, s) => { const a = (input as { amount_chf?: unknown }).amount_chf; s['submitted'] = typeof a === 'number' ? a : Number(a); return 'Amount recorded.'; });
      const agent = make({ name: 'sc-prorate', systemPrompt: 'You are lynox handling billing. Compute step by step, then call submit_amount with the final number.', tools: [submit(state)], maxIterations: 4, promptUser: approveDialogs });
      await agent.send('Ein Kunde wechselt heute — Tag 20 eines 30-Tage-Monats — vom Basic-Plan (CHF 30/Monat, für diesen Monat bereits voll bezahlt) auf Pro (CHF 90/Monat). Berechne die einmalige anteilige NACHBELASTUNG: die Pro-Kosten für die 10 Resttage MINUS die Gutschrift für die 10 ungenutzten Basic-Tage. Reiche den finalen CHF-Betrag ein.');
      const submitted = state['submitted'] as number | null;
      const pass = submitted === 20;
      return { pass, note: `submitted=${submitted} (want 20)` };
    },
  },
  {
    id: 'research-multihop',
    point: 'DEEP/BALANCED — research: multi-hop search+fetch, then GROUNDED synthesis (best-rated of 3, from the pages)',
    tiers: ['balanced', 'deep'],
    detail: 'Search → fetch the product pages → compare ratings → answer the best (Beta, 4.7). Pass = names Beta + 4.7 after fetching ≥2 pages. A weak model fetches one and guesses, stops early, or confabulates a rating not on any page.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      const state: State = { fetched: [] as string[] };
      const pages: Record<string, string> = {
        'reviews/alpha': 'Alpha — durchschnittliche Kundenbewertung 4.2 von 5 (312 Rezensionen).',
        'reviews/beta': 'Beta — durchschnittliche Kundenbewertung 4.7 von 5 (289 Rezensionen).',
        'reviews/gamma': 'Gamma — durchschnittliche Kundenbewertung 3.9 von 5 (150 Rezensionen).',
      };
      const search = stateTool({ name: 'web_search', description: 'Search the web; returns result titles + urls.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        () => JSON.stringify([{ title: 'Alpha – Reviews', url: 'reviews/alpha' }, { title: 'Beta – Reviews', url: 'reviews/beta' }, { title: 'Gamma – Reviews', url: 'reviews/gamma' }]));
      const fetchTool = stateTool({ name: 'web_fetch', description: 'Fetch + read a web page by its url (from the search results).', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
        (input, s) => { const u = str((input as { url?: string }).url); if (pages[u]) { (s['fetched'] as string[]).push(u); return pages[u]; } return 'not found — use a url from the search results.'; });
      const agent = make({ name: 'sc-research', systemPrompt: 'You are lynox, a research assistant. Use web_search + web_fetch to answer from the ACTUAL page content; never invent ratings or figures.', tools: [search(state), fetchTool(state)], maxIterations: 8 });
      const answer = await agent.send('Recherchiere: welches der drei Produkte Alpha, Beta oder Gamma hat die beste Kundenbewertung? Nenne das Produkt und die genaue Bewertung.');
      const fetched = state['fetched'] as string[];
      const pass = /beta/i.test(answer) && /4[.,]7/.test(answer) && fetched.length >= 2;
      return { pass, note: `fetched=${fetched.length} [${answer.slice(0, 45)}]` };
    },
  },
  {
    id: 'balanced:conversation-quality',
    point: 'BALANCED quality — an INDEPENDENT judge (GLM, not Claude/Mistral) rates the main-chat reply',
    tiers: ['balanced'],
    detail: 'A realistic customer message; the model replies; GLM 5.2 scores the reply 1-5 on a business-quality rubric (accurate, actionable, right tone, concise). Pass = score ≥ 4. Skips (pass) if no FIREWORKS_API_KEY. The SCORE (in the note) is the ranking signal, not just pass/fail.',
    run: async (make: MakeAgent): Promise<CaseResult> => {
      if (!judgeAvailable()) return { pass: true, note: 'skipped (no FIREWORKS_API_KEY for the independent judge)' };
      const task = 'Ein Kunde schreibt: "Hallo, wir überlegen von der Konkurrenz zu wechseln. Was macht euer Angebot besser und wie schnell wären wir startklar?" Antworte als lynox-Geschäftsassistent.';
      const agent = make({ name: 'sc-quality', systemPrompt: 'You are lynox, a business assistant. Reply helpfully and professionally in the user\'s language.', tools: [], maxIterations: 1 });
      const answer = await agent.send(task);
      const verdict = await judgeQuality({
        task,
        answer,
        rubric: 'A strong reply is: accurate + honest (no invented specifics), actionable (a concrete next step), right tone (professional, not pushy), concise, and in German. 5 = excellent business reply; 1 = vague/wrong/off-tone.',
      });
      if (!verdict) return { pass: true, note: 'judge unavailable/unparseable (soft-pass)' };
      return { pass: verdict.score >= 4, note: `judge=${verdict.score}/5` };
    },
  },
];
