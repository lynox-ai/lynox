#!/usr/bin/env npx tsx
/**
 * Two-phase corpus generator for entity-extractor-v2 eval.
 *
 * Phase 1: Sonnet generates realistic text chunks per category (no labels).
 * Phase 2: Sonnet re-reads each chunk (fresh context) and labels entities/relations.
 *
 * Separation is procedural — same underlying model — but prevents
 * "cheat-and-match" where the generator emits entities it already picked.
 *
 * Usage:
 *   npx tsx scripts/kg-eval/generate-corpus.ts              # full ~265-chunk run
 *   npx tsx scripts/kg-eval/generate-corpus.ts --dry 10     # tiny smoke run (10 total)
 *
 * Output: scripts/kg-eval/fixtures-generated.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';

const SONNET_MODEL = 'claude-sonnet-4-6';

interface Category {
  id: string;
  count: number;
  prompt: string;
}

const CATEGORIES: Category[] = [
  {
    id: 'business-comms',
    count: 60,
    prompt:
      'short realistic business communication snippets — meeting notes, CRM entries, email excerpts. ' +
      'Mix German and English (~40/60). Include real-sounding person names, company names, deal updates. ' +
      'Length 40–180 chars. No meta-commentary, just the raw text.',
  },
  {
    id: 'product-tech',
    count: 50,
    prompt:
      'sentences mentioning products, tech stacks, or project names in realistic business context. ' +
      'Examples of entities to include: SvelteKit, Postgres, Docker, Cloudflare Pages, Hetzner Cloud, ' +
      'Astro, Stripe, named internal projects. Mix German and English. Length 40–160 chars.',
  },
  {
    id: 'price-trap',
    count: 35,
    prompt:
      'snippets that mention prices or plans prominently — CHF 49/mo, $199/yr, EUR 1000 budget, ' +
      'billing amounts, usage tier costs. The prices are NOT the entities of interest — real entities ' +
      '(company or product names) may or may not also appear. Mix German and English. Length 30–140 chars.',
  },
  {
    id: 'generic-noun-trap',
    count: 35,
    prompt:
      'snippets heavy with generic business nouns like timeline, workflow, pipeline, dashboard, report, ' +
      'tools, funnel, roadmap, sprint, deliverable — used in normal context without naming specific ' +
      'products. Occasionally include one real proper noun among the noise. Mix German and English. ' +
      'Length 30–150 chars.',
  },
  {
    id: 'enum-status-trap',
    count: 25,
    prompt:
      'snippets about CRM deal stages, status enums, workflow states — "lead/qualified", ' +
      '"draft → review → approved", "open/closed/archived", pipeline stages. Real proper nouns may ' +
      'appear alongside. Mix German and English. Length 30–140 chars.',
  },
  {
    id: 'multilingual-names',
    count: 30,
    prompt:
      'snippets with German titles (Herr, Frau, Dr.) + real names, Swiss/German/Austrian locations ' +
      '(Zürich, Bern, Nürnberg, Wien, Berlin), and German company forms (GmbH, AG). Natural business context. ' +
      'Length 40–160 chars.',
  },
  {
    id: 'empty-conversational',
    count: 20,
    prompt:
      'conversational/meta snippets with NO specific named entities — "let me think about it", ' +
      '"we should discuss this later", "good idea", abstract musings, plans-without-names. ' +
      'Mix German and English. Length 20–130 chars.',
  },
  {
    id: 'clean-rich',
    count: 10,
    prompt:
      'information-dense snippets with multiple proper nouns from business context — 2–4 entities per ' +
      'chunk including people + orgs + locations OR products + projects. Length 80–200 chars.',
  },
];

function getApiKey(): string {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];
  try {
    const raw = readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config['api_key'] === 'string' && config['api_key'].length > 0) {
      return config['api_key'];
    }
  } catch { /* fall through */ }
  throw new Error('No API key — set ANTHROPIC_API_KEY or ~/.lynox/config.json');
}

// === Phase 1: text generation ===

const GENERATOR_TOOL = {
  name: 'emit_chunks',
  description: 'Emit generated text chunks.',
  input_schema: {
    type: 'object' as const,
    required: ['chunks'],
    properties: {
      chunks: {
        type: 'array',
        items: { type: 'string', minLength: 20, maxLength: 300 },
      },
    },
  },
};

