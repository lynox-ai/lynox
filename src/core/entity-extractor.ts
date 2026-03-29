import type Anthropic from '@anthropic-ai/sdk';
import type { EntityType, MemoryNamespace } from '../types/index.js';
import { MODEL_MAP, LYNOX_BETAS } from '../types/index.js';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  confidence: number;
}

export interface ExtractedRelation {
  from: string;
  to: string;
  relationType: string;
  description: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

// === Tier 1: Regex-based extraction (zero cost, always runs) ===

/** Title prefixes that indicate a person name follows. */
const TITLE_RE = /\b(?:Herr|Frau|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g;

/** "client Thomas", "user Alex", "partner Maria", "Kunde Thomas" */
const ROLE_NAME_RE = /\b(?:client|user|partner|colleague|boss|contact|customer|Kunde|Kundin|Partnerin|Kollegin?)\s+([A-ZÄÖÜ][a-zäöüß]+)/gi;

/** Domain names like "acme-shop.ch", "lynox.ai" — excludes common false positives */
const DOMAIN_RE = /\b([a-z0-9][-a-z0-9]{0,62}\.(?:com|org|net|dev|io|ch|de|at|fr|it|co|ai|app|cloud))\b/g;
const COMMON_DOMAINS = new Set([
  'github.com', 'google.com', 'npm.org', 'nodejs.org', 'anthropic.com',
  'npmjs.com', 'huggingface.co', 'openai.com', 'docker.com',
]);

/** Explicit org markers: "company X", "Firma Y" */
const ORG_EXPLICIT_RE = /\b(?:company|firm|agency|Firma|Unternehmen|Organisation|GmbH|AG|LLC|Inc)\s+([A-ZÄÖÜa-zäöüß][\wäöüßÄÖÜ-]+)/gi;

/** Technology in usage context: "uses PostgreSQL", "chose SvelteKit", "switched to Lucia" */
const TECH_USAGE_RE = /\b(?:uses?|requires?|chose|switched\s+to|migrated\s+to|runs?\s+on|built\s+with|powered\s+by|nutzt|verwendet|braucht)\s+([\w-]+(?:\.[\w-]+)*(?:\s+v?\d+[\w.]*)?)(?=[.,;:!?\s]|$)/gi;
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'it', 'this', 'that', 'they', 'we', 'our', 'their',
  'some', 'all', 'any', 'no', 'not', 'only', 'just', 'also', 'still',
  'das', 'die', 'der', 'ein', 'eine', 'es', 'wir', 'sie', 'man',
]);

/** Project references: project "Name", Projekt "Name", org/repo */
const PROJECT_QUOTED_RE = /\b(?:project|Projekt)\s+["']([^"']+)["']/gi;
const REPO_RE = /\b([a-z0-9][-a-z0-9]*\/[a-z0-9][-a-z0-9]*)\b/g;

/** Location markers: "in Zurich", "located in Berlin", "based in" */
const LOCATION_RE = /\b(?:in|from|located\s+in|based\s+in|aus|in)\s+([A-ZÄÖÜ][a-zäöüß]{2,}(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)\b/g;
const COMMON_PREPOSITION_FOLLOWERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'order', 'general', 'particular',
  'addition', 'fact', 'case', 'mind', 'place', 'total', 'summary',
  'der', 'die', 'das', 'dem', 'den', 'einer',
]);

/**
 * Extract entities from text using regex patterns.
 * Returns deduplicated entities with confidence scores.
 */
