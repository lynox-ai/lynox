import type { ToolEntry, IAgent } from '../../types/index.js';
import { BULK_HALT_REASONS, BulkPreviewCapError, bulkFoundAsPlannedNote, type BulkLedger, type BulkRunStatus, type BulkTargetSystem, type PlannedTarget } from '../../core/bulk-ledger.js';
import { BULK_WRITE_METHODS, canonicalHost, mintBulkContract, planExternal } from '../../core/bulk-external.js';
import { isShopifyListForm, listReadContract, parseListSource } from '../../core/bulk-list.js';
import { shopifyBulkReadEnabled } from '../../core/bulk-shopify.js';
import { detectSecretInContent } from './http.js';
import {
  BULK_MAX_SOURCE_BYTES, BULK_MAX_TARGET_BYTES, BULK_MAX_TARGETS, BULK_QUERY_PAGE, BulkSourceError,
  bulkFileKey, parseSourceText, planDataStore, planWorkspace, readBulkKey, rowsToSource,
  dataStoreColumns,
} from '../../core/bulk-plan.js';
import { judgeFields, judgeTemplate, judgedTargets, normalizeJudgeRule, type JudgeRule } from '../../core/bulk-judge-rule.js';
import { SHOPIFY_ALT_MAX_CHARS, SHOPIFY_MEDIA_WRITABLE_FIELDS, SHOPIFY_WRITABLE_FIELDS, isShopifyStoreHostName } from '../../core/shopify-graphql.js';
import { chatThreadOf } from './private-thread.js';

/**
 * The model-facing half of a bulk run's dry run (PRD bulk-changes-reversible §3.2,
 * §3.8). `bulk_plan` reads targets and their before-images into the ledger — for an
 * external target system it records the plan and leaves the reads to the engine's
 * preview effect; `bulk_status` reads counters back. Neither writes to a target, and neither returns
 * a target's key, value or diff: before-images are customer data, and a source file
 * may be externally authored — echoing its strings would put them into the model's
 * context. What the model gets is counts and a fixed vocabulary of reasons.
 */

interface BulkPlanInput {
  target_system: BulkTargetSystem | 'http';
  target_collection?: string | undefined;
  target_host?: string | undefined;
  write_method?: 'PATCH' | 'PUT' | 'POST' | undefined;
  source_file?: string | undefined;
  source_format?: 'json' | 'csv' | undefined;
  source_collection?: string | undefined;
  source_filter?: Record<string, unknown> | undefined;
  source_list?: unknown;
  atomic?: boolean | undefined;
  judge?: unknown;
}

interface BulkStatusInput {
  run_id?: string | undefined;
}

/** USD to the cent. Spend is rounded DOWN, so a run just under its limit never reads as
 *  having reached it; spend under a cent is "< $0.01", not "$0.00". */
function formatUsd(usd: number, round: 'down' | 'nearest' = 'nearest'): string {
  if (!Number.isFinite(usd) || usd < 0) return '(unknown)';
  if (usd > 0 && usd < 0.01) return '< $0.01';
  const cents = round === 'down' ? Math.floor(usd * 100 + 1e-9) : Math.round(usd * 100);
  return `$${(cents / 100).toFixed(2)}`;
}