async function generateCategoryBatch(
  client: Anthropic,
  category: Category,
  n: number,
): Promise<string[]> {
  const userMsg =
    `Generate ${n} distinct text chunks in this category:\n\n${category.prompt}\n\n` +
    `Each chunk should feel like real business communication — no quotation marks around the ` +
    `chunk, no numbering, no meta-commentary. Just the raw text.`;

  const res = await client.beta.messages.create({
    model: SONNET_MODEL,
    max_tokens: 2048,
    temperature: 1,
    tools: [GENERATOR_TOOL],
    tool_choice: { type: 'tool', name: GENERATOR_TOOL.name },
    messages: [{ role: 'user', content: userMsg }],
  });

  const toolUse = res.content.find(
    (c): c is Extract<typeof c, { type: 'tool_use' }> =>
      c.type === 'tool_use' && c.name === GENERATOR_TOOL.name,
  );
  if (!toolUse) return [];

  const input = toolUse.input as { chunks?: unknown };
  if (!Array.isArray(input.chunks)) return [];

  const out: string[] = [];
  for (const c of input.chunks) {
    if (typeof c === 'string' && c.trim().length >= 20) out.push(c.trim());
  }
  return out;
}

async function generateCategory(
  client: Anthropic,
  category: Category,
  batchSize = 10,
): Promise<string[]> {
  const chunks: string[] = [];
  let stallCount = 0;
  const MAX_STALLS = 3;

  while (chunks.length < category.count && stallCount < MAX_STALLS) {
    const remaining = category.count - chunks.length;
    const n = Math.min(batchSize, remaining);

    let batch: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        batch = await generateCategoryBatch(client, category, n);
        if (batch.length > 0) break;
      } catch (err) {
        process.stdout.write(`  [${category.id}] batch attempt ${attempt + 1} errored: ${String(err).slice(0, 80)}\n`);
      }
    }

    if (batch.length === 0) {
      stallCount++;
      process.stdout.write(`  [${category.id}] empty batch (stall ${stallCount}/${MAX_STALLS})\n`);
      continue;
    }

    for (const c of batch) chunks.push(c);
    process.stdout.write(`  [${category.id}] ${chunks.length}/${category.count}\n`);
  }

  if (chunks.length < category.count) {
    process.stdout.write(`  [${category.id}] WARN: gave up at ${chunks.length}/${category.count} after ${MAX_STALLS} stalls\n`);
  }
  return chunks.slice(0, category.count);
}

// === Phase 2: labeling ===

const LABELER_TOOL = {
  name: 'label_extraction',
  description: 'Ground-truth label for a text chunk.',
  input_schema: {
    type: 'object' as const,
    required: ['entities', 'relations'],
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          required: ['canonical_name', 'type'],
          properties: {
            canonical_name: { type: 'string', minLength: 2 },
            type: { enum: ['person', 'organization', 'project', 'product', 'concept', 'location'] },
          },
        },
      },
      relations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['subject', 'predicate', 'object'],
          properties: {
            subject: { type: 'string' },
            predicate: { enum: ['works_for','owns','manages','uses','located_in','part_of','prefers','depends_on','created_by','related_to'] },
            object: { type: 'string' },
          },
        },
      },
    },
  },
};

const LABELER_SYSTEM = `You are a strict entity-extraction reference labeler. Apply these rules
(same rules the production extractor uses):

ACCEPT only proper nouns — specific named people, companies, products, places, projects.

REJECT:
- Generic nouns (tools, workflow, timeline, pipeline, dashboard, report, roadmap)
- Process/action words (direct, manage, review, setup)
- Price expressions (39/mo, CHF 49, $200, EUR 1000)
- Status/enum values (lead/qualified, open/closed, draft, pending)
- Adjectives (active, new, custom, standard)

TYPE disambiguation:
- Bare customer domains (foo.ch, acme-shop.com) → organization
- Vendor-product offerings (Cloudflare Pages, Hetzner Cloud, AWS S3) → product
- Standalone tech (Postgres, Docker, Astro, SvelteKit, Ubuntu) → product
- The company that makes a product = organization; the product = product
- Real cities/countries → location

RELATIONS: only include if explicit in text. Direction matters:
- "X created_by Y" → X is the product, Y is the maker
- "X works_for Y" → X is the person, Y is the employer
- "X uses Y" → X is the consumer, Y is the service

Strip titles (Dr., Herr) from person canonical names unless the name is unknown
without them. Preserve original language.

If no proper nouns are present, return empty arrays. Be strict — false positives
pollute the dataset.`;

