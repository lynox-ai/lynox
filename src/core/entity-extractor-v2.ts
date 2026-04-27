import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaCacheControlEphemeral,
  BetaTextBlockParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

import type { EntityType, MemoryNamespace } from '../types/index.js';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { getActiveProvider, isCustomProvider } from './llm-client.js';
import { isCleanupTarget } from './kg-stopwords.js';

/**
 * Entity extracted by the v2 tool-call pipeline.
 * Richer than v1: carries aliases + evidence span for the resolver and debugging.
 */
export interface ExtractedEntityV2 {
  canonicalName: string;
  type: EntityType;
  confidence: number;
  aliases: string[];
  evidenceSpan: string;
}

export interface ExtractedRelationV2 {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  confidence: number;
}

export interface ExtractionResultV2 {
  entities: ExtractedEntityV2[];
  relations: ExtractedRelationV2[];
}

/** Fixed predicate vocabulary — forces the model into known categories. */
export const RELATION_PREDICATES = [
  'works_for', 'owns', 'manages', 'uses', 'located_in',
  'part_of', 'prefers', 'depends_on', 'created_by', 'related_to',
] as const;
export type RelationPredicate = (typeof RELATION_PREDICATES)[number];

/**
 * Entity types exposed to the LLM.
 * Note: 'collection' is internal (datastore-bridge only) and intentionally omitted.
 */
const EXTRACTABLE_TYPES = [
  'person', 'organization', 'project', 'product', 'concept', 'location',
] as const satisfies readonly Exclude<EntityType, 'collection'>[];

/** Minimum confidence required for an entity to be returned. Below this → silently dropped. */
export const MIN_CONFIDENCE = 0.8;

const MAX_LLM_EXTRACTIONS_PER_SESSION = 50;
let _v2ExtractionCount = 0;

/** Reset extraction counter (test hook). */
export function resetV2ExtractionCount(): void {
  _v2ExtractionCount = 0;
}

/** Current v2 extraction count (test hook). */
export function getV2ExtractionCount(): number {
  return _v2ExtractionCount;
}

// === System prompt (cached) ===

const SYSTEM_PROMPT = `You extract named entities and relations for a knowledge graph. Be strict:
false positives pollute the graph permanently. Call record_kg_extraction with empty
arrays by default. Only include what you are confident about.

ACCEPT only proper nouns — specific named people, companies, products, places, projects:
- Personal names: "Peter Huber", "Roland"
- Named organizations: "lynox.ai", "Mistral AI", "Hetzner", "Brandfusion"
- Named products: "lynox", "Postgres", "Cloudflare Pages"
- Named projects (explicit): project "Finance Monthly", "auth-rewrite"
- Real geographic locations: "Zurich", "Berlin", "Switzerland"
- Specific concepts with named identifiers: "ELv2 license", "GDPR", "OAuth 2.0"

REJECT (always omit):
- Generic nouns: "tools", "workflow", "timeline", "pipeline", "dashboard", "report", "einzeltools"
- Process/action words: "direct", "manage", "review", "setup", "launch"
- Price expressions: "39/mo", "CHF 49", "$200", "EUR 1000", "49/month"
- Status/enum values: "lead/qualified", "open/closed", "draft", "pending"
- Adjectives: "active", "new", "custom", "standard"
- Pronouns, articles, common words

CONFIDENCE calibration (strict):
- 0.95: Unambiguous proper noun with clear context (e.g., "Peter Huber said...")
- 0.85: Strong signal (e.g., "we deployed lynox")
- 0.80: Minimum to include — if you are less than 80% sure, OMIT the entity entirely
- Do not pad the output with borderline entries

CANONICAL_NAME rules:
- Preserve original casing for proper nouns (lynox.ai, not Lynox.Ai)
- Preserve original language (extract "Thomas" from "Kunde Thomas" as a person, do not translate "Kunde")
- Strip possessives, quotes, trailing punctuation
- Strip titles like "Dr.", "Herr", "Frau", "Mr." from personal names unless the name is unknown without them
- Use the cleanest form; put variants in aliases

TYPE disambiguation (critical):
- Bare domain names representing a business or tenant (foo.ch, customer.lynox.cloud,
  acme-shop.com, brandfusion.ch) → "organization". These are entity references, not products.
- Vendor-product offerings (Cloudflare Pages, Hetzner Cloud, AWS S3, Google Drive,
  "[Vendor] [Offering]" pattern) → "product".
- Standalone tech (Postgres, Docker, Astro, SvelteKit, Ubuntu) → "product".
- The company that creates/sells a product is "organization" (Anthropic makes Claude:
  Anthropic=organization, Claude=product).
- Real geographic places (cities, countries, districts) → "location". Do not classify
  domains as locations.

RELATIONS: only include if both subject and object appear in entities[] and the
relation is explicit in the text. When in doubt, omit. Use only the predicates
defined in the schema enum.

RELATION DIRECTION (easy to get wrong — read carefully):
- "X created_by Y": X is the product or work; Y is the creator.
  CORRECT: "Anthropic released Claude" → {subject:"Claude", predicate:"created_by", object:"Anthropic"}
  WRONG:   {subject:"Anthropic", predicate:"created_by", object:"Claude"}
- "X works_for Y": X is the person employed; Y is the employer.
- "X uses Y": X is the consumer; Y is the dependency or service being used.
  CORRECT: "our stack uses Docker on Hetzner" → the stack uses Docker AND uses Hetzner;
           NOT {subject:"Docker", predicate:"uses", object:"Hetzner"}
- "X located_in Y": X is the thing in a place; Y is the place.
- If direction is unclear, omit the relation.

Examples:

TEXT: "we use lynox to run our agency"
→ entities: [{canonical_name:"lynox", type:"product", confidence:0.9, aliases:[], evidence_span:"we use lynox"}]
→ relations: []

TEXT: "the timeline shows tools in the pipeline"
→ entities: []   (all generic nouns)
→ relations: []

TEXT: "CHF 39/mo plan, hosted on Hetzner"
→ entities: [{canonical_name:"Hetzner", type:"organization", confidence:0.9, aliases:[], evidence_span:"hosted on Hetzner"}]
→ relations: []   (price expressions rejected)

TEXT: "Peter works for Brandfusion in Zurich"
→ entities: [
    {canonical_name:"Peter", type:"person", confidence:0.85, aliases:[], evidence_span:"Peter works for"},
    {canonical_name:"Brandfusion", type:"organization", confidence:0.9, aliases:[], evidence_span:"works for Brandfusion"},
    {canonical_name:"Zurich", type:"location", confidence:0.95, aliases:[], evidence_span:"in Zurich"}
  ]
→ relations: [
    {subject:"Peter", predicate:"works_for", object:"Brandfusion", confidence:0.9},
    {subject:"Brandfusion", predicate:"located_in", object:"Zurich", confidence:0.85}
  ]

TEXT: "Einzeltools kosten CHF 39/mo direct bei lynox.ai"
→ entities: [{canonical_name:"lynox.ai", type:"organization", confidence:0.9, aliases:[], evidence_span:"direct bei lynox.ai"}]
→ relations: []   ("Einzeltools", "direct", "CHF 39/mo" all rejected)`;