function formatStatus(s: BulkRunStatus): string {
  const invalid = Object.entries(s.invalidReasons).map(([r, n]) => `${r} ${String(n)}`).join(', ');
  const lines = [
    `Bulk ${s.kind === 'undo' ? `undo run ${s.id} of run ${s.sourceRunId ?? '(deleted)'}` : `run ${s.id}`} ` +
      `(${s.targetSystem}${s.atomic ? ', atomic' : ''}, phase ${s.phase}, created ${s.createdAt}).`,
    `Targets: ${String(s.total)} — update ${String(s.changes.update)}, create ${String(s.changes.create)}, ` +
      `${s.changes.delete > 0 ? `delete ${String(s.changes.delete)}, ` : ''}` +
      `unchanged ${String(s.changes.unchanged)}, invalid ${String(s.changes.invalid)}${invalid ? ` (${invalid})` : ''}` +
      `${s.deselected > 0 ? `, taken out by the owner ${String(s.deselected)}` : ''}.`,
    `Undo class if applied: ${s.undo}.`,
  ];
  if ((s.invalidReasons.effect_field ?? 0) > 0) {
    lines.push('effect_field: the after-state sets a field whose value sets off an effect at the provider — ' +
      'an email to a customer, a payment, or a change of someone\'s access or data. A bulk run never writes ' +
      'such a field: leave it out, or make that change in the provider\'s own interface.');
  }
  if (s.judge !== null) {
    lines.push(`A model decides each target's new values with the run's rule: ` +
      `${String(judgedTargets(s))} judged, ${String(s.judge.unjudged)} target(s) without a verdict yet. The verdicts are only in the run's ledger, for the user to review.`);
  }
  // Model spend exists only on a run with a judge; every other run would print "$0" here.
  if (s.costUsd > 0 || s.costCapUsd !== null) {
    lines.push(`Model spend: ${formatUsd(s.costUsd, 'down')}${s.costCapUsd !== null ? ` of a ${formatUsd(s.costCapUsd)} limit` : ', no limit set'}.`);
  }
  if (s.writeMethod !== null) {
    lines.push(`Writes with ${s.writeMethod}.${s.probeConfirmed ? '' : ' It can be applied to one target first; more only after the user has checked that one.'}`);
  }
  if (s.list?.state === 'pending') {
    lines.push(`Targets come from a list on the host, not read to the end yet: ${String(s.list.pagesRead)} page(s) read — ` +
      'the number of targets is known only once the list is read.');
  } else if (s.phase === 'planned') {
    lines.push(`Reading targets: ${String(s.unread)} of ${String(s.total - s.changes.invalid)} not read yet — ` +
      'the counts above are final once the phase is previewed.');
  }
  if (s.applied > 0 || s.failed > 0 || s.conflicts > 0 || s.undone > 0) {
    lines.push(`Applied ${String(s.applied)}${bulkFoundAsPlannedNote(s.foundAsPlanned)}, failed ${String(s.failed)}, conflicts ${String(s.conflicts)}, undone ${String(s.undone)}.`);
  }
  if (s.sentUnknown > 0) {
    lines.push(`Unclear: ${String(s.sentUnknown)} ${s.sentUnknown === 1 ? 'target' : 'targets'} got a send without a clear answer; ` +
      'the change may have arrived, so the run does not send to them again. Only the provider can tell; a new plan reads them afresh.');
  }
  if (s.haltReason === BULK_HALT_REASONS.listed) {
    lines.push('The list is read. Its targets are read only once the user starts the run again, outside this chat.');
  } else if (s.haltReason) {
    lines.push(`Halted: ${s.haltReason}.`);
  }
  if (s.checksumBinding === 'unkeyed') {
    lines.push('Approval checksum: unkeyed — this instance has no vault key, so the checksum does not bind the approval to the run.');
  }
  return lines.join('\n');
}

/** All rows of a data-store query, paged at the store's own page size, stopping one
 *  past the target limit so an oversized source is reported rather than truncated, and
 *  held to the same byte cap as a source file — a collection has no size of its own
 *  that would bound what the plan reads into memory. */
function queryAllRows(agent: IAgent, collection: string, filter: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const store = agent.toolContext.dataStore;
  if (!store) throw new BulkSourceError('The data store is not available.');
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (let offset = 0; ; offset += BULK_QUERY_PAGE) {
    const page = store.queryRecords({ collection, filter, limit: BULK_QUERY_PAGE, offset });
    for (const r of page.rows) bytes += Buffer.byteLength(JSON.stringify(r), 'utf8');
    if (bytes > BULK_MAX_SOURCE_BYTES) {
      throw new BulkSourceError(`The source is larger than ${String(BULK_MAX_SOURCE_BYTES / 1024 / 1024)} MB.`);
    }
    rows.push(...page.rows);
    if (page.rows.length < BULK_QUERY_PAGE || rows.length > BULK_MAX_TARGETS || offset + BULK_QUERY_PAGE >= page.total) return rows;
  }
}

/**
 * The link domains a judged run's verdicts may add are the owner's, given at the start (PRD
 * shopify-preset §20.2 item 5, S20-4). A plan that names any is refused rather than left to be
 * ignored: an injected chat must not get a way to widen the domain rule, and a planner that
 * means well is told where the list goes. Any key with "domain" in its name, at the top, in the
 * list source or in the judge, so a near spelling is not a way past.
 */