async function labelChunk(
  client: Anthropic,
  text: string,
): Promise<{ entities: Array<{canonical_name: string, type: string}>, relations: Array<{subject: string, predicate: string, object: string}> }> {
  const res = await client.beta.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: LABELER_SYSTEM,
    tools: [LABELER_TOOL],
    tool_choice: { type: 'tool', name: LABELER_TOOL.name },
    messages: [{ role: 'user', content: `<text>\n${text}\n</text>` }],
  });

  const toolUse = res.content.find(
    (c): c is Extract<typeof c, { type: 'tool_use' }> =>
      c.type === 'tool_use' && c.name === LABELER_TOOL.name,
  );
  if (!toolUse) return { entities: [], relations: [] };

  const input = toolUse.input as Record<string, unknown>;
  const entitiesRaw = Array.isArray(input['entities']) ? input['entities'] : [];
  const relationsRaw = Array.isArray(input['relations']) ? input['relations'] : [];

  const entities: Array<{canonical_name: string, type: string}> = [];
  for (const e of entitiesRaw) {
    if (typeof e === 'object' && e !== null) {
      const ee = e as Record<string, unknown>;
      if (typeof ee['canonical_name'] === 'string' && typeof ee['type'] === 'string') {
        entities.push({ canonical_name: ee['canonical_name'], type: ee['type'] });
      }
    }
  }
  const relations: Array<{subject: string, predicate: string, object: string}> = [];
  for (const r of relationsRaw) {
    if (typeof r === 'object' && r !== null) {
      const rr = r as Record<string, unknown>;
      if (typeof rr['subject'] === 'string' && typeof rr['predicate'] === 'string' && typeof rr['object'] === 'string') {
        relations.push({ subject: rr['subject'], predicate: rr['predicate'], object: rr['object'] });
      }
    }
  }
  return { entities, relations };
}

// === Main ===

interface GeneratedCase {
  id: string;
  category: string;
  text: string;
  expected_entities: Array<{canonical_name: string, type: string}>;
  expected_relations: Array<{subject: string, predicate: string, object: string}>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryIdx = args.indexOf('--dry');
  const dryCount = dryIdx !== -1 ? parseInt(args[dryIdx + 1] ?? '10', 10) : 0;

  const client = new Anthropic({ apiKey: getApiKey() });

  // Scale categories down for dry runs
  const categories = dryCount > 0
    ? CATEGORIES.map(c => ({ ...c, count: Math.max(1, Math.floor(c.count * dryCount / 265)) }))
    : CATEGORIES;

  const totalTarget = categories.reduce((s, c) => s + c.count, 0);
  console.log(`Generating ${totalTarget} chunks across ${categories.length} categories...\n`);

  // Phase 1: generate all texts
  const pending: Array<{ id: string; category: string; text: string }> = [];
  for (const cat of categories) {
    console.log(`Phase 1 — ${cat.id} (${cat.count})`);
    const texts = await generateCategory(client, cat);
    for (let i = 0; i < texts.length; i++) {
      pending.push({
        id: `gen-${cat.id}-${String(i + 1).padStart(3, '0')}`,
        category: cat.id,
        text: texts[i]!,
      });
    }
  }
  console.log(`\nPhase 1 complete: ${pending.length} texts generated.\n`);

  // Phase 2: label each (parallel in batches of 5 to respect rate limits)
  console.log(`Phase 2 — labeling ${pending.length} chunks...`);
  const cases: GeneratedCase[] = [];
  const BATCH = 5;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const labeled = await Promise.all(batch.map(async p => {
      const lab = await labelChunk(client, p.text);
      return { ...p, expected_entities: lab.entities, expected_relations: lab.relations };
    }));
    cases.push(...labeled);
    process.stdout.write(`  labeled ${cases.length}/${pending.length}\n`);
  }

  // Emit
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, dryCount > 0 ? 'fixtures-generated.dry.json' : 'fixtures-generated.json');
  const out = {
    version: 1,
    description: 'Sonnet-generated + Sonnet-labeled corpus. Two-phase generation, review 10% manually.',
    generated_at: new Date().toISOString(),
    total_cases: cases.length,
    cases,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${cases.length} cases to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