export function extractEntitiesRegex(text: string): ExtractionResult {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  const addEntity = (name: string, type: EntityType, confidence: number): void => {
    const normalized = name.trim();
    if (normalized.length < 2) return;
    const key = `${type}:${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name: normalized, type, confidence });
  };

  // Persons: title + name
  for (const match of text.matchAll(TITLE_RE)) {
    if (match[1]) addEntity(match[1], 'person', 0.9);
  }

  // Persons: role + name
  for (const match of text.matchAll(ROLE_NAME_RE)) {
    if (match[1]) addEntity(match[1], 'person', 0.8);
  }

  // Organizations: domain names
  for (const match of text.matchAll(DOMAIN_RE)) {
    const domain = match[1];
    if (domain && !COMMON_DOMAINS.has(domain)) {
      addEntity(domain, 'organization', 0.7);
    }
  }

  // Organizations: explicit markers — filter stop words (e.g. "Unternehmen in" → "in")
  for (const match of text.matchAll(ORG_EXPLICIT_RE)) {
    const name = match[1]?.trim();
    if (name && name.length >= 3 && !COMMON_WORDS.has(name.toLowerCase())) {
      addEntity(name, 'organization', 0.8);
    }
  }

  // Technology: usage context
  for (const match of text.matchAll(TECH_USAGE_RE)) {
    const tech = match[1]?.trim();
    if (tech && !COMMON_WORDS.has(tech.toLowerCase()) && tech.length > 1) {
      addEntity(tech, 'concept', 0.6);
    }
  }

  // Projects: quoted names
  for (const match of text.matchAll(PROJECT_QUOTED_RE)) {
    if (match[1]) addEntity(match[1], 'project', 0.8);
  }

  // Projects: org/repo format
  for (const match of text.matchAll(REPO_RE)) {
    if (match[1]) addEntity(match[1], 'project', 0.7);
  }

  // Locations
  for (const match of text.matchAll(LOCATION_RE)) {
    const loc = match[1]?.trim();
    if (loc && !COMMON_PREPOSITION_FOLLOWERS.has(loc.toLowerCase())) {
      // Simple heuristic: only if capitalized and not already captured as person/org
      const key = `location:${loc.toLowerCase()}`;
      if (!seen.has(key) && !seen.has(`person:${loc.toLowerCase()}`)) {
        addEntity(loc, 'location', 0.5);
      }
    }
  }

  return { entities, relations: [] };
}

// === Tier 2: LLM-based extraction (optional, for high-value memories) ===

const ENTITY_EXTRACTION_PROMPT = `Extract SPECIFIC named entities and their relationships from this text.
Return a JSON object with two arrays:
- "entities": [{"name": "...", "type": "person|organization|project|product|concept|location"}]
- "relations": [{"from": "entity name", "to": "entity name", "type": "relationship type", "description": "brief description"}]

Relationship types: works_for, owns, manages, uses, located_in, part_of, prefers, depends_on, created_by, related_to

Rules:
- ONLY extract proper nouns and specific named things (people, companies, products, places, named projects)
- DO NOT extract generic concepts, adjectives, or common nouns (e.g. "investor", "round", "potential", "history", "details")
- DO NOT extract single common words that are not names
- Entity names must be at least 2 words OR a recognized proper noun (e.g. "Peter Huber", "lynox AI", "Zurich")
- Keep entity names as they appear (preserve original language)
- Return {"entities": [], "relations": []} if nothing specific is found
- When in doubt, leave it out — fewer high-quality entities are better than many noisy ones

Text: `;

const MAX_LLM_EXTRACTIONS_PER_SESSION = 50;
let _llmExtractionCount = 0;

/** Reset extraction counter (for testing). */
export function resetLLMExtractionCount(): void {
  _llmExtractionCount = 0;
}

/**
 * Determine whether LLM extraction should be used for this memory.
 * Only for high-value namespaces with sufficient text and likely entities.
 */
export function shouldUseLLMExtraction(
  text: string,
  namespace: MemoryNamespace,
  _regexEntities: ExtractedEntity[],
): boolean {
  // Session cap: prevent unbounded LLM extraction costs
  if (_llmExtractionCount >= MAX_LLM_EXTRACTIONS_PER_SESSION) return false;
  // Only for knowledge and methods — highest value namespaces
  if (namespace !== 'knowledge' && namespace !== 'methods') return false;
  // Only if text is substantial enough for meaningful extraction
  if (text.length < 30) return false;
  // Always run LLM for qualifying text — regex results are merged, not a gate.
  // Regex is fast but noisy; LLM catches names, roles, and relationships that regex misses.
  return true;
}

/**
 * Extract entities using Haiku LLM call (~$0.001).
 */
export async function extractEntitiesLLM(
  text: string,
  client: Anthropic,
): Promise<ExtractionResult> {
  _llmExtractionCount++;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL_MAP['haiku'],
      max_tokens: 512,
      betas: [...LYNOX_BETAS],
      messages: [{ role: 'user', content: ENTITY_EXTRACTION_PROMPT + text.slice(0, 2000) }],
    });
    const response = await stream.finalMessage();

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return { entities: [], relations: [] };

    return parseExtractionResponse(textBlock.text);
  } catch {
    return { entities: [], relations: [] };
  }
}

/**
 * Combined extraction: regex first, then optional LLM if needed.
 */
export async function extractEntities(
  text: string,
  namespace: MemoryNamespace,
  client?: Anthropic | undefined,
): Promise<ExtractionResult> {
  const regexResult = extractEntitiesRegex(text);

  if (client && shouldUseLLMExtraction(text, namespace, regexResult.entities)) {
    const llmResult = await extractEntitiesLLM(text, client);
    return mergeResults(regexResult, llmResult);
  }

  return regexResult;
}

// === Parsing ===

const VALID_ENTITY_TYPES = new Set<string>([
  'person', 'organization', 'project', 'product', 'concept', 'location',
]);

function parseExtractionResponse(raw: string): ExtractionResult {
  try {
    const parsed = parseJson(raw);
    if (typeof parsed !== 'object' || parsed === null) return { entities: [], relations: [] };

    const obj = parsed as Record<string, unknown>;

    const entities: ExtractedEntity[] = [];
    if (Array.isArray(obj['entities'])) {
      for (const e of obj['entities']) {
        if (typeof e === 'object' && e !== null) {
          const ent = e as Record<string, unknown>;
          const name = typeof ent['name'] === 'string' ? ent['name'] : '';
          const type = typeof ent['type'] === 'string' && VALID_ENTITY_TYPES.has(ent['type'])
            ? ent['type'] as EntityType
            : 'concept';
          if (name.length >= 2) {
            entities.push({ name, type, confidence: 0.75 });
          }
        }
      }
    }

    const relations: ExtractedRelation[] = [];
    if (Array.isArray(obj['relations'])) {
      for (const r of obj['relations']) {
        if (typeof r === 'object' && r !== null) {
          const rel = r as Record<string, unknown>;
          const from = typeof rel['from'] === 'string' ? rel['from'] : '';
          const to = typeof rel['to'] === 'string' ? rel['to'] : '';
          const relationType = typeof rel['type'] === 'string' ? rel['type'] : 'related_to';
          const description = typeof rel['description'] === 'string' ? rel['description'] : '';
          if (from.length >= 2 && to.length >= 2) {
            relations.push({ from, to, relationType, description });
          }
        }
      }
    }

    return { entities, relations };
  } catch {
    return { entities: [], relations: [] };
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Try fenced JSON block
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // continue
      }
    }
    // Best-effort object slice
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('No JSON object found');
  }
}

function mergeResults(a: ExtractionResult, b: ExtractionResult): ExtractionResult {
  const seen = new Set<string>();
  const entities: ExtractedEntity[] = [];

  for (const e of [...a.entities, ...b.entities]) {
    const key = `${e.type}:${e.name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push(e);
    }
  }

  // Deduplicate relations by from+to+type
  const relSeen = new Set<string>();
  const relations: ExtractedRelation[] = [];
  for (const r of [...a.relations, ...b.relations]) {
    const key = `${r.from.toLowerCase()}:${r.to.toLowerCase()}:${r.relationType}`;
    if (!relSeen.has(key)) {
      relSeen.add(key);
      relations.push(r);
    }
  }

  return { entities, relations };
}