// === Tool schema ===

const TOOL_NAME = 'record_kg_extraction';

const TOOL_DEFINITION: BetaToolUnion = {
  name: TOOL_NAME,
  description:
    'Record extracted entities and relations for the knowledge graph. Call with empty ' +
    'arrays if no meaningful proper nouns are present. Do not include entities below confidence 0.8.',
  input_schema: {
    type: 'object' as const,
    required: ['entities', 'relations'],
    properties: {
      entities: {
        type: 'array',
        description: 'Named proper nouns extracted from the text. Empty array if none qualify.',
        items: {
          type: 'object',
          required: ['canonical_name', 'type', 'confidence', 'aliases', 'evidence_span'],
          properties: {
            canonical_name: {
              type: 'string',
              minLength: 2,
              description: 'Clean singular form of the entity. Preserve original language and casing.',
            },
            type: {
              type: 'string',
              enum: [...EXTRACTABLE_TYPES],
              description: 'Entity classification.',
            },
            confidence: {
              type: 'number',
              minimum: 0.8,
              maximum: 1,
              description:
                'How certain this is a specific named entity (not a generic noun). ' +
                'Minimum 0.8 — omit the entity entirely if below.',
            },
            aliases: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Variant forms of the name seen in this specific text (casing, spelling, partial). ' +
                'Empty array if none.',
            },
            evidence_span: {
              type: 'string',
              minLength: 3,
              description: 'Exact substring from the source text that justifies this extraction.',
            },
          },
        },
      },
      relations: {
        type: 'array',
        description:
          'Explicit relations between entities that appear in entities[]. ' +
          'Empty array unless the relation is stated in the text.',
        items: {
          type: 'object',
          required: ['subject', 'predicate', 'object', 'confidence'],
          properties: {
            subject: {
              type: 'string',
              description: 'Must match a canonical_name from entities[].',
            },
            predicate: {
              type: 'string',
              enum: [...RELATION_PREDICATES],
            },
            object: {
              type: 'string',
              description: 'Must match a canonical_name from entities[].',
            },
            confidence: { type: 'number', minimum: 0.8, maximum: 1 },
          },
        },
      },
    },
  },
};

// === Public API ===

/**
 * Determine whether v2 extraction should run for this memory.
 * Same gating rules as v1: knowledge/methods namespace, ≥30 chars, under session cap.
 */