function refusePlannerStartDomains(input: BulkPlanInput): void {
  const places: [string, unknown][] = [['', input], ['source_list.', input.source_list], ['judge.', input.judge]];
  for (const [prefix, value] of places) {
    if (value === null || typeof value !== 'object') continue;
    const key = Object.keys(value).find((k) => /domain/i.test(k));
    if (key !== undefined) {
      throw new BulkSourceError(`${prefix}${key} is not given here: the link domains a run may add are the user's, set when they start the run.`);
    }
  }
}

/** What a Shopify form takes, said with every refusal of a plan in that form: its checks stop at
 *  the first fault, and the schema does not describe the form, so a model would learn the rules
 *  one refusal at a time. */
const SHOPIFY_FORM_RULES: Record<string, string> = {
  shopify: `Form shopify plans the products of target_host (<store>.myshopify.com): no path, filters, id_field or write_method; source_list.after (or a judge's schema, without after) sets only ${SHOPIFY_WRITABLE_FIELDS.join(', ')}, each as text or null. For the images of the products, use form shopify_media.`,
  shopify_media: `Form shopify_media plans the images of the products of target_host (<store>.myshopify.com): no path, filters, id_field, write_method or judge; source_list.after sets only ${SHOPIFY_MEDIA_WRITABLE_FIELDS.join(', ')}, as text of at most ${String(SHOPIFY_ALT_MAX_CHARS)} characters or null. For product fields, use form shopify.`,
};

/** Record a run whose targets come from a list on the host (PRD bulk-loop §3.2): nothing
 *  is read here — the list is read once the user starts the run. A refused plan in a Shopify form
 *  gets that form's rules (`SHOPIFY_FORM_RULES`), unless the refusal is that the read is off. */
function planList(input: BulkPlanInput, agent: IAgent, ledger: BulkLedger, judgeInput: unknown): string {
  try {
    return planListChecked(input, agent, ledger, judgeInput);
  } catch (err) {
    const list = input.source_list;
    const form = typeof list === 'object' && list !== null ? (list as Record<string, unknown>)['form'] : undefined;
    if (!(err instanceof BulkSourceError) || !isShopifyListForm(form) || err.message === SHOPIFY_READ_OFF) throw err;
    throw new BulkSourceError(`${err.message} ${SHOPIFY_FORM_RULES[String(form)]!}`);
  }
}

/** A plan on a Shopify store's host that does not use a Shopify form: the refusal it got (a path
 *  that is not a woocommerce list, a source file that does not exist) says nothing about the store,
 *  and the schema does not describe the forms, so the hint names them. */
function shopifyHostHint(input: BulkPlanInput): string {
  if (input.target_system !== 'http' || input.target_host === undefined) return '';
  const host = canonicalHost(input.target_host);
  if (host === null || !isShopifyStoreHostName(host)) return '';
  const list = input.source_list;
  if (typeof list === 'object' && list !== null && isShopifyListForm((list as Record<string, unknown>)['form'])) return '';
  return ' target_host is a Shopify store: plan it with source_list and form shopify (product fields) or shopify_media (image alt texts).';
}

const SHOPIFY_READ_OFF = 'Reading a Shopify store in a bulk run is switched off on this instance.';

