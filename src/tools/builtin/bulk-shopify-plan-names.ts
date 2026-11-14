import { SHOPIFY_CONTEXT_FIELDS } from '../../core/bulk-judge-rule.js';

/**
 * A Shopify list plan as its form takes it. A planner often reads the store over its REST API
 * first (`products.json`) and then plans with that API's names and parts; the form refused each
 * one, with all its rules, and the planner tried again, once per name: a plan for an SEO text took
 * three calls on a real store, and in the planner eval almost every first call was refused, most
 * for `write_method` alone. What follows maps those names onto the form's and leaves out parts that
 * cannot change what a run reads or writes. The answer says each, so the planner learns the names.
 *
 * Left out, only what cannot narrow or shape the run: a verb that edits (PATCH, PUT; the form
 * writes with its own mutation), the id field `id`, the path of the store's whole product list,
 * filters given as `{}` (no filter), and an empty after. A POST, any other path (a
 * collection's products narrow the list) and any other id field are left to the form's refusal.
 * A REST field name in judge.schema or judge.context is read as the form's, only where the
 * form's own name is not given beside it (and in judge.context only where the form reads it).
 *
 * Never source_list.after: what it holds is written into every product, and a plan whose after
 * the form refuses (a REST name, an SEO text nested as the store's APIs write it) is the one the
 * refusal makes the planner look at again. Read as the form's, an after nested as
 * `seo: { title: "placeholder" }` was recorded with "placeholder" as every product's SEO title,
 * where the refusal had led planners to a judge for each product (planner eval, 2026-11-14).
 */

/** REST product field → the form's name for it. */
const REST_FIELD_NAMES: Readonly<Record<string, string>> = {
  body_html: 'descriptionHtml',
  product_type: 'productType',
  metafields_global_title_tag: 'seo_title',
  metafields_global_description_tag: 'seo_description',
};

/** The store's product list over REST, all of it: `/products.json` or `/admin/api/<version>/products.json`, with or without `.json`. */
const WHOLE_PRODUCT_LIST = /^(?:\/admin\/api\/[0-9a-z-]{1,20})?\/products(?:\.json)?$/;

export interface ShopifyPlanNames {
  /** The plan's `write_method`, `source_list` and judge as the form takes them. */
  writeMethod: string | undefined;
  list: Record<string, unknown>;
  judge: unknown;
  /** One clause per change, for the answer; empty when nothing was changed. */
  changes: string[];
}

/** judge.schema with its REST names read as the form's. A name whose form name the store cannot
 *  be written is renamed too: the form refuses it either way, with the fields it can write. */
function renamed(record: Record<string, unknown>, where: string, changes: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const name = REST_FIELD_NAMES[key];
    if (name !== undefined && !Object.hasOwn(record, name)) {
      out[name] = value;
      changes.push(`${where} ${key} as ${name}`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** `form` is `shopify` or `shopify_media`; the other arguments as the planner gave them. */
export function shopifyPlanNames(form: 'shopify' | 'shopify_media', writeMethod: unknown, list: Record<string, unknown>, judge: unknown): ShopifyPlanNames {
  const changes: string[] = [];
  let method = writeMethod as string | undefined;
  if (writeMethod === 'PATCH' || writeMethod === 'PUT') {
    method = undefined;
    changes.push(`write_method ${writeMethod} left out (the engine writes a store with its own form)`);
  }
  const out: Record<string, unknown> = { ...list };
  if (out['id_field'] === 'id') {
    delete out['id_field'];
    changes.push('id_field id left out (the form keys products by their own id)');
  }
  if (form === 'shopify' && typeof out['path'] === 'string' && WHOLE_PRODUCT_LIST.test(out['path'])) {
    changes.push(`path ${out['path']} left out (the form reads the store's products itself)`);
    delete out['path'];
  }
  if (form === 'shopify' && typeof out['filters'] === 'object' && out['filters'] !== null && !Array.isArray(out['filters']) && Object.keys(out['filters']).length === 0) {
    delete out['filters'];
    changes.push('filters {} left out (no filter reads every product)');
  }
  if (form !== 'shopify') return { writeMethod: method, list: out, judge, changes };
  if (typeof out['after'] === 'object' && out['after'] !== null && !Array.isArray(out['after']) && Object.keys(out['after']).length === 0) {
    delete out['after'];
    // Without a judge the plan then has nothing to set, and the form refuses it for that.
    changes.push('the empty after left out (with judge, the model decides the values)');
  }
  let rule = judge;
  if (typeof judge === 'object' && judge !== null && !Array.isArray(judge)) {
    const j: Record<string, unknown> = { ...(judge as Record<string, unknown>) };
    if (typeof j['schema'] === 'object' && j['schema'] !== null && !Array.isArray(j['schema'])) {
      j['schema'] = renamed(j['schema'] as Record<string, unknown>, 'judge.schema', changes);
    }
    if (Array.isArray(j['context'])) {
      const given = j['context'] as unknown[];
      j['context'] = given.map((f) => {
        const name = typeof f === 'string' ? REST_FIELD_NAMES[f] : undefined;
        if (name === undefined || !SHOPIFY_CONTEXT_FIELDS.includes(name) || given.includes(name)) return f;
        changes.push(`judge.context ${String(f)} as ${name}`);
        return name;
      });
    }
    rule = j;
  }
  return { writeMethod: method, list: out, judge: rule, changes };
}

/** The sentence the answer carries for `changes`, or null. */
export function shopifyPlanNamesNote(form: string, changes: readonly string[]): string | null {
  return changes.length === 0 ? null : `Read for form ${form}: ${changes.join('; ')}. Use these names next time.`;
}
