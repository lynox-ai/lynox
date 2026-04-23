#!/usr/bin/env npx tsx
/**
 * Eval harness for entity-extractor-v2.
 *
 * Runs the v2 extractor against hand-labeled fixtures and reports
 * precision, recall, F1, and type-accuracy per entity type + overall.
 *
 * Usage:
 *   npx tsx scripts/kg-eval/run-eval.ts                      # all fixtures
 *   npx tsx scripts/kg-eval/run-eval.ts --ids adv-01,pos-03   # subset
 *   npx tsx scripts/kg-eval/run-eval.ts --json report.json    # write JSON report
 *
 * Reads ANTHROPIC_API_KEY from env or ~/.lynox/config.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import {
  extractEntitiesV2,
  resetV2ExtractionCount,
  type ExtractedEntityV2,
  type ExtractedRelationV2,
} from '../../src/core/entity-extractor-v2.js';
import type { EntityType } from '../../src/types/index.js';

interface ExpectedEntity {
  canonical_name: string;
  type: EntityType;
  acceptable_aliases?: string[];
}

interface ExpectedRelation {
  subject: string;
  predicate: string;
  object: string;
}

interface FixtureCase {
  id: string;
  category: string;
  text: string;
  expected_entities: ExpectedEntity[];
  expected_relations: ExpectedRelation[];
}

interface FixtureFile {
  version: number;
  description: string;
  cases: FixtureCase[];
}

interface CaseResult {
  id: string;
  category: string;
  text: string;
  tp: number;
  fp: number;
  fn: number;
  typeErrors: number;
  falsePositives: Array<{ name: string; type: string }>;
  falseNegatives: ExpectedEntity[];
  typeMismatches: Array<{ name: string; expected: string; got: string }>;
  extractedEntities: ExtractedEntityV2[];
  extractedRelations: ExtractedRelationV2[];
  expectedRelations: ExpectedRelation[];
  relationTp: number;
  relationFp: number;
  relationFn: number;
  elapsedMs: number;
}

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

function parseArgs(argv: string[]): { ids?: Set<string>; jsonOut?: string } {
  const result: { ids?: Set<string>; jsonOut?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ids' && argv[i + 1]) {
      result.ids = new Set(argv[++i]!.split(',').map(s => s.trim()));
    } else if (arg === '--json' && argv[i + 1]) {
      result.jsonOut = argv[++i]!;
    }
  }
  return result;
}

/** Normalize a name for matching (lowercase + collapsed whitespace). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if an extracted entity matches an expected entity.
 * Match rule: extractor's canonical_name OR any alias matches the expected
 * canonical_name OR any acceptable_alias — and type matches.
 */
function entityMatches(extracted: ExtractedEntityV2, expected: ExpectedEntity): {
  nameMatches: boolean;
  typeMatches: boolean;
} {
  const extNames = [extracted.canonicalName, ...extracted.aliases].map(norm);
  const expNames = [expected.canonical_name, ...(expected.acceptable_aliases ?? [])].map(norm);
  const nameMatches = extNames.some(n => expNames.includes(n));
  const typeMatches = extracted.type === expected.type;
  return { nameMatches, typeMatches };
}

/** Score one case: TP / FP / FN / type-errors and relation metrics. */
function scoreCase(
  c: FixtureCase,
  extraction: { entities: ExtractedEntityV2[]; relations: ExtractedRelationV2[] },
  elapsedMs: number,
): CaseResult {
  const matchedExpected = new Set<number>();
  const matchedExtracted = new Set<number>();
  let typeErrors = 0;
  const typeMismatches: Array<{ name: string; expected: string; got: string }> = [];

  for (let ei = 0; ei < extraction.entities.length; ei++) {
    const ext = extraction.entities[ei]!;
    for (let xi = 0; xi < c.expected_entities.length; xi++) {
      if (matchedExpected.has(xi)) continue;
      const exp = c.expected_entities[xi]!;
      const { nameMatches, typeMatches } = entityMatches(ext, exp);
      if (nameMatches && typeMatches) {
        matchedExpected.add(xi);
        matchedExtracted.add(ei);
        break;
      } else if (nameMatches && !typeMatches) {
        typeErrors++;
        typeMismatches.push({
          name: ext.canonicalName,
          expected: exp.type,
          got: ext.type,
        });
        matchedExpected.add(xi);
        matchedExtracted.add(ei);
        break;
      }
    }
  }

  const tp = matchedExtracted.size - typeErrors;
  const fp = extraction.entities.length - matchedExtracted.size;
  const fn = c.expected_entities.length - matchedExpected.size;

  const falsePositives: Array<{ name: string; type: string }> = [];
  for (let ei = 0; ei < extraction.entities.length; ei++) {
    if (!matchedExtracted.has(ei)) {
      const e = extraction.entities[ei]!;
      falsePositives.push({ name: e.canonicalName, type: e.type });
    }
  }

  const falseNegatives: ExpectedEntity[] = [];
  for (let xi = 0; xi < c.expected_entities.length; xi++) {
    if (!matchedExpected.has(xi)) falseNegatives.push(c.expected_entities[xi]!);
  }

  // Relations: match only if subject + predicate + object all match (case-insensitive)
  const expRelNorm = c.expected_relations.map(r => ({
    subject: norm(r.subject), predicate: r.predicate, object: norm(r.object),
  }));
  const extRelNorm = extraction.relations.map(r => ({
    subject: norm(r.subject), predicate: r.predicate, object: norm(r.object),
  }));
  const matchedExpRel = new Set<number>();
  const matchedExtRel = new Set<number>();
  for (let ri = 0; ri < extRelNorm.length; ri++) {
    const r = extRelNorm[ri]!;
    for (let xi = 0; xi < expRelNorm.length; xi++) {
      if (matchedExpRel.has(xi)) continue;
      const x = expRelNorm[xi]!;
      if (r.subject === x.subject && r.predicate === x.predicate && r.object === x.object) {
        matchedExpRel.add(xi);
        matchedExtRel.add(ri);
        break;
      }
    }
  }
  const relationTp = matchedExtRel.size;
  const relationFp = extRelNorm.length - relationTp;
  const relationFn = expRelNorm.length - matchedExpRel.size;

  return {
    id: c.id, category: c.category, text: c.text,
    tp, fp, fn, typeErrors,
    falsePositives, falseNegatives, typeMismatches,
    extractedEntities: extraction.entities,
    extractedRelations: extraction.relations,
    expectedRelations: c.expected_relations,
    relationTp, relationFp, relationFn,
    elapsedMs,
  };
}

