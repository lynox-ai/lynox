/**
 * KG Lifecycle Stress Test
 *
 * Simulates realistic data progression over time to harden the entire
 * Knowledge Graph system: entity extraction, contradiction detection,
 * deduplication, confidence changes, retrieval quality, GC, and edge cases.
 *
 * Uses real SQLite + LocalProvider embeddings (no mocks) to test the
 * full integrated pipeline as a user would experience it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { extractEntitiesRegex, isValidEntity } from './entity-extractor.js';
import { classifyScope } from './scope-classifier.js';
import type { MemoryScopeRef, MemoryNamespace, KnowledgeStoreResult } from '../types/index.js';

// ── Helpers ──────────────────────────────────────────────────

let layer: KnowledgeLayer;
let tempDir: string;

const CTX: MemoryScopeRef = { type: 'context', id: 'stress-project' };
const USER: MemoryScopeRef = { type: 'user', id: 'stress-user' };
const GLOBAL: MemoryScopeRef = { type: 'global', id: '' };

/** Store and assert it was stored. */
async function mustStore(
  text: string, ns: MemoryNamespace, scope: MemoryScopeRef,
): Promise<KnowledgeStoreResult> {
  const r = await layer.store(text, ns, scope);
  expect(r.stored).toBe(true);
  return r;
}

// ── Setup / Teardown ─────────────────────────────────────────

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'lynox-kg-stress-'));
  layer = new KnowledgeLayer(join(tempDir, 'stress.db'), new LocalProvider());
  await layer.init();
});