function planListChecked(input: BulkPlanInput, agent: IAgent, ledger: BulkLedger, judgeInput: unknown): string {
  if (input.target_system !== 'http') throw new BulkSourceError('source_list needs target_system "http".');
  // Said, not dropped: a planner who gave one expects it to narrow or shape the run.
  const unused = (['source_filter', 'source_format', 'target_collection'] as const).filter((k) => input[k] !== undefined && input[k] !== null);
  if (unused.length > 0) throw new BulkSourceError(`source_list does not take ${unused.join(', ')}: filter the list with source_list.filters.`);
  const host = input.target_host === undefined ? null : canonicalHost(input.target_host);
  if (host === null) throw new BulkSourceError('target_system "http" needs target_host: a plain host name such as api.example.com.');
  if (input.atomic === true) throw new BulkSourceError('target_system "http" cannot be atomic: an external host has no rollback.');
  let listInput = input.source_list;
  if (typeof listInput === 'object' && listInput !== null && isShopifyListForm((listInput as Record<string, unknown>)['form'])) {
    const form = String((listInput as Record<string, unknown>)['form']);
    // Checked when the run is planned and again on every tick of it (`bulk-preview.ts`).
    if (!shopifyBulkReadEnabled()) throw new BulkSourceError(SHOPIFY_READ_OFF);
    // A judge plans its fields F like an after-state: the Shopify parse below bounds them to the
    // writable fields. Only the product form takes one: an image run writes its alt text from
    // source_list.after until a judge is decided for it. A verb would name a write nothing grants.
    if (judgeInput !== undefined && form !== 'shopify') throw new BulkSourceError(`source_list.form ${form} does not take judge yet: give the fields to set in source_list.after.`);
    if (input.write_method !== undefined) throw new BulkSourceError(`source_list.form ${form} does not take write_method: the engine writes a store with its own form.`);
  }
  let judge: JudgeRule | undefined;
  if (judgeInput !== undefined) {
    const raw = typeof listInput === 'object' && listInput !== null ? listInput as Record<string, unknown> : {};
    if (raw['after'] !== undefined) throw new BulkSourceError('With judge, source_list takes no "after": the model decides each target\'s values.');
    const idField = typeof raw['id_field'] === 'string' ? raw['id_field'] : 'id';
    judge = normalizeJudgeRule(judgeInput, { idField });
    // A store takes its product fields as text: a verdict of another type would be judged and paid
    // for, then refused by the write document for the whole run. A field the store cannot be
    // written is left to the Shopify parse below, which names the fields that can.
    if (isShopifyListForm(raw['form'])) {
      const rule = judge;
      const notText = judgeFields(rule).find((f) => SHOPIFY_WRITABLE_FIELDS.includes(f) && rule.schema.properties[f]!.type !== 'string');
      if (notText !== undefined) throw new BulkSourceError(`judge.schema.${notText} must be type "string" for form shopify: the store takes its product fields as text.`);
    }
    // Every listed element is planned with the rule's template — its fields F, null — until its verdict.
    listInput = { ...raw, after: judgeTemplate(judge) };
  }
  const source = parseListSource(host, listInput, input.write_method ?? 'PATCH', detectSecretInContent);
  const out = ledger.recordExternalListPlan({
    createdBy: agent.currentThreadId, planningThread: chatThreadOf(agent), principal: agent.principal, host, source, readContract: listReadContract(host, source), judge,
  });
  if (!out.ok) {
    return 'Error: another external dry run is still reading its targets. Wait until bulk_status shows it previewed, then plan again.';
  }
  return [
    'List dry run recorded — nothing was sent, read or written. Nothing is read until the user starts it outside this chat.',
    formatStatus(out.status),
    ...(judge ? [JUDGE_NOTE] : []),
    'Once started, the engine reads the list page by page with the host\'s stored API credential and stops, so the user sees how many targets it holds. ' +
      'Each target is read only after the user starts the run a second time; bulk_status shows phase previewed when that is done. ' +
      'What the list and the targets hold is in the run\'s ledger for the user to review; it is not shown to you.',
  ].join('\n');
}

/** The column types a verdict field of each schema type is written into without loss
 *  (`coercePlainColumnValue`): text into a number or true/false column could not be read back. */
const JUDGE_COLUMN_TYPES: Record<string, readonly string[]> = {
  string: ['string', 'date', 'json'],
  number: ['number', 'string', 'json'],
  integer: ['number', 'string', 'json'],
  boolean: ['boolean', 'string', 'json'],
};

/** What a planner is told about a judged run. Counts and rules only — never a verdict. */
const JUDGE_NOTE = 'With judge, no model is called until the user starts the run outside this chat and sets a spend limit for it. ' +
  'Then a model decides each target\'s new values with your rule, one target at a time, without tools. ' +
  'The user reviews every verdict before anything is written.';