function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function fmt(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function printReport(results: CaseResult[]): void {
  const total = { tp: 0, fp: 0, fn: 0, typeErrors: 0, relTp: 0, relFp: 0, relFn: 0 };
  for (const r of results) {
    total.tp += r.tp; total.fp += r.fp; total.fn += r.fn;
    total.typeErrors += r.typeErrors;
    total.relTp += r.relationTp; total.relFp += r.relationFp; total.relFn += r.relationFn;
  }

  const precision = total.tp / (total.tp + total.fp || 1);
  const recall = total.tp / (total.tp + total.fn || 1);
  const f1Score = f1(precision, recall);
  const typeAcc = total.tp / (total.tp + total.typeErrors || 1);

  const relPrec = total.relTp / (total.relTp + total.relFp || 1);
  const relRec = total.relTp / (total.relTp + total.relFn || 1);

  console.log('\n=== Eval Report ===\n');
  console.log(`Cases: ${results.length}`);
  console.log(`Avg latency: ${(results.reduce((s, r) => s + r.elapsedMs, 0) / results.length).toFixed(0)}ms`);
  console.log('');
  console.log('Entities:');
  console.log(`  TP: ${total.tp}  FP: ${total.fp}  FN: ${total.fn}  TypeErr: ${total.typeErrors}`);
  console.log(`  Precision:     ${fmt(precision)}  (target ≥ 92.0%)`);
  console.log(`  Recall:        ${fmt(recall)}  (target ≥ 75.0%)`);
  console.log(`  F1:            ${fmt(f1Score)}`);
  console.log(`  Type-Accuracy: ${fmt(typeAcc)}  (target ≥ 90.0%)`);
  console.log('');
  console.log('Relations:');
  console.log(`  TP: ${total.relTp}  FP: ${total.relFp}  FN: ${total.relFn}`);
  console.log(`  Precision: ${fmt(relPrec)}  Recall: ${fmt(relRec)}`);
  console.log('');

  const failures = results.filter(r => r.fp > 0 || r.fn > 0 || r.typeErrors > 0);
  if (failures.length > 0) {
    console.log(`=== ${failures.length} case(s) with issues ===\n`);
    for (const r of failures) {
      console.log(`[${r.id}] (${r.category})`);
      console.log(`  text: ${r.text}`);
      if (r.falsePositives.length > 0) {
        console.log(`  FP:   ${r.falsePositives.map(e => `"${e.name}"(${e.type})`).join(', ')}`);
      }
      if (r.falseNegatives.length > 0) {
        console.log(`  FN:   ${r.falseNegatives.map(e => `"${e.canonical_name}"(${e.type})`).join(', ')}`);
      }
      if (r.typeMismatches.length > 0) {
        console.log(`  Type: ${r.typeMismatches.map(m => `"${m.name}" ${m.expected}→${m.got}`).join(', ')}`);
      }
      console.log('');
    }
  } else {
    console.log('All cases pass.\n');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const seedPath = join(__dirname, 'fixtures.json');
  const genPath = join(__dirname, 'fixtures-generated.json');

  const allCases: FixtureCase[] = [];
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as FixtureFile;
  allCases.push(...seed.cases);

  try {
    const gen = JSON.parse(readFileSync(genPath, 'utf8')) as FixtureFile;
    allCases.push(...gen.cases);
  } catch { /* no generated fixtures yet */ }

  const cases = args.ids
    ? allCases.filter(c => args.ids!.has(c.id))
    : allCases;

  if (cases.length === 0) {
    console.error('No cases matched.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: getApiKey() });
  const results: CaseResult[] = [];

  console.log(`Running ${cases.length} case(s) against entity-extractor-v2...\n`);

  for (const c of cases) {
    resetV2ExtractionCount();
    const start = Date.now();
    const extraction = await extractEntitiesV2(c.text, client);
    const elapsedMs = Date.now() - start;
    const result = scoreCase(c, extraction, elapsedMs);
    results.push(result);
    const mark = (result.fp === 0 && result.fn === 0 && result.typeErrors === 0) ? '✓' : '✗';
    process.stdout.write(`${mark} ${c.id} (${elapsedMs}ms)\n`);
  }

  printReport(results);

  if (args.jsonOut) {
    writeFileSync(args.jsonOut, JSON.stringify({ results }, null, 2));
    console.log(`JSON report written to ${args.jsonOut}`);
  }

  const hasFailures = results.some(r => r.fp > 0 || r.fn > 0 || r.typeErrors > 0);
  process.exit(hasFailures ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