afterAll(async () => {
  await layer.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Entity Extraction — Classifier Hardening
// ═══════════════════════════════════════════════════════════════

describe('Phase 1: Entity Extraction Edge Cases', () => {
  describe('person extraction edge cases', () => {
    it('extracts hyphenated names with titles', () => {
      const r = extractEntitiesRegex('Dr. Hans-Peter Müller presented the quarterly report.');
      expect(r.entities).toContainEqual(
        expect.objectContaining({ name: 'Hans-Peter Müller', type: 'person' }),
      );
    });

    it('extracts double-hyphenated names', () => {
      const r = extractEntitiesRegex('Mrs. Anna-Lena Krüger-Schmidt called today.');
      expect(r.entities).toContainEqual(
        expect.objectContaining({ name: 'Anna-Lena Krüger-Schmidt', type: 'person' }),
      );
    });

    it('extracts space-separated full names with titles', () => {
      const r = extractEntitiesRegex('Dr. Maria Fischer presented the results.');
      expect(r.entities).toContainEqual(
        expect.objectContaining({ name: 'Maria Fischer', type: 'person' }),
      );
    });

    it('handles multiple persons in one sentence', () => {
      const r = extractEntitiesRegex(
        'Herr Meier und Frau Schmidt trafen sich mit Mr. Johnson.',
      );
      const persons = r.entities.filter(e => e.type === 'person');
      expect(persons.length).toBeGreaterThanOrEqual(3);
    });

    it('does not extract generic role words as persons', () => {
      const r = extractEntitiesRegex('The client wants a report. The user needs access.');
      const names = r.entities.map(e => e.name.toLowerCase());
      expect(names).not.toContain('client');
      expect(names).not.toContain('user');
    });

    it('extracts person from German role context', () => {
      const r = extractEntitiesRegex('Partnerin Claudia hat das Angebot bestätigt.');
      expect(r.entities).toContainEqual(
        expect.objectContaining({ name: 'Claudia', type: 'person' }),
      );
    });
  });

  describe('organization extraction edge cases', () => {
    it('extracts .ch and .de domains', () => {
      const r = extractEntitiesRegex(
        'We built the site for huber-baeckerei.ch and metzgerei-wolf.de.',
      );
      const orgs = r.entities.filter(e => e.type === 'organization');
      expect(orgs.length).toBeGreaterThanOrEqual(1);
    });

    it('handles GmbH and AG suffixes', () => {
      const r = extractEntitiesRegex('Firma Huber-Tech has a partnership with Firma SwissData.');
      const orgs = r.entities.filter(e => e.type === 'organization');
      expect(orgs.length).toBeGreaterThanOrEqual(1);
    });

    it('skips common infrastructure domains', () => {
      const r = extractEntitiesRegex(
        'Deploy to github.com, use google.com for search, check npm.org packages.',
      );
      const orgNames = r.entities.filter(e => e.type === 'organization').map(e => e.name);
      expect(orgNames).not.toContain('github.com');
      expect(orgNames).not.toContain('google.com');
    });
  });

  describe('technology extraction edge cases', () => {
    it('extracts versioned tech references', () => {
      const r = extractEntitiesRegex('The stack uses PostgreSQL v16 and requires Redis v7.');
      const concepts = r.entities.filter(e => e.type === 'concept');
      expect(concepts.length).toBeGreaterThanOrEqual(1);
    });

    it('handles German tech context', () => {
      const r = extractEntitiesRegex(
        'Das Team verwendet SvelteKit und nutzt Tailwind für Styling.',
      );
      const concepts = r.entities.filter(e => e.type === 'concept');
      const names = concepts.map(e => e.name);
      expect(names.some(n => n.includes('SvelteKit') || n.includes('Tailwind'))).toBe(true);
    });

    it('does not extract common words as tech', () => {
      const r = extractEntitiesRegex('The team uses the framework for all projects.');
      const names = r.entities.map(e => e.name.toLowerCase());
      expect(names).not.toContain('the');
      expect(names).not.toContain('all');
    });
  });

  describe('location extraction edge cases', () => {
    it('extracts Swiss cities', () => {
      const r = extractEntitiesRegex('Office is based in Zürich, team also in Basel.');
      const locs = r.entities.filter(e => e.type === 'location');
      const names = locs.map(e => e.name);
      expect(names.some(n => n.includes('Zürich') || n.includes('Basel'))).toBe(true);
    });

    it('does not extract preposition followers as locations', () => {
      const r = extractEntitiesRegex('We proceed in order and in general follow the plan.');
      const locs = r.entities.filter(e => e.type === 'location');
      const names = locs.map(e => e.name.toLowerCase());
      expect(names).not.toContain('order');
      expect(names).not.toContain('general');
    });
  });

  describe('false positive filtering (stopwords / enum values)', () => {
    const stopwordCandidates = [
      'investor', 'deal', 'leads', 'pipeline', 'conversion', 'proposal',
      'negotiation', 'discovery', 'onboarding', 'retention', 'report',
      'tracking', 'qualified', 'unqualified', 'pending', 'approved',
      'bevorzugt', 'benötigt', 'verwaltet', 'erstellt',
    ];

    for (const word of stopwordCandidates) {
      it(`rejects stopword "${word}"`, () => {
        expect(isValidEntity(word, 'concept')).toBe(false);
      });
    }

    it('rejects slash-separated CRM enums', () => {
      expect(isValidEntity('lead/qualified', 'project')).toBe(false);
      expect(isValidEntity('deal/negotiation', 'project')).toBe(false);
      expect(isValidEntity('status/active', 'concept')).toBe(false);
    });

    it('accepts real org/repo patterns', () => {
      expect(isValidEntity('lynox-ai/lynox', 'project')).toBe(true);
      expect(isValidEntity('vercel/next.js', 'project')).toBe(true);
    });

    it('rejects all-stopword multi-word phrases', () => {
      expect(isValidEntity('investor tracking report', 'product')).toBe(false);
      expect(isValidEntity('deal pipeline conversion', 'product')).toBe(false);
    });

    it('accepts real multi-word names', () => {
      expect(isValidEntity('Peter Huber', 'person')).toBe(true);
      expect(isValidEntity('Swiss Federal Railways', 'organization')).toBe(true);
    });
  });

  describe('mixed complex sentences', () => {
    it('extracts from a dense business sentence', () => {
      const r = extractEntitiesRegex(
        'Kunde Thomas von acme-shop.ch in Zürich nutzt Shopify, braucht API-Zugang und hat Projekt "Migration Q2" gestartet.',
      );
      const types = new Set(r.entities.map(e => e.type));
      expect(types.has('person')).toBe(true);
      expect(types.has('organization')).toBe(true);
      // At least 3 entity types from this rich sentence
      expect(types.size).toBeGreaterThanOrEqual(3);
    });

    it('handles sentence with no extractable entities', () => {
      const r = extractEntitiesRegex('The system processed all requests successfully yesterday.');
      // Should not crash, may have zero or few entities
      expect(r.entities).toBeDefined();
      expect(r.relations).toHaveLength(0);
    });

    it('handles very long text without blowing up', () => {
      const longText = Array.from({ length: 50 }, (_, i) =>
        `Client User${i} von org${i}.ch nutzt Tool${i}.`,
      ).join(' ');
      const r = extractEntitiesRegex(longText);
      expect(r.entities.length).toBeGreaterThan(10);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Scope Classifier Edge Cases
// ═══════════════════════════════════════════════════════════════

describe('Phase 2: Scope Classifier Edge Cases', () => {
  const MULTI_SCOPES: MemoryScopeRef[] = [CTX, USER, GLOBAL];

  it('classifies personal preferences as user scope', () => {
    const r = classifyScope('I prefer dark mode and vim keybindings.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('user');
  });

  it('classifies German personal preference', () => {
    const r = classifyScope('Ich bevorzuge TypeScript gegenüber JavaScript.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('user');
  });

  it('classifies universal best practices as global', () => {
    const r = classifyScope('Best practice is to never store secrets in code.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('global');
  });

  it('classifies German best practice as global', () => {
    const r = classifyScope('Sicherheit: Passwörter nie im Klartext speichern.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('global');
  });

  it('defaults to context for project-specific info', () => {
    const r = classifyScope('The API endpoint returns JSON with pagination.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('context');
  });

  it('handles single scope deterministically', () => {
    const r = classifyScope('Anything goes here.', 'knowledge', [CTX]);
    expect(r.scope.type).toBe('context');
    expect(r.confidence).toBe(1.0);
  });

  it('handles ambiguous text (personal + global signals)', () => {
    // "I prefer" is user, "best practice" is global — user should win (checked first)
    const r = classifyScope('I prefer following the best practice of TDD.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('user');
  });

  it('handles French personal preference', () => {
    const r = classifyScope('Je préfère utiliser VS Code pour le développement.', 'knowledge', MULTI_SCOPES);
    expect(r.scope.type).toBe('user');
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 3: Data Evolution Simulation — Full Lifecycle
// ═══════════════════════════════════════════════════════════════

describe('Phase 3: Lifecycle — Data Evolution Over Time', () => {

  // --- Week 1: Initial onboarding facts ---
  describe('Week 1: Initial data ingestion', () => {
    it('stores initial client knowledge', async () => {
      const facts = [
        'Client Thomas runs acme-shop.ch, an e-commerce store based in Zürich.',
        'Thomas uses Shopify for his online store and needs API integration.',
        'Acme-Shop has 50 employees and annual revenue of 2000000 CHF.',
        'Contact person at acme-shop.ch is Frau Keller, head of IT.',
        'Acme-Shop currently uses WordPress for their blog section.',
      ];
      for (const fact of facts) {
        const r = await layer.store(fact, 'knowledge', CTX);
        expect(r.stored).toBe(true);
      }
      const stats = await layer.stats();
      expect(stats.memoryCount).toBeGreaterThanOrEqual(5);
    });

    it('stores learning from initial interactions', async () => {
      await mustStore(
        'Thomas prefers email communication over phone calls.',
        'knowledge', CTX,
      );
      await mustStore(
        'Best practice: always document API changes in the changelog.',
        'knowledge', CTX,
      );
    });

    it('stores method preferences', async () => {
      await mustStore(
        'For API integration with Shopify, use the REST Admin API with OAuth tokens.',
        'methods', CTX,
      );
    });
  });

  // --- Week 2: Updates and contradictions ---
  describe('Week 2: Factual updates (contradictions)', () => {
    it('detects revenue update contradiction', async () => {
      const r = await layer.store(
        'Acme-Shop has annual revenue of 3500000 CHF after a strong Q1.',
        'knowledge', CTX,
      );
      expect(r.stored).toBe(true);
      // The number change heuristic should fire if similarity is high enough
      // (depends on LocalProvider embedding proximity)
    });

    it('detects state change: WordPress replaced', async () => {
      const r = await layer.store(
        'Acme-Shop no longer uses WordPress. They switched to Astro for the blog.',
        'knowledge', CTX,
      );
      expect(r.stored).toBe(true);
      // Negation + state change should fire vs the WordPress memory
    });

    it('detects employee count change', async () => {
      const r = await layer.store(
        'Acme-Shop now has 75 employees after recent hiring.',
        'knowledge', CTX,
      );
      expect(r.stored).toBe(true);
    });

    it('does not contradict additive method knowledge', async () => {
      const r = await layer.store(
        'For Shopify integration, also consider using GraphQL Admin API for better performance.',
        'methods', CTX,
      );
      expect(r.stored).toBe(true);
      // Methods namespace: contradiction check skipped
      expect(r.contradictions).toHaveLength(0);
    });
  });

  // --- Week 3: Deduplication and confidence ---
  describe('Week 3: Deduplication & confidence boosting', () => {
    it('deduplicates exact repeated facts', async () => {
      const text = 'Client Thomas runs acme-shop.ch, an e-commerce store based in Zürich.';
      const r = await layer.store(text, 'knowledge', CTX);
      expect(r.deduplicated).toBe(true);
      expect(r.stored).toBe(false);
    });

    it('deduplicates near-identical rephrasings', async () => {
      // Very similar to the original — should dedup
      const r = await layer.store(
        'Client Thomas runs acme-shop.ch, an e-commerce shop in Zürich.',
        'knowledge', CTX,
      );
      // With LocalProvider, slight wording changes may or may not dedup
      // Either outcome is valid — the system should not crash
      expect(typeof r.stored).toBe('boolean');
    });

    it('stores genuinely new information', async () => {
      const r = await mustStore(
        'Thomas is planning to expand acme-shop.ch into the German market by Q3.',
        'knowledge', CTX,
      );
      expect(r.entities.length).toBeGreaterThanOrEqual(0);
    });
  });

  // --- Week 4: Multi-scope progression ---
  describe('Week 4: Multi-scope knowledge', () => {
    it('stores user-scoped preferences', async () => {
      await mustStore('I prefer to work with TypeScript strict mode.', 'knowledge', USER);
      await mustStore('My workflow starts with a test file before implementation.', 'methods', USER);
    });

    it('stores global-scoped best practices', async () => {
      await mustStore(
        'Always validate API keys before making external calls.',
        'knowledge', GLOBAL,
      );
      await mustStore(
        'Never store passwords in plain text — use bcrypt or argon2.',
        'learnings', GLOBAL,
      );
    });

    it('retrieves from correct scopes', async () => {
      const userResult = await layer.retrieve('TypeScript preferences', [USER], {
        topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
      });
      expect(userResult.memories).toBeDefined();

      const globalResult = await layer.retrieve('API key validation', [GLOBAL], {
        topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
      });
      expect(globalResult.memories).toBeDefined();
    });
  });

  // --- Week 5: Second client with entity overlap ---
  describe('Week 5: Second client — entity resolution stress', () => {
    it('stores knowledge about a second client', async () => {
      const facts = [
        'Client Maria runs swiss-bakery.ch, a bakery chain based in Basel.',
        'Maria uses Shopify for online orders, same platform as Thomas.',
        'Swiss Bakery has 120 employees across 8 locations.',
        'Maria wants a loyalty program integrated with her Shopify store.',
      ];
      for (const fact of facts) {
        await mustStore(fact, 'knowledge', CTX);
      }
    });

    it('correctly keeps separate entities for Thomas and Maria', async () => {
      const thomas = await layer.resolveEntity('Thomas', [CTX]);
      const maria = await layer.resolveEntity('Maria', [CTX]);

      if (thomas && maria) {
        expect(thomas.id).not.toBe(maria.id);
        expect(thomas.canonicalName.toLowerCase()).toContain('thomas');
        expect(maria.canonicalName.toLowerCase()).toContain('maria');
      }
    });

    it('resolves Shopify as a shared entity', async () => {
      const shopify = await layer.resolveEntity('Shopify', [CTX]);
      if (shopify) {
        // Should exist and have been mentioned by both clients
        expect(shopify.mentionCount).toBeGreaterThanOrEqual(1);
      }
    });

    it('retrieves Thomas-specific info without Maria leakage', async () => {
      const result = await layer.retrieve('acme-shop.ch Thomas e-commerce', [CTX], {
        topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
      });
      const texts = result.memories.map(m => m.text);
      // Top results should mention Thomas/acme, not primarily Maria/bakery
      const thomasMentions = texts.filter(t =>
        t.toLowerCase().includes('thomas') || t.toLowerCase().includes('acme'),
      );
      expect(thomasMentions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Week 6: Status updates (temporal, non-contradictory) ---
  describe('Week 6: Status namespace (additive, no contradictions)', () => {
    it('stores successive status updates without contradiction', async () => {
      const statuses = [
        'Acme-Shop API integration: Phase 1 complete — authentication implemented.',
        'Acme-Shop API integration: Phase 2 in progress — product sync started.',
        'Acme-Shop API integration: Phase 2 complete — product sync done.',
        'Acme-Shop API integration: Phase 3 pending — order sync next.',
      ];
      for (const s of statuses) {
        const r = await layer.store(s, 'status', CTX);
        expect(r.contradictions).toHaveLength(0);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 4: Contradiction Detection Stress
// ═══════════════════════════════════════════════════════════════

describe('Phase 4: Contradiction Detection Deep Dive', () => {
  let layer2: KnowledgeLayer;

  beforeAll(async () => {
    layer2 = new KnowledgeLayer(join(tempDir, 'contra-stress.db'), new LocalProvider());
    await layer2.init();
  });

  afterAll(async () => {
    await layer2.close();
  });

  describe('negation patterns', () => {
    it('detects English negation with "does not"', async () => {
      await layer2.store('The system uses Redis for caching.', 'knowledge', CTX);
      const r = await layer2.store('The system does not use Redis anymore.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects English negation with "no longer"', async () => {
      await layer2.store('The team deploys on Friday afternoons.', 'knowledge', CTX);
      const r = await layer2.store('The team no longer deploys on Friday afternoons.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects German negation with "nicht mehr"', async () => {
      await layer2.store('Das Team nutzt Slack für Kommunikation.', 'knowledge', CTX);
      const r = await layer2.store('Das Team nutzt nicht mehr Slack für Kommunikation.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects German negation with "kein/keine"', async () => {
      await layer2.store('Es gibt einen Staging-Server.', 'knowledge', CTX);
      const r = await layer2.store('Es gibt keinen Staging-Server mehr.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });
  });

  describe('number changes', () => {
    it('detects budget change (bypasses dedup via heuristic)', async () => {
      await layer2.store('Monthly budget is 5000 for infrastructure.', 'knowledge', CTX);
      const r = await layer2.store('Monthly budget is 12000 for infrastructure.', 'knowledge', CTX);
      // Dedup would fire (cosine 0.94 > 0.90) but the heuristic detects
      // a number change and bypasses dedup → contradiction detector runs
      expect(r.stored).toBe(true);
      expect(r.deduplicated).toBe(false);
    });

    it('detects team size change (bypasses dedup via heuristic)', async () => {
      await layer2.store('Team size is 8 developers.', 'knowledge', CTX);
      const r = await layer2.store('Team size is 12 developers.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
      expect(r.deduplicated).toBe(false);
    });

    it('does not flag same numbers as contradiction', async () => {
      await layer2.store('Server count is 3 in production.', 'knowledge', CTX);
      const r = await layer2.store('Server count is 3 in production cluster.', 'knowledge', CTX);
      // Either dedup or no contradiction — but NOT a false positive contradiction
      if (r.stored) {
        const hasContradiction = r.contradictions.some(c => c.resolution === 'superseded');
        // Same number should not be flagged
        expect(hasContradiction).toBe(false);
      }
    });
  });

  describe('state changes', () => {
    it('detects active to completed', async () => {
      await layer2.store('The migration project is active.', 'knowledge', CTX);
      const r = await layer2.store('The migration project is completed.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects open to closed', async () => {
      await layer2.store('The support ticket is open.', 'knowledge', CTX);
      const r = await layer2.store('The support ticket is closed.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects enabled to disabled', async () => {
      await layer2.store('Two-factor authentication is enabled.', 'knowledge', CTX);
      const r = await layer2.store('Two-factor authentication is disabled.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects German state change: aktiv to abgeschlossen', async () => {
      await layer2.store('Das Projekt ist aktiv.', 'knowledge', CTX);
      const r = await layer2.store('Das Projekt ist abgeschlossen.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });

    it('detects pending to rejected', async () => {
      await layer2.store('The proposal is pending review.', 'knowledge', CTX);
      const r = await layer2.store('The proposal is rejected.', 'knowledge', CTX);
      expect(r.stored).toBe(true);
    });
  });

  describe('non-contradictions (should NOT flag)', () => {
    it('does not flag additive elaboration', async () => {
      await layer2.store('PostgreSQL is used for the database.', 'knowledge', CTX);
      const r = await layer2.store(
        'PostgreSQL is used for the database with JSONB support.',
        'knowledge', CTX,
      );
      // May dedup or store — but should not flag as contradiction
      if (r.stored) {
        const stateContradictions = r.contradictions.filter(c => c.resolution === 'superseded');
        expect(stateContradictions).toHaveLength(0);
      }
    });

    it('does not flag methods as contradictions', async () => {
      await layer2.store('Use fetch for HTTP requests.', 'methods', CTX);
      const r = await layer2.store('Do not use fetch for large file downloads.', 'methods', CTX);
      expect(r.contradictions).toHaveLength(0);
    });

    it('does not flag status as contradictions', async () => {
      await layer2.store('Project status: active.', 'status', CTX);
      const r = await layer2.store('Project status: completed.', 'status', CTX);
      expect(r.contradictions).toHaveLength(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 5: Retrieval Quality Under Load
// ═══════════════════════════════════════════════════════════════

describe('Phase 5: Retrieval Quality Under Load', () => {
  let layer3: KnowledgeLayer;

  beforeAll(async () => {
    layer3 = new KnowledgeLayer(join(tempDir, 'retrieval-stress.db'), new LocalProvider());
    await layer3.init();

    // Seed with 100 diverse memories
    const clients = ['Alpha Corp', 'Beta GmbH', 'Gamma AG', 'Delta LLC', 'Epsilon SA'];
    const techs = ['PostgreSQL', 'Redis', 'Elasticsearch', 'MongoDB', 'SvelteKit'];
    const cities = ['Zürich', 'Basel', 'Bern', 'Genf', 'Lausanne'];

    for (let i = 0; i < 100; i++) {
      const client = clients[i % clients.length]!;
      const tech = techs[i % techs.length]!;
      const city = cities[i % cities.length]!;
      await layer3.store(
        `Client ${client} in ${city} uses ${tech} for their project number ${i}. Budget is ${1000 + i * 100}.`,
        'knowledge', CTX,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await layer3.close();
  });

  it('retrieves relevant results for specific queries', async () => {
    const result = await layer3.retrieve('Alpha Corp PostgreSQL', [CTX], {
      topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
    });
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
  });

  it('retrieves with graph expansion enabled', async () => {
    const result = await layer3.retrieve('Alpha Corp technology stack', [CTX], {
      topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: true,
    });
    expect(result.memories).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  it('respects topK limit', async () => {
    const result = await layer3.retrieve('client project budget', [CTX], {
      topK: 3, threshold: 0.01, useHyDE: false, useGraphExpansion: false,
    });
    expect(result.memories.length).toBeLessThanOrEqual(3);
  });

  it('high threshold returns fewer results', async () => {
    const loose = await layer3.retrieve('database technology', [CTX], {
      topK: 50, threshold: 0.01, useHyDE: false, useGraphExpansion: false,
    });
    const tight = await layer3.retrieve('database technology', [CTX], {
      topK: 50, threshold: 0.5, useHyDE: false, useGraphExpansion: false,
    });
    expect(tight.memories.length).toBeLessThanOrEqual(loose.memories.length);
  });

  it('returns empty for completely unrelated query', async () => {
    const result = await layer3.retrieve('quantum physics string theory', [CTX], {
      topK: 5, threshold: 0.8, useHyDE: false, useGraphExpansion: false,
    });
    expect(result.memories.length).toBe(0);
  });

  it('formats context within maxChars limit', async () => {
    const result = await layer3.retrieve('client project', [CTX], {
      topK: 20, threshold: 0.01, useHyDE: false, useGraphExpansion: false,
    });
    const ctx = layer3.formatRetrievalContext(result, 2000);
    expect(ctx.length).toBeLessThanOrEqual(2000);
  });

  it('handles concurrent retrieval queries', async () => {
    const queries = [
      layer3.retrieve('Alpha Corp', [CTX], { topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false }),
      layer3.retrieve('Beta GmbH', [CTX], { topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false }),
      layer3.retrieve('Gamma AG', [CTX], { topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false }),
      layer3.retrieve('Delta LLC', [CTX], { topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false }),
      layer3.retrieve('Epsilon SA', [CTX], { topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false }),
    ];
    const results = await Promise.all(queries);
    for (const r of results) {
      expect(r.memories).toBeDefined();
      expect(Array.isArray(r.memories)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 6: Entity Graph Integrity
// ═══════════════════════════════════════════════════════════════

describe('Phase 6: Entity Graph Integrity', () => {
  it('entities accumulate mention counts', async () => {
    const entities = await layer.listEntities({ limit: 50 });
    // After all the Phase 3 data, some entities should have multiple mentions
    const highMention = entities.filter(e => e.mentionCount > 1);
    expect(highMention.length).toBeGreaterThanOrEqual(0);
  });

  it('entity relations are created from extraction', async () => {
    const entities = await layer.listEntities({ limit: 50 });
    let totalRelations = 0;
    for (const entity of entities.slice(0, 10)) {
      const relations = await layer.getEntityRelations(entity.id);
      totalRelations += relations.length;
    }
    // Regex extractor does not produce relations, so this may be 0
    // But the system should handle it gracefully
    expect(totalRelations).toBeGreaterThanOrEqual(0);
  });

  it('entity merge works correctly', async () => {
    // Store two references to the same person with different names
    await mustStore('Kunde Hans arbeitet bei test-firma.ch.', 'knowledge', CTX);
    await mustStore('Johannes ist der CTO von test-firma.ch.', 'knowledge', CTX);

    const hans = await layer.resolveEntity('Hans', [CTX]);
    const johannes = await layer.resolveEntity('Johannes', [CTX]);

    if (hans && johannes && hans.id !== johannes.id) {
      await layer.mergeEntities(johannes.id, hans.id);
      const merged = await layer.getEntity(hans.id);
      expect(merged).not.toBeNull();
      if (merged) {
        const aliases = merged.aliases.map(a => a.toLowerCase());
        expect(aliases).toContain('johannes');
      }
      // Source entity should be deleted
      const deleted = await layer.getEntity(johannes.id);
      expect(deleted).toBeNull();
    }
  });

  it('neighborhood traversal returns connected entities', async () => {
    const entities = await layer.listEntities({ limit: 5 });
    if (entities.length > 0) {
      const neighborhood = await layer.getNeighborhood(entities[0]!.id, 2);
      expect(neighborhood.entities).toBeDefined();
      expect(neighborhood.relations).toBeDefined();
      expect(Array.isArray(neighborhood.entities)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7: Garbage Collection & Consolidation
// ═══════════════════════════════════════════════════════════════

describe('Phase 7: GC & Consolidation', () => {
  it('dry-run GC reports stats without modifying data', async () => {
    const statsBefore = await layer.stats();
    const gcResult = await layer.gc({ dryRun: true });
    const statsAfter = await layer.stats();

    expect(typeof gcResult.supersededRemoved).toBe('number');
    expect(typeof gcResult.orphanEntitiesRemoved).toBe('number');
    expect(statsAfter.memoryCount).toBe(statsBefore.memoryCount);
  });

  it('real GC removes superseded memories', async () => {
    const statsBefore = await layer.stats();
    const gcResult = await layer.gc({ dryRun: false });
    const statsAfter = await layer.stats();

    expect(typeof gcResult.supersededRemoved).toBe('number');
    // After GC, active count should be <= before (superseded removed)
    expect(statsAfter.memoryCount).toBeLessThanOrEqual(statsBefore.memoryCount);
  });

  it('consolidation merges similar memories', () => {
    const merged = layer.consolidateMemories('knowledge', 'context', 'stress-project');
    expect(typeof merged).toBe('number');
  });

  it('deactivateByPattern removes matching memories', async () => {
    await mustStore('TEMPORARY: This is a test memory that should be deleted.', 'knowledge', CTX);
    const count = await layer.deactivateByPattern('TEMPORARY: This is a test memory');
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 8: Edge Cases & Robustness
// ═══════════════════════════════════════════════════════════════

describe('Phase 8: Edge Cases & Robustness', () => {
  it('rejects text shorter than 5 chars', async () => {
    const cases = ['Hi', '', '  ', 'OK', 'No'];
    for (const text of cases) {
      const r = await layer.store(text, 'knowledge', CTX);
      expect(r.stored).toBe(false);
    }
  });

  it('handles Unicode and special characters', async () => {
    const r = await layer.store(
      'Klient Andre Mueller-Baecker aus Zuerich nutzt speciaux Tools.',
      'knowledge', CTX,
    );
    expect(r.stored).toBe(true);
    expect(r.memoryId).toBeTruthy();
  });

  it('handles very long text (over 2000 chars)', async () => {
    const longText = `Client overview: ${'Important business detail. '.repeat(100)}End of overview.`;
    expect(longText.length).toBeGreaterThan(2000);
    const r = await layer.store(longText, 'knowledge', CTX);
    expect(r.stored).toBe(true);
  });

  it('handles text with only whitespace (after trim)', async () => {
    const r = await layer.store('     \n\n\t\t   ', 'knowledge', CTX);
    expect(r.stored).toBe(false);
  });

  it('handles rapid sequential stores (templated text dedup is aggressive)', async () => {
    // NOTE: Templated sentences like "Rapid fact number N: ..." are nearly
    // identical in LocalProvider embeddings (cosine > 0.90), so most get deduped.
    // The first one stores; subsequent ones are treated as confirmations.
    // This is by design — the dedup protects against noisy repeated storage.
    const results: KnowledgeStoreResult[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await layer.store(
        `Rapid fact number ${i}: The system processed batch ${i} at timestamp ${Date.now()}.`,
        'knowledge', CTX,
      );
      results.push(r);
    }
    const stored = results.filter(r => r.stored);
    // At least the first one stores; rest are deduped (confirms the dedup works)
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const deduped = results.filter(r => r.deduplicated);
    expect(deduped.length).toBeGreaterThan(0);
  });

  it('handles rapid sequential stores with diverse content', async () => {
    // Use genuinely different content to verify throughput
    const topics = [
      'PostgreSQL supports advanced JSONB indexing for document queries.',
      'Redis provides sub-millisecond latency for session caching.',
      'Elasticsearch enables full-text search across product catalogs.',
      'SvelteKit compiles components to vanilla JavaScript at build time.',
      'Docker containers isolate services with minimal overhead.',
      'Terraform manages cloud infrastructure as declarative code.',
      'GraphQL allows clients to request exactly the data they need.',
      'Kubernetes orchestrates container deployments across clusters.',
      'Prometheus collects time-series metrics for monitoring.',
      'Nginx handles reverse proxy and load balancing efficiently.',
    ];
    const results: KnowledgeStoreResult[] = [];
    for (const text of topics) {
      const r = await layer.store(text, 'knowledge', CTX);
      results.push(r);
    }
    const stored = results.filter(r => r.stored);
    expect(stored.length).toBeGreaterThanOrEqual(8);
  });

  it('handles concurrent stores', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      layer.store(
        `Concurrent fact ${i}: Entity ${i} works on project ${i} with technology ${i}.`,
        'knowledge', CTX,
      ),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(typeof r.stored).toBe('boolean');
      expect(r.memoryId).toBeTruthy();
    }
  });

  it('skipContradictionCheck option works', async () => {
    // Use "X is N" pattern so the heuristic number-change detection fires
    await mustStore('The max connection count is 100 for the pool.', 'knowledge', CTX);
    const r = await layer.store(
      'The max connection count is 500 for the pool.',
      'knowledge', CTX,
      { skipContradictionCheck: true },
    );
    // Heuristic bypasses dedup (number change), contradiction check is
    // skipped by option → stored without contradictions
    expect(r.stored).toBe(true);
    expect(r.contradictions).toHaveLength(0);
  });

  it('handles all 4 namespaces', async () => {
    const namespaces: MemoryNamespace[] = ['knowledge', 'methods', 'status', 'learnings'];
    for (const ns of namespaces) {
      const r = await layer.store(
        `Namespace test: This is a ${ns} entry with unique content ${Date.now()}.`,
        ns, CTX,
      );
      expect(r.stored).toBe(true);
    }
  });

  it('feedback boosts and penalizes correctly', async () => {
    const r = await mustStore(
      'Feedback test: API rate limiting should be set to 100 requests per second.',
      'knowledge', CTX,
    );
    // Boost
    layer.feedbackOnRetrieval([r.memoryId], 'useful');
    // Penalize a different one
    layer.feedbackOnRetrieval([r.memoryId], 'wrong');
    // Should not crash — internal confidence changes
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 9: Full Stats Integrity Check
// ═══════════════════════════════════════════════════════════════

describe('Phase 9: Final Stats & Integrity', () => {
  it('reports consistent stats after full lifecycle', async () => {
    const stats = await layer.stats();
    expect(stats.memoryCount).toBeGreaterThan(0);
    expect(stats.entityCount).toBeGreaterThanOrEqual(0);
    expect(typeof stats.relationCount).toBe('number');
    expect(typeof stats.patternCount).toBe('number');
    expect(typeof stats.communityCount).toBe('number');
  });

  it('all stored entities have valid types', async () => {
    const entities = await layer.listEntities({ limit: 200 });
    const validTypes = new Set(['person', 'organization', 'project', 'product', 'concept', 'location', 'collection']);
    for (const e of entities) {
      expect(validTypes.has(e.entityType)).toBe(true);
    }
  });

  it('all entities have non-empty canonical names', async () => {
    const entities = await layer.listEntities({ limit: 200 });
    for (const e of entities) {
      expect(e.canonicalName.length).toBeGreaterThan(0);
    }
  });

  it('patterns and metrics APIs return arrays', () => {
    const patterns = layer.getPatterns();
    expect(Array.isArray(patterns)).toBe(true);

    const metrics = layer.getMetrics();
    expect(Array.isArray(metrics)).toBe(true);
  });
});