export function shouldExtractV2(text: string, namespace: MemoryNamespace): boolean {
  if (_v2ExtractionCount >= MAX_LLM_EXTRACTIONS_PER_SESSION) return false;
  if (namespace !== 'knowledge' && namespace !== 'methods') return false;
  if (text.length < 30) return false;
  return true;
}

/**
 * Extract entities + relations via a single Haiku tool-call.
 * No regex tier. Returns empty result on error (non-fatal).
 */
export async function extractEntitiesV2(
  text: string,
  client: Anthropic,
): Promise<ExtractionResultV2> {
  _v2ExtractionCount++;

  const provider = getActiveProvider();
  const cacheControl: BetaCacheControlEphemeral | undefined = isCustomProvider()
    ? undefined
    : ({ type: 'ephemeral', ttl: '1h' } as unknown as BetaCacheControlEphemeral);

  const systemBlocks: BetaTextBlockParam[] = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ];

  try {
    const stream = client.beta.messages.stream({
      model: getModelId('haiku', provider),
      max_tokens: 1024,
      temperature: 0,
      ...(isCustomProvider() ? {} : { betas: getBetasForProvider(provider) }),
      system: systemBlocks,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `<source_text>\n${text.slice(0, 2000)}\n</source_text>`,
        },
      ],
    });

    const response = await stream.finalMessage();
    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === TOOL_NAME,
    );
    if (!toolUse) return { entities: [], relations: [] };

    return parseToolInput(toolUse.input);
  } catch {
    return { entities: [], relations: [] };
  }
}

// === Parser ===

const EXTRACTABLE_TYPE_SET = new Set<string>(EXTRACTABLE_TYPES);
const PREDICATE_SET = new Set<string>(RELATION_PREDICATES);

/** Parse and validate the tool-call input. Rejects malformed entries silently. */
export function parseToolInput(input: unknown): ExtractionResultV2 {
  if (typeof input !== 'object' || input === null) return { entities: [], relations: [] };
  const obj = input as Record<string, unknown>;

  const entities: ExtractedEntityV2[] = [];
  const canonicalSet = new Set<string>();

  if (Array.isArray(obj['entities'])) {
    for (const raw of obj['entities']) {
      const parsed = parseEntity(raw);
      if (!parsed) continue;
      const key = `${parsed.type}:${parsed.canonicalName.toLowerCase()}`;
      if (canonicalSet.has(key)) continue;
      canonicalSet.add(key);
      entities.push(parsed);
    }
  }

  const relations: ExtractedRelationV2[] = [];
  const entityNames = new Set(entities.map(e => e.canonicalName.toLowerCase()));

  if (Array.isArray(obj['relations'])) {
    for (const raw of obj['relations']) {
      const parsed = parseRelation(raw, entityNames);
      if (parsed) relations.push(parsed);
    }
  }

  return { entities, relations };
}

function parseEntity(raw: unknown): ExtractedEntityV2 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;

  const canonicalName = typeof e['canonical_name'] === 'string' ? e['canonical_name'].trim() : '';
  const type = typeof e['type'] === 'string' ? e['type'] : '';
  const confidence = typeof e['confidence'] === 'number' ? e['confidence'] : -1;
  const aliasesRaw = Array.isArray(e['aliases']) ? e['aliases'] : [];
  const evidenceSpan = typeof e['evidence_span'] === 'string' ? e['evidence_span'] : '';

  if (canonicalName.length < 2) return null;
  if (!EXTRACTABLE_TYPE_SET.has(type)) return null;
  if (confidence < MIN_CONFIDENCE || confidence > 1) return null;
  // Defense-in-depth: even at ≥0.8 confidence, drop generic nouns / pricing
  // fragments. Same gate as the historical cleanup pass — keeps the prompt,
  // the runtime filter, and the purge in lockstep.
  if (isCleanupTarget(canonicalName)) return null;

  const aliases = aliasesRaw
    .filter((a): a is string => typeof a === 'string')
    .map(a => a.trim())
    .filter(a => a.length >= 2 && a.toLowerCase() !== canonicalName.toLowerCase());

  return {
    canonicalName,
    type: type as EntityType,
    confidence,
    aliases,
    evidenceSpan,
  };
}

function parseRelation(raw: unknown, knownEntities: Set<string>): ExtractedRelationV2 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const subject = typeof r['subject'] === 'string' ? r['subject'].trim() : '';
  const predicate = typeof r['predicate'] === 'string' ? r['predicate'] : '';
  const object = typeof r['object'] === 'string' ? r['object'].trim() : '';
  const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : -1;

  if (subject.length < 2 || object.length < 2) return null;
  if (!PREDICATE_SET.has(predicate)) return null;
  if (confidence < MIN_CONFIDENCE || confidence > 1) return null;
  if (!knownEntities.has(subject.toLowerCase())) return null;
  if (!knownEntities.has(object.toLowerCase())) return null;

  return {
    subject,
    predicate: predicate as RelationPredicate,
    object,
    confidence,
  };
}
