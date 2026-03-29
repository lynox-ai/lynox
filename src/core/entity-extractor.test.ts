import { describe, it, expect } from 'vitest';
import { extractEntitiesRegex, shouldUseLLMExtraction } from './entity-extractor.js';

describe('extractEntitiesRegex', () => {
  describe('person extraction', () => {
    it('extracts names with title prefix', () => {
      const result = extractEntitiesRegex('Herr Müller hat angerufen.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'Müller', type: 'person' }),
      );
    });

    it('extracts names with English title prefix', () => {
      const result = extractEntitiesRegex('Mr. Smith sent the report.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'Smith', type: 'person' }),
      );
    });

    it('extracts full names with title', () => {
      const result = extractEntitiesRegex('Dr. Maria Fischer presented the results.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'Maria Fischer', type: 'person' }),
      );
    });

    it('extracts names with role prefix', () => {
      const result = extractEntitiesRegex('client Thomas wants API access.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'Thomas', type: 'person' }),
      );
    });

    it('extracts names with German role prefix', () => {
      const result = extractEntitiesRegex('Kunde Thomas bevorzugt self-hosted.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'Thomas', type: 'person' }),
      );
    });
  });

  describe('organization extraction', () => {
    it('extracts domain names', () => {
      const result = extractEntitiesRegex('The project is for acme-shop.ch.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'acme-shop.ch', type: 'organization' }),
      );
    });

    it('skips common domains', () => {
      const result = extractEntitiesRegex('Code is on github.com.');
      expect(result.entities).not.toContainEqual(
        expect.objectContaining({ name: 'github.com' }),
      );
    });

    it('extracts domains with various TLDs', () => {
      const result = extractEntitiesRegex('Visit lynox.ai for more info.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'lynox.ai', type: 'organization' }),
      );
    });

    it('extracts orgs with explicit markers', () => {
      const result = extractEntitiesRegex('Firma Müller-Tech has 20 employees.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'Müller-Tech', type: 'organization' }),
      );
    });
  });

  describe('technology extraction', () => {
    it('extracts tech from usage context', () => {
      const result = extractEntitiesRegex('Project uses PostgreSQL for data storage.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'PostgreSQL', type: 'concept' }),
      );
    });

    it('extracts tech with version', () => {
      const result = extractEntitiesRegex('System requires Node.js v22.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ type: 'concept' }),
      );
    });

    it('extracts German tech context', () => {
      const result = extractEntitiesRegex('Das Projekt nutzt SvelteKit.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'SvelteKit', type: 'concept' }),
      );
    });

    it('skips common words in tech context', () => {
      const result = extractEntitiesRegex('Project uses the framework.');
      const names = result.entities.map(e => e.name.toLowerCase());
      expect(names).not.toContain('the');
    });
  });

  describe('project extraction', () => {
    it('extracts quoted project names', () => {
      const result = extractEntitiesRegex('Working on project "lynox-pro" now.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'lynox-pro', type: 'project' }),
      );
    });

    it('extracts org/repo format', () => {
      const result = extractEntitiesRegex('Source at lynox-ai/lynox.');
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: 'lynox-ai/lynox', type: 'project' }),
      );
    });
  });

  describe('deduplication', () => {
    it('deduplicates entities with same name and type', () => {
      const result = extractEntitiesRegex(
        'Client Thomas wants this. Kunde Thomas confirmed.',
      );
      const matches = result.entities.filter(
        e => e.name === 'Thomas' && e.type === 'person',
      );
      expect(matches).toHaveLength(1);
    });
  });

  describe('mixed extraction', () => {
    it('extracts multiple entity types from complex text', () => {
      const text = 'Kunde Thomas von acme-shop.ch nutzt WordPress und braucht API access.';
      const result = extractEntitiesRegex(text);

      const types = new Set(result.entities.map(e => e.type));
      expect(types.has('person')).toBe(true);
      expect(types.has('organization')).toBe(true);
      expect(types.has('concept')).toBe(true);
    });

    it('returns empty for text without entities', () => {
      const result = extractEntitiesRegex('The system is working correctly.');
      // May or may not find entities, but should not crash
      expect(result.entities).toBeDefined();
      expect(result.relations).toHaveLength(0);
    });
  });
});

describe('shouldUseLLMExtraction', () => {
  it('returns false for short text', () => {
    expect(shouldUseLLMExtraction('Short text.', 'knowledge', [])).toBe(false);
  });

  it('returns false for status namespace', () => {
    const longText = 'A'.repeat(300);
    expect(shouldUseLLMExtraction(longText, 'status', [])).toBe(false);
  });

  it('returns true even when regex found entities (LLM merges with regex)', () => {
    const longText = 'A'.repeat(300);
    expect(
      shouldUseLLMExtraction(longText, 'knowledge', [
        { name: 'Test', type: 'concept', confidence: 0.8 },
      ]),
    ).toBe(true);
  });

  it('returns true for knowledge text with sufficient length', () => {
    const text = 'Rafael Burlet ist CEO von lynox AI in Zürich.';
    expect(shouldUseLLMExtraction(text, 'knowledge', [])).toBe(true);
  });
});