export const bulkPlanTool: ToolEntry<BulkPlanInput> = {
  // Writes only the ledger — but recording a run also drops the oldest unapproved
  // previews beyond the cap (a planner who is not the owner: only its own, else it is
  // refused), and nothing keeps what was dropped.
  undo: 'none',
  definition: {
    name: 'bulk_plan',
    description:
      'Dry-run a change to many targets at once: record, per target, its current state and the state the change would produce — without writing anything. ' +
      'Targets and new states come from a source you prepared: a JSON or CSV file in the workspace (rows with a "target" field and either an "after" field or the new column values), or a data-store collection holding such rows. ' +
      'target_system "workspace": each target is a file path, "after" its full new text. target_system "data_store": each target is a key value of target_collection\'s unique key, the other fields the new column values. ' +
      'target_system "http": each target is the https URL of one JSON resource on target_host, "after" a JSON object of the fields to set (text, number, true/false or null — no lists or nested objects); once the user starts it, the engine reads every target in the background with the host\'s stored API credential, so the counts are final only once bulk_status shows phase previewed. Only one external dry run reads at a time. ' +
      'Or, for target_system "http", source_list: a list on target_host the engine reads itself, page by page — every element it lists gets the one "after" given, written with write_method to <path>/<id of the element>. ' +
      'The list is read only after the user starts the run, with the host\'s stored API credential; what it holds is never shown to you. ' +
      'Elements can be missed when the list changes while it is read, and the number of targets is known only once it is read. ' +
      'You get back counts only. The user reviews the per-target before/after and approves the run outside this chat — you cannot apply it, and there is no screen or button for it you could point them to. ' +
      'atomic: true when the targets only make sense together — the run is then written whole or rolled back, and can only be undone whole. ' +
      'judge: instead of giving each target\'s new values, give a rule and the fields it decides; a model then decides the values per target, after the user started the run with a spend limit. ' +
      'With judge, only each source row\'s target is read (no "after"), and target_system must be "data_store" or "http".',
    input_schema: {
      type: 'object' as const,
      properties: {
        target_system: { type: 'string', enum: ['workspace', 'data_store', 'http'], description: 'What the targets are: workspace files, rows of one data-store collection, or JSON resources on one web API host.' },
        target_host: { type: 'string', description: 'For target_system "http": the API host name, e.g. api.example.com — every target URL must be on it.' },
        write_method: { type: 'string', enum: ['PATCH', 'PUT', 'POST'], description: 'For target_system "http": the verb the API edits an existing resource with at its own URL. Default PATCH. Some APIs edit with PUT, or with POST to the resource URL — use what the API documents for an edit, never a create endpoint.' },
        target_collection: { type: 'string', description: 'For target_system "data_store": the collection whose rows change. It needs a single-column unique key.' },
        source_file: { type: 'string', description: 'Workspace path of the JSON or CSV source. Give exactly one of source_file, source_collection or source_list.' },
        source_format: { type: 'string', enum: ['json', 'csv'], description: 'Format of source_file. Default: csv for a .csv path, json otherwise.' },
        source_collection: { type: 'string', description: 'Data-store collection holding the source rows. Give exactly one of source_file, source_collection or source_list.' },
        source_filter: { type: 'object', description: 'Optional filter for source_collection, same syntax as data_store_query.' },
        source_list: {
          type: 'object',
          description: 'For target_system "http": a list on target_host to take the targets from, instead of source_file or source_collection.',
          // A Shopify form's rules are not described here: in the schema they pushed a model off a
          // keyword lookup in a chat opened from a read-only one. A plan that breaks one gets them all
          // with its refusal (`SHOPIFY_FORM_RULES`), since the checks name only the first they meet.
          properties: {
            form: { type: 'string', enum: ['woocommerce', 'shopify', 'shopify_media'], description: 'The API\'s list form. Default woocommerce. shopify: the products of the store at target_host (<store>.myshopify.com); shopify_media: the images of its products.' },
            path: { type: 'string', description: 'The list\'s path, e.g. /wp-json/wc/v3/products. Not for the Shopify forms.' },
            filters: { type: 'object', description: 'Filter name → value, names of the form only (woocommerce: category, tag, status, sku, type, stock_status); values are 1–64 letters, digits, - or _.' },
            id_field: { type: 'string', description: 'The top-level field of an element holding its id. Default id.' },
            after: { type: 'object', description: 'The fields to set on every listed element (text, number, true/false or null); not the id field. Not with judge.' },
          },
          // Not required: a run with judge takes no after (`planList` refuses one), and a schema that
          // demanded it sent every judged list plan into that refusal.
        },
        atomic: { type: 'boolean', description: 'Write all targets or none (default false: targets are independent).' },
        judge: {
          type: 'object',
          description: 'A rule a model applies to each target instead of a given "after".',
          properties: {
            rule: { type: 'string', description: 'What to decide for each target, in plain words (up to 4000 characters).' },
            schema: { type: 'object', description: 'The fields the model sets, field name → {type: "string", maxLength} or {type: "string", enum: [...]} or {type: "number"|"integer"} or {type: "boolean"}. No pattern, no lists or nested objects; at most 20 fields.' },
            tier: { type: 'string', enum: ['fast', 'balanced', 'deep'], description: 'Which tier places the call (its provider, its limit). The model that judges is set per provider, not by the tier. Default fast.' },
          },
          required: ['rule', 'schema'],
        },
      },
      required: ['target_system'],
    },
  },
  handler: async (input: BulkPlanInput, agent: IAgent): Promise<string> => {
    const ledger = agent.toolContext.bulkLedger;
    if (!ledger) return 'Bulk runs are not available on this instance.';
    try {
      refusePlannerStartDomains(input);
      const sources = [input.source_file, input.source_collection, input.source_list].filter((v) => v !== undefined).length;
      if (sources !== 1) throw new BulkSourceError('Give exactly one of source_file, source_collection or source_list.');
      if (input.source_list !== undefined) return planList(input, agent, ledger, input.judge);
      if (input.judge !== undefined && input.target_system === 'workspace') {
        // A workspace target is text, not fields: a verdict over F has nothing to replace in it.
        throw new BulkSourceError('judge needs target_system "data_store" or "http": a workspace file has no fields to decide.');
      }
      if (input.judge !== undefined && input.atomic === true) throw new BulkSourceError('A run with judge cannot be atomic.');
      let rows: Record<string, unknown>[];
      if (input.source_file !== undefined) {
        const path = bulkFileKey(input.source_file);
        if (path === null) throw new BulkSourceError('The source file must be inside the workspace.');
        let image: ReturnType<typeof readBulkKey>;
        try {
          image = readBulkKey(path, BULK_MAX_SOURCE_BYTES);
        } catch {
          throw new BulkSourceError('The source file is not a readable file.');
        }
        if (image === 'too_large') throw new BulkSourceError(`The source file is larger than ${String(BULK_MAX_SOURCE_BYTES / 1024 / 1024)} MB.`);
        if (image === 'not_text') throw new BulkSourceError('The source file is not UTF-8 text.');
        if (image.absent) throw new BulkSourceError('The source file does not exist.');
        const format = input.source_format ?? (path.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
        rows = parseSourceText(image.value, format);
      } else {
        rows = queryAllRows(agent, input.source_collection!, input.source_filter);
      }
      // With a judge, a row names only its target: the model decides the values.
      const source = input.judge === undefined ? rowsToSource(rows) : rowsToSource(rows).map((r) => ({ target: r.target, after: {} }));

      let targets: PlannedTarget[];
      let scope: string;
      let judge: JudgeRule | undefined;
      if (input.target_system === 'workspace') {
        targets = planWorkspace(source, {
          resolve: bulkFileKey,
          read: (p) => readBulkKey(p, BULK_MAX_TARGET_BYTES),
        });
        scope = 'workspace';
      } else if (input.target_system === 'data_store') {
        const store = agent.toolContext.dataStore;
        if (!store) throw new BulkSourceError('The data store is not available.');
        if (!input.target_collection) throw new BulkSourceError('target_system "data_store" needs target_collection.');
        if (input.judge !== undefined) {
          const { keyCol, colDefs } = dataStoreColumns(store, input.target_collection);
          judge = normalizeJudgeRule(input.judge, { idField: keyCol });
          for (const f of Object.keys(judge.schema.properties)) {
            const col = colDefs.get(f);
            if (!col) throw new BulkSourceError(`judge.schema names ${f}, which is not a column of the target collection.`);
            if (col.type === 'subject') throw new BulkSourceError(`judge.schema names ${f}, a subject column, which a run cannot set.`);
            // Refused here, before any call is paid: a verdict the column cannot take would make
            // every target invalid after its call.
            const fieldType = judge.schema.properties[f]!.type;
            if (!(JUDGE_COLUMN_TYPES[fieldType] ?? []).includes(col.type)) {
              throw new BulkSourceError(`judge.schema gives ${f} the type ${fieldType}, which its ${col.type} column does not take.`);
            }
          }
          const template = judgeTemplate(judge);
          // A verdict replaces F on an existing row; a row that is not there has nothing to judge.
          targets = planDataStore(source, store, input.target_collection).map((t): PlannedTarget =>
            'invalid' in t ? t : t.before.absent ? { key: t.key, invalid: 'not_found' } : { key: t.key, before: t.before, after: template });
        } else {
          targets = planDataStore(source, store, input.target_collection);
        }
        scope = `data_store:${input.target_collection}`;
      } else if (input.target_system === 'http') {
        const host = input.target_host === undefined ? null : canonicalHost(input.target_host);
        if (host === null) throw new BulkSourceError('target_system "http" needs target_host: a plain host name such as api.example.com.');
        // An external host has no transaction to roll back into (PRD §3.4).
        if (input.atomic === true) throw new BulkSourceError('target_system "http" cannot be atomic: an external host has no rollback.');
        if (input.judge !== undefined) judge = normalizeJudgeRule(input.judge);
        const template = judge ? judgeTemplate(judge) : null;
        const external = planExternal(template ? source.map((r) => ({ target: r.target, after: template })) : source, host, detectSecretInContent);
        const keys = external.filter((t) => !('invalid' in t)).map((t) => t.key);
        const method = input.write_method ?? 'PATCH';
        if (!(BULK_WRITE_METHODS as readonly string[]).includes(method)) throw new BulkSourceError('write_method must be PATCH, PUT or POST.');
        const out = ledger.recordExternalPlan({
          createdBy: agent.currentThreadId, planningThread: chatThreadOf(agent), principal: agent.principal, host, targets: external, contract: mintBulkContract(host, keys, method), judge,
        });
        if (!out.ok) {
          return 'Error: another external dry run is still reading its targets. Wait until bulk_status shows it previewed, then plan again.';
        }
        return [
          out.status.phase === 'planned'
            ? 'External dry run recorded — nothing was sent or written. Nothing is read either until the user starts it outside this chat.'
            : 'Dry run recorded — nothing was written, and no target was valid, so there is nothing to read.',
          formatStatus(out.status),
          ...(judge ? [JUDGE_NOTE] : []),
          'Once the user has started it, the engine reads each target in the background and bulk_status shows phase previewed when it is done. ' +
            'The before- and after-state of each target is then in the run\'s ledger for the user to review; it is not shown to you. ' +
            'Only the user can start and approve it, outside this chat.',
        ].join('\n');
      } else {
        throw new BulkSourceError('target_system must be "workspace", "data_store" or "http".');
      }

      const status = ledger.recordDryRun({
        createdBy: agent.currentThreadId, planningThread: chatThreadOf(agent), principal: agent.principal, targetSystem: input.target_system, scope, targets,
        targetCollection: input.target_system === 'data_store' ? input.target_collection ?? null : null,
        atomic: input.atomic === true,
        judge,
      });
      return [
        'Dry run recorded — nothing was written to any target.',
        formatStatus(status),
        ...(judge ? [JUDGE_NOTE] : []),
        'The before- and after-state of each target is in the run\'s ledger for the user to review; it is not shown to you. ' +
          'Only the user can approve and apply it, outside this chat; bulk_status shows how far it got.',
      ].join('\n');
    } catch (err: unknown) {
      if (err instanceof BulkSourceError) return `Error: ${err.message}${shopifyHostHint(input)}`;
      // The cap refuses a planner who is not the owner; its text is ux's and names no run.
      if (err instanceof BulkPreviewCapError) return `Error: ${err.message}`;
      // Data-store errors name the collection or filter column the caller passed —
      // the caller's own strings, not a target's content.
      return `Error: the dry run failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const bulkStatusTool: ToolEntry<BulkStatusInput> = {
  definition: {
    name: 'bulk_status',
    description: 'Show the phase and counts of a bulk run recorded by bulk_plan, or of the most recent runs when no run_id is given. Counts only — never target contents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The bulk run id. Omit to list the most recent runs.' },
      },
    },
  },
  handler: async (input: BulkStatusInput, agent: IAgent): Promise<string> => {
    const ledger = agent.toolContext.bulkLedger;
    if (!ledger) return 'Bulk runs are not available on this instance.';
    if (input.run_id !== undefined) {
      const s = ledger.getStatus(input.run_id);
      return s ? formatStatus(s) : 'No bulk run with that id.';
    }
    const runs = ledger.listRuns(10);
    return runs.length === 0 ? 'No bulk runs recorded.' : runs.map(formatStatus).join('\n\n');
  },
};
