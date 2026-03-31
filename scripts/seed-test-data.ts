#!/usr/bin/env npx tsx
/**
 * Seed Test Data — Floods all 3 lynox databases with realistic data
 * simulating ~90 days of business usage for lifecycle debugging.
 *
 * Usage:  cd core && npx tsx scripts/seed-test-data.ts [--clean]
 *
 * --clean: Wipe existing data before seeding (backs up first)
 * Default: Appends to existing data (still backs up)
 *
 * Databases: agent-memory.db, history.db, datastore.db
 */

import { AgentMemoryDb } from '../src/core/agent-memory-db.js';
import { RunHistory } from '../src/core/run-history.js';
import { DataStore } from '../src/core/data-store.js';
import { PatternEngine } from '../src/core/pattern-engine.js';
import { ThreadStore } from '../src/core/thread-store.js';
import { CRM } from '../src/core/crm.js';
import { embedToBlob } from '../src/core/embedding.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { copyFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ── Config ──────────────────────────────────────────────────────

const LYNOX_DIR = join(homedir(), '.lynox');
const CLEAN = process.argv.includes('--clean');
const EMBEDDING_DIM = 384;
const NOW = new Date();
const DAY_MS = 86_400_000;
const CONTEXT_ID = 'seed-ctx-novatech';
const SCOPE_TYPE = 'context';
const SCOPE_ID = CONTEXT_ID;

// ── Helpers ─────────────────────────────────────────────────────

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Generate a normalized random embedding vector of given dimensions. */
function randomEmbedding(dim = EMBEDDING_DIM): number[] {
  const vec: number[] = [];
  let mag = 0;
  for (let i = 0; i < dim; i++) {
    const v = Math.random() * 2 - 1;
    vec.push(v);
    mag += v * v;
  }
  mag = Math.sqrt(mag) || 1;
  return vec.map(v => v / mag);
}

/** Deterministic embedding from text (like LocalProvider). */
function textEmbedding(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Float64Array(dim);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    for (let j = 0; j < word.length; j++) {
      const charCode = word.charCodeAt(j);
      const idx = (charCode * 31 + j * 17 + i * 7) % dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
  }
  let magnitude = 0;
  for (let i = 0; i < dim; i++) magnitude += (vec[i] ?? 0) ** 2;
  magnitude = Math.sqrt(magnitude) || 1;
  return Array.from(vec, v => v / magnitude);
}

// ── Backup ──────────────────────────────────────────────────────

function backupDatabases(): void {
  const timestamp = NOW.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const name of ['agent-memory.db', 'history.db', 'datastore.db']) {
    const src = join(LYNOX_DIR, name);
    if (existsSync(src)) {
      const dest = join(LYNOX_DIR, `${name}.backup-${timestamp}`);
      copyFileSync(src, dest);
      console.log(`  ✓ Backed up ${name} → ${dest.split('/').pop()}`);
    }
  }
}

// ── Data Definitions ────────────────────────────────────────────

const PEOPLE = [
  { name: 'Marcus Weber', type: 'person', desc: 'CEO & Founder of NovaTech', aliases: ['Marcus', 'M. Weber'] },
  { name: 'Sarah Chen', type: 'person', desc: 'CTO at NovaTech', aliases: ['Sarah', 'S. Chen'] },
  { name: 'Tom Richter', type: 'person', desc: 'Head of Sales', aliases: ['Tom', 'Richter'] },
  { name: 'Lisa Hoffmann', type: 'person', desc: 'Marketing Lead', aliases: ['Lisa', 'L. Hoffmann'] },
  { name: 'Jan Krüger', type: 'person', desc: 'Senior Developer', aliases: ['Jan', 'J. Krüger'] },
  { name: 'Elena Petrov', type: 'person', desc: 'Product Manager', aliases: ['Elena', 'E. Petrov'] },
  { name: 'David Park', type: 'person', desc: 'UX Designer', aliases: ['David', 'D. Park'] },
  { name: 'Anna Müller', type: 'person', desc: 'Customer Success Manager', aliases: ['Anna', 'A. Müller'] },
  { name: 'Michael Torres', type: 'person', desc: 'Freelance consultant', aliases: ['Michael', 'Torres'] },
  { name: 'Sophie Laurent', type: 'person', desc: 'Investor, Horizon Ventures', aliases: ['Sophie', 'S. Laurent'] },
  { name: 'Kai Yamamoto', type: 'person', desc: 'Enterprise client contact', aliases: ['Kai', 'K. Yamamoto'] },
  { name: 'Natasha Volkov', type: 'person', desc: 'Partner at DigitalBridge Agency', aliases: ['Natasha', 'N. Volkov'] },
  { name: 'Oliver Braun', type: 'person', desc: 'DevOps Engineer', aliases: ['Oliver', 'O. Braun'] },
  { name: 'Maria Santos', type: 'person', desc: 'Data Analyst', aliases: ['Maria', 'M. Santos'] },
  { name: 'Felix Neumann', type: 'person', desc: 'Support Engineer', aliases: ['Felix', 'F. Neumann'] },
] as const;

const ORGANIZATIONS = [
  { name: 'NovaTech GmbH', type: 'organization', desc: 'B2B SaaS company, the primary business', aliases: ['NovaTech', 'NT'] },
  { name: 'Horizon Ventures', type: 'organization', desc: 'Series A investor', aliases: ['Horizon', 'HV'] },
  { name: 'DigitalBridge Agency', type: 'organization', desc: 'Marketing partner agency', aliases: ['DigitalBridge', 'DB Agency'] },
  { name: 'CloudScale Inc.', type: 'organization', desc: 'Cloud infrastructure provider', aliases: ['CloudScale', 'CS'] },
  { name: 'TechFlow Solutions', type: 'organization', desc: 'Integration partner', aliases: ['TechFlow', 'TFS'] },
  { name: 'DataVault Corp', type: 'organization', desc: 'Enterprise customer (Fortune 500)', aliases: ['DataVault', 'DV'] },
  { name: 'GreenLeaf Retail', type: 'organization', desc: 'E-commerce customer', aliases: ['GreenLeaf', 'GL'] },
  { name: 'MedTech Pro', type: 'organization', desc: 'Healthcare SaaS customer', aliases: ['MedTech', 'MT'] },
  { name: 'FinanceHub AG', type: 'organization', desc: 'Fintech customer', aliases: ['FinanceHub', 'FH'] },
  { name: 'EduSpark', type: 'organization', desc: 'EdTech startup prospect', aliases: ['EduSpark', 'ES'] },
] as const;

const PRODUCTS = [
  { name: 'NovaPlatform', type: 'product', desc: 'Core SaaS platform', aliases: ['Nova', 'the platform'] },
  { name: 'NovaAPI', type: 'product', desc: 'REST API product tier', aliases: ['API tier', 'Nova API'] },
  { name: 'NovaConnect', type: 'product', desc: 'Integration middleware', aliases: ['Connect', 'Nova Connect'] },
  { name: 'NovaDash', type: 'product', desc: 'Analytics dashboard add-on', aliases: ['Dashboard', 'Nova Dash'] },
  { name: 'NovaMobile', type: 'product', desc: 'Mobile companion app', aliases: ['Mobile app', 'Nova Mobile'] },
] as const;

const PROJECTS = [
  { name: 'Q1 Product Launch', type: 'project', desc: 'NovaPlatform v2.0 release campaign', aliases: ['Q1 launch', 'v2 launch'] },
  { name: 'Enterprise Onboarding', type: 'project', desc: 'White-glove onboarding for DataVault', aliases: ['DV onboarding', 'enterprise onboard'] },
  { name: 'API Redesign', type: 'project', desc: 'REST → GraphQL migration', aliases: ['API v3', 'GraphQL migration'] },
  { name: 'GDPR Compliance Audit', type: 'project', desc: 'Annual compliance review', aliases: ['GDPR audit', 'compliance'] },
  { name: 'Series A Fundraise', type: 'project', desc: 'Raising €5M Series A', aliases: ['Series A', 'fundraise'] },
  { name: 'Marketing Rebrand', type: 'project', desc: 'Brand refresh and website redesign', aliases: ['rebrand', 'brand refresh'] },
  { name: 'Performance Sprint', type: 'project', desc: 'Reduce p95 latency below 200ms', aliases: ['perf sprint', 'latency fix'] },
  { name: 'Mobile MVP', type: 'project', desc: 'First release of NovaMobile', aliases: ['mobile v1', 'mobile MVP'] },
] as const;

const CONCEPTS = [
  { name: 'TypeScript', type: 'concept', desc: 'Primary programming language', aliases: ['TS', 'typescript'] },
  { name: 'PostgreSQL', type: 'concept', desc: 'Primary database', aliases: ['Postgres', 'PG'] },
  { name: 'GraphQL', type: 'concept', desc: 'API query language', aliases: ['GQL', 'graphql'] },
  { name: 'Kubernetes', type: 'concept', desc: 'Container orchestration', aliases: ['K8s', 'k8s'] },
  { name: 'OAuth2', type: 'concept', desc: 'Auth protocol', aliases: ['OAuth', 'oauth2'] },
  { name: 'Stripe', type: 'concept', desc: 'Payment processing', aliases: ['stripe'] },
  { name: 'Product-Led Growth', type: 'concept', desc: 'Go-to-market strategy', aliases: ['PLG', 'product-led'] },
  { name: 'OKR Framework', type: 'concept', desc: 'Goal-setting methodology', aliases: ['OKRs', 'objectives'] },
  { name: 'CI/CD Pipeline', type: 'concept', desc: 'Continuous integration/deployment', aliases: ['CI/CD', 'pipeline'] },
  { name: 'Zero-Trust Security', type: 'concept', desc: 'Security architecture', aliases: ['zero-trust', 'ZT'] },
] as const;

const LOCATIONS = [
  { name: 'Berlin', type: 'location', desc: 'HQ location', aliases: ['Berlin HQ'] },
  { name: 'Munich', type: 'location', desc: 'Sales office', aliases: ['München', 'Munich office'] },
  { name: 'San Francisco', type: 'location', desc: 'US market', aliases: ['SF', 'Bay Area'] },
  { name: 'London', type: 'location', desc: 'UK/EU enterprise market', aliases: ['London office'] },
  { name: 'Singapore', type: 'location', desc: 'APAC expansion target', aliases: ['SG', 'APAC hub'] },
] as const;

// Memories spanning knowledge, methods, learnings, status
const KNOWLEDGE_MEMORIES = [
  // Business knowledge
  'NovaTech GmbH was founded in 2023 by Marcus Weber in Berlin. Initial focus was developer tools.',
  'Horizon Ventures led the seed round of €800K in June 2023. Sophie Laurent is the board observer.',
  'NovaPlatform v1.0 launched in September 2023 with 12 pilot customers.',
  'DataVault Corp signed a €120K/year enterprise contract in November 2023, our largest deal.',
  'GreenLeaf Retail uses NovaPlatform for inventory management and order tracking.',
  'Sarah Chen joined as CTO in January 2024, previously at CloudScale Inc.',
  'NovaTech has 18 employees as of March 2024. Engineering team is 9 people.',
  'MRR reached €45K in February 2024, up from €12K in September 2023.',
  'Tom Richter manages enterprise sales. His pipeline has 8 qualified leads worth €340K.',
  'FinanceHub AG is in final contract negotiations for a €85K/year deal.',
  'The API Redesign project started in January 2024 to migrate from REST to GraphQL.',
  'PostgreSQL 16 was chosen for its JSONB performance improvements and logical replication.',
  'NovaDash was launched as a paid add-on in December 2023. 40% of customers adopted it.',
  'CloudScale Inc. provides our infrastructure. Monthly cost is €3.2K for production.',
  'DigitalBridge Agency handles our content marketing. Monthly retainer is €4.5K.',
  'GDPR Compliance Audit scheduled for Q2 2024. External auditor is TÜV Rheinland.',
  'Customer churn rate is 3.2% monthly as of February 2024. Target is below 2%.',
  'NPS score is 42 (last measured January 2024). Enterprise customers score 62.',
  'Series A target is €5M at €25M pre-money valuation. Targeting close by June 2024.',
  'EduSpark expressed interest in NovaPlatform for their learning management system.',
  'Michael Torres consults on our go-to-market strategy. Engaged for 3 months.',
  'The Performance Sprint reduced p95 API latency from 450ms to 180ms.',
  'Mobile MVP is targeting a June 2024 launch for iOS and Android.',
  'Lisa Hoffmann runs the Marketing Rebrand project. New brand guidelines are ready.',
  'Oliver Braun set up the Kubernetes cluster on CloudScale with auto-scaling.',
  'Maria Santos built the analytics pipeline using NovaDash and custom SQL.',
  'Customer acquisition cost (CAC) is €2,400 per enterprise customer.',
  'Lifetime value (LTV) estimate is €36,000 per enterprise customer (3-year avg).',
  'LTV:CAC ratio is 15:1 which is excellent for B2B SaaS.',
  'TechFlow Solutions is our integration partner for Salesforce and HubSpot connectors.',
  'Felix Neumann handles tier-1 support. Average resolution time is 4.2 hours.',
  'We use Stripe for payment processing. PCI compliance is handled by Stripe.',
  'OAuth2 with PKCE is used for all API authentication.',
  'Zero-Trust Security model adopted after the Q4 2023 security review.',
  'CI/CD Pipeline runs on GitHub Actions. Average deploy time is 8 minutes.',
  'Jan Krüger leads the API Redesign. GraphQL schema is 80% complete.',
  'Elena Petrov manages the product roadmap. Q2 priorities are enterprise features.',
  'David Park designed the new NovaDash UI. User testing scores improved 35%.',
  'Anna Müller runs customer success. She manages 45 active accounts.',
  'The Singapore expansion is planned for Q3 2024. Kai Yamamoto is the local contact.',
  'Natasha Volkov from DigitalBridge proposed a joint webinar series.',
  'MedTech Pro uses NovaConnect for HL7 FHIR integration with hospital systems.',
  'Weekly team standup is Monday 9:30 AM CET. All-hands is first Friday of month.',
  'Engineering velocity: average 28 story points per sprint (2-week sprints).',
  'Tech debt ratio is estimated at 15%. Main areas: legacy REST endpoints and test coverage.',
];

const METHOD_MEMORIES = [
  'For enterprise demos, always start with the ROI calculator before showing features.',
  'Use the 5-step onboarding flow: intro call → sandbox setup → data import → training → go-live.',
  'When debugging API latency, check the PostgreSQL slow query log first (> 100ms threshold).',
  'For customer escalations, follow the HEAT method: Hear, Empathize, Apologize, Take action.',
  'Sprint planning uses Fibonacci estimation. Stories above 13 points should be split.',
  'Content marketing follows the hub-and-spoke model: 1 pillar post → 5 derivative pieces.',
  'Sales qualification uses BANT framework: Budget, Authority, Need, Timeline.',
  'Code reviews require 2 approvals for core modules, 1 for docs and tests.',
  'Incident response: P1 = 15min response, P2 = 1hr, P3 = 4hr, P4 = next business day.',
  'Database migrations always run in a transaction with rollback plan documented.',
  'Feature flags use LaunchDarkly. All new features are behind flags for 2 weeks.',
  'Monthly business review deck follows: metrics → pipeline → product → team → blockers.',
  'For investor updates, use the Sequoia memo format: problem, solution, traction, team.',
  'Customer health scoring: usage frequency (40%), support tickets (20%), NPS (20%), expansion (20%).',
  'Performance testing protocol: baseline → change → measure → compare (p50, p95, p99).',
];

const LEARNING_MEMORIES = [
  'Discovered that batch API calls reduce latency by 60% compared to individual requests.',
  'GraphQL subscriptions cause memory leaks in the current WebSocket implementation.',
  'Enterprise customers prefer PDF exports over CSV for compliance reporting.',
  'The Kubernetes HPA works best with CPU threshold at 70%, not the default 80%.',
  'Stripe webhook retries can cause duplicate payments if not handled idempotently.',
  'NPS surveys sent on Tuesdays get 40% higher response rate than Fridays.',
  'PostgreSQL VACUUM ANALYZE should run weekly on the events table (grows 2GB/month).',
  'The mobile WebView approach was abandoned in favor of React Native for better UX.',
  'Cold email outreach converts at 2.1% — warm intros convert at 12.4%.',
  'Adding a chatbot to the docs reduced support tickets by 25%.',
  'TypeScript strict mode caught 47 potential runtime errors during the migration.',
  'Feature flag rollout at 10% → 25% → 50% → 100% reduces blast radius significantly.',
  'Customer interviews revealed that the dashboard loading time is the #1 complaint.',
  'A/B testing showed the simplified pricing page increased conversions by 18%.',
  'The CI/CD pipeline was 40% faster after switching from Docker-in-Docker to Kaniko.',
];

const STATUS_MEMORIES = [
  'API Redesign is 80% complete. Remaining: subscription types and batch mutations.',
  'Series A fundraise: term sheet received from Horizon Ventures. Due diligence ongoing.',
  'GDPR audit preparation: 6 of 8 documentation items completed.',
  'Mobile MVP: iOS build is in TestFlight beta. Android is 2 weeks behind.',
  'Marketing Rebrand: new website is live. Social media assets are being updated.',
  'DataVault onboarding: data migration completed. Training sessions start next week.',
  'Performance Sprint: completed ahead of schedule. p95 at 180ms (target was 200ms).',
  'FinanceHub deal: legal review of contract terms. Expected close in 2 weeks.',
  'EduSpark evaluation: they requested a custom demo for their LMS use case.',
  'Kubernetes migration: production traffic fully on K8s. Old VM cluster decommissioned.',
  'Q1 OKRs: 4 of 6 key results on track. Churn reduction and mobile launch are behind.',
  'Hiring: 2 senior engineer positions open. 15 applications received, 4 in interview stage.',
  'Customer health: 3 accounts flagged as at-risk (low usage in last 30 days).',
  'Bug backlog: 12 open bugs, 3 critical (all in the billing module).',
  'Infrastructure costs: trending 8% over budget due to increased DataVault usage.',
];

const TOOLS = [
  'memory_store', 'memory_recall', 'write_file', 'read_file', 'bash',
  'web_search', 'data_store_create', 'data_store_insert', 'data_store_query',
  'ask_user', 'artifact_save', 'google_drive', 'send_email', 'calendar',
  'api_request', 'data_store_aggregate',
] as const;

const TASK_TEMPLATES = [
  'Summarize the latest sales pipeline status',
  'Draft a follow-up email to {person}',
  'Analyze last month revenue trends',
  'Create a report on customer health scores',
  'Update the project status for {project}',
  'Research competitors in the {concept} space',
  'Prepare the weekly team standup notes',
  'Review and update the product roadmap',
  'Generate a dashboard for {metric} KPIs',
  'Draft investor update for {org}',
  'Analyze support ticket trends',
  'Create onboarding checklist for {org}',
  'Optimize the {concept} configuration',
  'Write documentation for {product} API',
  'Plan the next sprint for {project}',
  'Calculate CAC and LTV for Q1',
  'Prepare GDPR compliance documentation',
  'Set up monitoring alerts for {product}',
  'Analyze churn risk for enterprise accounts',
  'Draft partnership proposal for {org}',
  'Create content calendar for next month',
  'Review security audit findings',
  'Build financial model for Series A',
  'Automate the {concept} workflow',
  'Set up data pipeline for {product} analytics',
] as const;

const THREAD_TITLES = [
  'Weekly Sales Pipeline Review',
  'DataVault Enterprise Onboarding',
  'Q1 Product Launch Planning',
  'Series A Due Diligence Prep',
  'API Redesign Sprint Planning',
  'Customer Churn Analysis',
  'Marketing Rebrand Coordination',
  'Performance Sprint Retrospective',
  'GDPR Compliance Checklist',
  'Mobile MVP Feature Prioritization',
  'Infrastructure Cost Optimization',
  'Investor Update Draft',
  'Customer Health Score Review',
  'Hiring Pipeline Management',
  'Content Marketing Strategy',
  'Bug Triage Session',
  'OKR Progress Review',
  'Partnership Strategy Discussion',
  'Product Demo Preparation',
  'Security Audit Follow-up',
  'Monthly Business Review Prep',
  'Singapore Expansion Planning',
  'Support Ticket Analysis',
  'Feature Flag Rollout Plan',
  'Technical Debt Prioritization',
  'Revenue Forecasting Model',
  'Team Capacity Planning',
  'Customer Interview Insights',
  'Pricing Strategy Review',
  'Year-End Planning Session',
] as const;

const RELATION_TYPES = [
  'works_for', 'manages', 'uses', 'owns', 'located_in',
  'part_of', 'depends_on', 'created_by', 'related_to', 'prefers',
] as const;

// ── Seeding Functions ───────────────────────────────────────────

function seedAgentMemory(db: AgentMemoryDb): void {
  console.log('\n📦 Seeding agent-memory.db...');
  db.setEmbeddingDimensions(EMBEDDING_DIM);

  // ── Entities ──
  const entityIds: Map<string, string> = new Map();
  const allEntities = [
    ...PEOPLE.map(p => ({ ...p })),
    ...ORGANIZATIONS.map(o => ({ ...o })),
    ...PRODUCTS.map(p => ({ ...p })),
    ...PROJECTS.map(p => ({ ...p })),
    ...CONCEPTS.map(c => ({ ...c })),
    ...LOCATIONS.map(l => ({ ...l })),
  ];

  // Raw SQL for backdating entities and memories
  const rawDb = (db as any).db as import('better-sqlite3').Database;
  const stmtBackdateEntity = rawDb.prepare(
    `UPDATE entities SET first_seen_at = ?, last_seen_at = ? WHERE id = ?`,
  );
  const stmtBackdateMemory = rawDb.prepare(
    `UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?`,
  );

  for (const ent of allEntities) {
    const daysOld = randomBetween(10, 85);
    const id = db.createEntity({
      canonicalName: ent.name,
      entityType: ent.type,
      aliases: [...ent.aliases],
      description: ent.desc,
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      embedding: textEmbedding(ent.name + ' ' + ent.desc),
    });
    entityIds.set(ent.name, id);

    // Simulate mention growth over time
    const extraMentions = randomBetween(1, 30);
    for (let i = 0; i < extraMentions; i++) {
      db.incrementEntityMentions(id);
    }

    // Backdate entity timestamps
    const firstSeen = daysAgo(daysOld);
    const lastSeen = daysAgo(randomBetween(0, Math.min(daysOld, 5)));
    stmtBackdateEntity.run(firstSeen, lastSeen, id);
  }
  console.log(`  ✓ ${allEntities.length} entities created (backdated 10-85 days)`);

  // ── Relations ──
  const relations: Array<[string, string, string, string]> = [
    // People → Organizations
    ['Marcus Weber', 'NovaTech GmbH', 'works_for', 'Marcus is CEO of NovaTech'],
    ['Sarah Chen', 'NovaTech GmbH', 'works_for', 'Sarah is CTO of NovaTech'],
    ['Tom Richter', 'NovaTech GmbH', 'works_for', 'Tom leads sales at NovaTech'],
    ['Lisa Hoffmann', 'NovaTech GmbH', 'works_for', 'Lisa leads marketing at NovaTech'],
    ['Jan Krüger', 'NovaTech GmbH', 'works_for', 'Jan is senior developer at NovaTech'],
    ['Elena Petrov', 'NovaTech GmbH', 'works_for', 'Elena manages product at NovaTech'],
    ['David Park', 'NovaTech GmbH', 'works_for', 'David handles UX at NovaTech'],
    ['Anna Müller', 'NovaTech GmbH', 'works_for', 'Anna manages customer success'],
    ['Oliver Braun', 'NovaTech GmbH', 'works_for', 'Oliver handles DevOps'],
    ['Maria Santos', 'NovaTech GmbH', 'works_for', 'Maria is data analyst'],
    ['Felix Neumann', 'NovaTech GmbH', 'works_for', 'Felix handles support'],
    ['Sophie Laurent', 'Horizon Ventures', 'works_for', 'Sophie is partner at Horizon'],
    ['Natasha Volkov', 'DigitalBridge Agency', 'works_for', 'Natasha is partner at DigitalBridge'],
    ['Kai Yamamoto', 'DataVault Corp', 'works_for', 'Kai is our contact at DataVault'],
    // Management
    ['Marcus Weber', 'Sarah Chen', 'manages', 'Marcus oversees all C-level reports'],
    ['Sarah Chen', 'Jan Krüger', 'manages', 'Sarah manages the engineering team'],
    ['Sarah Chen', 'Oliver Braun', 'manages', 'Sarah manages DevOps'],
    ['Tom Richter', 'Anna Müller', 'manages', 'Tom oversees customer-facing teams'],
    // Products → Organization
    ['NovaTech GmbH', 'NovaPlatform', 'owns', 'NovaTech owns the platform'],
    ['NovaTech GmbH', 'NovaAPI', 'owns', 'NovaTech owns the API product'],
    ['NovaTech GmbH', 'NovaConnect', 'owns', 'NovaTech owns the integration product'],
    ['NovaTech GmbH', 'NovaDash', 'owns', 'NovaTech owns the dashboard product'],
    ['NovaTech GmbH', 'NovaMobile', 'owns', 'NovaTech owns the mobile app'],
    // Projects → People
    ['Jan Krüger', 'API Redesign', 'manages', 'Jan leads the API redesign'],
    ['Elena Petrov', 'Q1 Product Launch', 'manages', 'Elena drives the launch'],
    ['Lisa Hoffmann', 'Marketing Rebrand', 'manages', 'Lisa runs the rebrand'],
    ['Oliver Braun', 'Performance Sprint', 'manages', 'Oliver leads perf improvements'],
    ['David Park', 'Mobile MVP', 'manages', 'David leads mobile UX'],
    // Customer relationships
    ['DataVault Corp', 'NovaPlatform', 'uses', 'DataVault is an enterprise customer'],
    ['GreenLeaf Retail', 'NovaPlatform', 'uses', 'GreenLeaf uses for inventory'],
    ['MedTech Pro', 'NovaConnect', 'uses', 'MedTech uses for HL7 integration'],
    ['FinanceHub AG', 'NovaPlatform', 'uses', 'FinanceHub is in final negotiations'],
    // Tech dependencies
    ['NovaPlatform', 'PostgreSQL', 'depends_on', 'Platform uses PostgreSQL for data'],
    ['NovaPlatform', 'TypeScript', 'depends_on', 'Platform built with TypeScript'],
    ['NovaAPI', 'GraphQL', 'depends_on', 'API moving to GraphQL'],
    ['NovaPlatform', 'Kubernetes', 'depends_on', 'Deployed on Kubernetes'],
    ['NovaPlatform', 'Stripe', 'depends_on', 'Payment processing via Stripe'],
    ['NovaPlatform', 'OAuth2', 'depends_on', 'Auth via OAuth2 PKCE'],
    // Strategy
    ['NovaTech GmbH', 'Product-Led Growth', 'uses', 'PLG is the go-to-market strategy'],
    ['NovaTech GmbH', 'OKR Framework', 'uses', 'NovaTech uses OKRs for goal-setting'],
    // Locations
    ['NovaTech GmbH', 'Berlin', 'located_in', 'HQ is in Berlin'],
    ['Tom Richter', 'Munich', 'located_in', 'Tom works from Munich office'],
    ['Kai Yamamoto', 'Singapore', 'located_in', 'Kai is based in Singapore'],
    // Investor
    ['Horizon Ventures', 'NovaTech GmbH', 'related_to', 'Horizon is a seed investor'],
    ['Sophie Laurent', 'Series A Fundraise', 'related_to', 'Sophie is involved in Series A'],
    // Partners
    ['DigitalBridge Agency', 'NovaTech GmbH', 'related_to', 'DigitalBridge is marketing partner'],
    ['TechFlow Solutions', 'NovaConnect', 'related_to', 'TechFlow builds integrations'],
    ['CloudScale Inc.', 'NovaPlatform', 'related_to', 'CloudScale provides infrastructure'],
  ];

  // We need a dummy memory ID for relations
  const anchorMemoryId = db.createMemory({
    text: 'NovaTech organizational knowledge base',
    namespace: 'knowledge',
    scopeType: SCOPE_TYPE,
    scopeId: SCOPE_ID,
    embedding: textEmbedding('NovaTech organizational knowledge base'),
  });

  let relCount = 0;
  for (const [from, to, type, desc] of relations) {
    const fromId = entityIds.get(from);
    const toId = entityIds.get(to);
    if (fromId && toId) {
      db.createRelation(fromId, toId, type, desc, anchorMemoryId, 0.8 + Math.random() * 0.2);
      relCount++;
    }
  }
  console.log(`  ✓ ${relCount} relations created`);

  // ── Memories ──
  const allMemories = [
    ...KNOWLEDGE_MEMORIES.map(t => ({ text: t, ns: 'knowledge' })),
    ...METHOD_MEMORIES.map(t => ({ text: t, ns: 'methods' })),
    ...LEARNING_MEMORIES.map(t => ({ text: t, ns: 'learnings' })),
    ...STATUS_MEMORIES.map(t => ({ text: t, ns: 'status' })),
  ];

  const memoryIds: string[] = [];
  for (let i = 0; i < allMemories.length; i++) {
    const mem = allMemories[i]!;
    // Spread memories: knowledge → older, status → newer
    const maxAge = mem.ns === 'knowledge' ? 80 : mem.ns === 'methods' ? 60 : mem.ns === 'learnings' ? 40 : 15;
    const memDaysOld = randomBetween(1, maxAge);
    const id = db.createMemory({
      text: mem.text,
      namespace: mem.ns,
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      embedding: textEmbedding(mem.text),
    });
    memoryIds.push(id);
    stmtBackdateMemory.run(daysAgo(memDaysOld), daysAgo(Math.max(0, memDaysOld - 2)), id);
  }
  console.log(`  ✓ ${allMemories.length} memories created (backdated by namespace age)`);

  // ── Mentions (link memories to entities) ──
  let mentionCount = 0;
  for (const memId of memoryIds) {
    const mem = db.getMemory(memId);
    if (!mem) continue;
    for (const [name, entId] of entityIds) {
      if (mem.text.includes(name) || (name.includes(' ') && mem.text.includes(name.split(' ')[0]!))) {
        db.createMention(memId, entId);
        mentionCount++;
      }
    }
  }
  console.log(`  ✓ ${mentionCount} mentions created`);

  // ── Extra Mentions for Orphan Entities ──
  // NovaAPI, NovaMobile, Product-Led Growth, Munich, London have no natural text matches
  const orphanKeywords: Array<{ entity: string; keywords: string[] }> = [
    { entity: 'NovaAPI', keywords: ['API', 'api', 'REST', 'GraphQL', 'endpoint'] },
    { entity: 'NovaMobile', keywords: ['mobile', 'Mobile', 'iOS', 'Android', 'app'] },
    { entity: 'Product-Led Growth', keywords: ['PLG', 'product-led', 'go-to-market', 'growth'] },
    { entity: 'Munich', keywords: ['Munich', 'München', 'sales office'] },
    { entity: 'London', keywords: ['London', 'UK', 'EU enterprise'] },
  ];
  let orphanMentionCount = 0;
  for (const { entity, keywords } of orphanKeywords) {
    const entId = entityIds.get(entity);
    if (!entId) continue;
    for (const memId of memoryIds) {
      const mem = db.getMemory(memId);
      if (!mem) continue;
      if (keywords.some(kw => mem.text.includes(kw))) {
        db.createMention(memId, entId); // INSERT OR IGNORE — safe if already exists
        orphanMentionCount++;
      }
    }
  }
  console.log(`  ✓ ${orphanMentionCount} extra mentions for orphan entities`);

  // ── Cooccurrences ──
  let coocCount = 0;
  for (const memId of memoryIds) {
    const mem = db.getMemory(memId);
    if (!mem) continue;
    const mentionedEntities: string[] = [];
    for (const [name, entId] of entityIds) {
      if (mem.text.includes(name) || (name.includes(' ') && mem.text.includes(name.split(' ')[0]!))) {
        mentionedEntities.push(entId);
      }
    }
    if (mentionedEntities.length >= 2) {
      db.updateCooccurrencesBatch(mentionedEntities);
      coocCount += mentionedEntities.length * (mentionedEntities.length - 1) / 2;
    }
  }
  console.log(`  ✓ ~${coocCount} cooccurrences updated`);

  // ── Boost Cooccurrence Counts ──
  // Add randomBetween(3, 15) to the top 15 entity pairs to avoid weak cooccurrences
  {
    const topPairs = rawDb.prepare(
      `SELECT entity_a_id, entity_b_id FROM cooccurrences ORDER BY count DESC LIMIT 15`,
    ).all() as Array<{ entity_a_id: string; entity_b_id: string }>;

    const stmtBoostCooc = rawDb.prepare(
      `UPDATE cooccurrences SET count = count + ? WHERE entity_a_id = ? AND entity_b_id = ?`,
    );
    for (const pair of topPairs) {
      stmtBoostCooc.run(randomBetween(3, 15), pair.entity_a_id, pair.entity_b_id);
    }
    console.log(`  ✓ Boosted cooccurrence counts for ${topPairs.length} top entity pairs`);
  }

  // ── Superseded memories (simulate contradiction resolution) ──
  const supersedeChains = [
    { old: 'MRR reached €45K in February 2024', new: 'MRR reached €52K in March 2024, up 15% MoM. Growth accelerating.' },
    { old: 'NovaTech has 18 employees', new: 'NovaTech has 22 employees as of March 2024. Added 2 engineers, 1 designer, 1 sales.' },
    { old: 'Customer churn rate is 3.2% monthly', new: 'Customer churn rate dropped to 2.8% in March 2024 after onboarding improvements.' },
    { old: 'Tom Richter manages enterprise sales. His pipeline has 8 qualified leads', new: 'Tom Richter manages enterprise sales. Pipeline grown to 12 qualified leads worth €480K.' },
    { old: 'Bug backlog: 12 open bugs', new: 'Bug backlog reduced to 7 open bugs, 1 critical. Billing module issues resolved.' },
  ];

  let supersedeCount = 0;
  for (const chain of supersedeChains) {
    const newId = db.createMemory({
      text: chain.new,
      namespace: 'status',
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      embedding: textEmbedding(chain.new),
    });
    // Find the old memory by text match
    const oldMem = memoryIds.find(id => {
      const m = db.getMemory(id);
      return m && m.text.includes(chain.old.slice(0, 30));
    });
    if (oldMem) {
      db.supersedMemory(oldMem, newId);
      db.createSupersedes(newId, oldMem, 'Updated information');
      supersedeCount++;
    }
  }
  console.log(`  ✓ ${supersedeCount} supersede chains created`);

  // ── Confidence Variation (simulate confirm/decay) ──
  {
    // Pick ~30 random memories and confirm them 1-5 times (raises confidence by +0.05 per call, capped at 1.0)
    const shuffled = [...memoryIds].sort(() => Math.random() - 0.5);
    const toConfirm = shuffled.slice(0, 30);
    let confirmOps = 0;
    for (const id of toConfirm) {
      const times = randomBetween(1, 5);
      for (let i = 0; i < times; i++) {
        db.confirmMemory(id);
        confirmOps++;
      }
    }

    // Pick ~10 random memories and lower their confidence to 0.50-0.65 (simulating decay/lack of retrieval)
    const toDecay = shuffled.slice(30, 40);
    const stmtDecayConfidence = rawDb.prepare(
      `UPDATE memories SET confidence = ? WHERE id = ?`,
    );
    for (const id of toDecay) {
      const lowConf = 0.50 + Math.random() * 0.15; // 0.50-0.65
      stmtDecayConfidence.run(Math.round(lowConf * 100) / 100, id);
    }
    console.log(`  ✓ Confidence variation: ${toConfirm.length} memories confirmed (${confirmOps} ops), ${toDecay.length} memories decayed`);
  }

  // ── Patterns ──
  const patterns = [
    { type: 'sequence', desc: 'Tool combination "memory_recall + write_file" correlates with success', meta: { tools: ['memory_recall', 'write_file'], occurrences: 28, successRate: 0.89 }, confidence: 0.82, evidence: 28 },
    { type: 'sequence', desc: 'Tool combination "data_store_query + artifact_save" correlates with success', meta: { tools: ['data_store_query', 'artifact_save'], occurrences: 15, successRate: 0.93 }, confidence: 0.78, evidence: 15 },
    { type: 'sequence', desc: 'Tool combination "web_search + memory_store" correlates with success', meta: { tools: ['web_search', 'memory_store'], occurrences: 22, successRate: 0.86 }, confidence: 0.75, evidence: 22 },
    { type: 'sequence', desc: 'Tool combination "bash + write_file + memory_store" correlates with success', meta: { tools: ['bash', 'write_file', 'memory_store'], occurrences: 11, successRate: 0.91 }, confidence: 0.70, evidence: 11 },
    { type: 'anti-pattern', desc: 'Primary tool "api_request" has high failure rate', meta: { tool: 'api_request', failureRate: 0.55, totalRuns: 18 }, confidence: 0.65, evidence: 18 },
    { type: 'anti-pattern', desc: 'Primary tool "send_email" has high failure rate', meta: { tool: 'send_email', failureRate: 0.52, totalRuns: 8 }, confidence: 0.55, evidence: 8 },
    { type: 'preference', desc: 'User prefers markdown artifacts over plain text for reports', meta: { format: 'markdown', contexts: ['reports', 'summaries', 'analysis'] }, confidence: 0.88, evidence: 35 },
    { type: 'preference', desc: 'User prefers concise bullet points over long paragraphs', meta: { style: 'bullets', contexts: ['updates', 'reviews'] }, confidence: 0.85, evidence: 42 },
    { type: 'schedule', desc: 'Sales pipeline review occurs weekly on Mondays', meta: { day: 'monday', frequency: 'weekly', task: 'pipeline review' }, confidence: 0.92, evidence: 12 },
    { type: 'schedule', desc: 'Monthly business review on first Friday', meta: { day: 'first-friday', frequency: 'monthly', task: 'business review' }, confidence: 0.90, evidence: 3 },
  ];

  // Create patterns with final desired confidence directly, then set evidence_count via raw SQL
  // (incrementPatternEvidence adds +0.05 per call and caps at 1.0, which would push all to 1.0)
  const stmtSetEvidence = rawDb.prepare(
    `UPDATE patterns SET evidence_count = ? WHERE id = ?`,
  );
  for (const p of patterns) {
    const id = db.createPattern({
      patternType: p.type,
      description: p.desc,
      confidence: p.confidence,
      metadata: p.meta,
    });
    // Set evidence_count directly without boosting confidence
    stmtSetEvidence.run(p.evidence, id);
  }
  console.log(`  ✓ ${patterns.length} patterns created (with target confidences)`);

  // ── Metrics (time series simulation) ──
  // Use raw SQL inserts with unique IDs to create proper time series
  // (upsertMetric deduplicates by name+window+scope, which collapses daily snapshots)
  const memDb = (db as any).db as import('better-sqlite3').Database;
  const stmtInsertMetric = memDb.prepare(`
    INSERT INTO metrics (id, metric_name, scope_type, scope_id, value, sample_count, window, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let metricCount = 0;

  // Daily success_rate snapshots (last 30 days) — shows evolution
  for (let i = 29; i >= 0; i--) {
    const date = daysAgo(i);
    // Trend: improving from ~0.78 to ~0.93
    const trend = 0.78 + (29 - i) * 0.005;
    const noise = (Math.random() - 0.5) * 0.08;
    stmtInsertMetric.run(randomUUID(), 'success_rate', SCOPE_TYPE, SCOPE_ID,
      Math.min(1, Math.max(0.6, trend + noise)), randomBetween(3, 15), 'daily', date);
    metricCount++;
  }

  // Daily avg_duration_ms (last 30 days) — shows optimization
  for (let i = 29; i >= 0; i--) {
    const date = daysAgo(i);
    const trend = 22000 - (29 - i) * 250;  // improving: 22s → 14.5s
    const noise = (Math.random() - 0.5) * 4000;
    stmtInsertMetric.run(randomUUID(), 'avg_duration_ms', SCOPE_TYPE, SCOPE_ID,
      Math.max(5000, trend + noise), randomBetween(3, 15), 'daily', date);
    metricCount++;
  }

  // Daily total_cost_usd (last 30 days) — growing with usage
  for (let i = 29; i >= 0; i--) {
    const date = daysAgo(i);
    const baseCost = i > 20 ? 0.08 : i > 10 ? 0.18 : 0.35;
    const noise = Math.random() * baseCost * 0.5;
    stmtInsertMetric.run(randomUUID(), 'total_cost_usd', SCOPE_TYPE, SCOPE_ID,
      baseCost + noise, randomBetween(3, 15), 'daily', date);
    metricCount++;
  }

  // Weekly success_rate (last 12 weeks)
  for (let i = 11; i >= 0; i--) {
    const date = daysAgo(i * 7);
    const trend = 0.76 + (11 - i) * 0.015;
    const noise = (Math.random() - 0.5) * 0.04;
    stmtInsertMetric.run(randomUUID(), 'success_rate', SCOPE_TYPE, SCOPE_ID,
      Math.min(1, Math.max(0.6, trend + noise)), randomBetween(20, 70), 'weekly', date);
    metricCount++;
  }

  // Weekly avg_duration_ms (last 12 weeks)
  for (let i = 11; i >= 0; i--) {
    const date = daysAgo(i * 7);
    const trend = 25000 - (11 - i) * 800;
    const noise = (Math.random() - 0.5) * 3000;
    stmtInsertMetric.run(randomUUID(), 'avg_duration_ms', SCOPE_TYPE, SCOPE_ID,
      Math.max(5000, trend + noise), randomBetween(20, 70), 'weekly', date);
    metricCount++;
  }

  // All-time tool usage metrics (via upsertMetric to avoid duplicates)
  const toolMetrics = [
    { name: 'tool_usage.memory_store', value: 145 },
    { name: 'tool_usage.memory_recall', value: 198 },
    { name: 'tool_usage.write_file', value: 89 },
    { name: 'tool_usage.read_file', value: 112 },
    { name: 'tool_usage.bash', value: 67 },
    { name: 'tool_usage.web_search', value: 54 },
    { name: 'tool_usage.data_store_query', value: 78 },
    { name: 'tool_usage.data_store_insert', value: 42 },
    { name: 'tool_usage.ask_user', value: 35 },
    { name: 'tool_usage.artifact_save', value: 56 },
    { name: 'tool_usage.google_drive', value: 12 },
    { name: 'tool_usage.send_email', value: 8 },
    { name: 'tool_usage.api_request', value: 18 },
  ];
  for (const m of toolMetrics) {
    db.upsertMetric({ metricName: m.name, value: m.value, sampleCount: 200, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
    metricCount++;
  }

  // All-time aggregate KPIs
  const aggMetrics = [
    { name: 'total_runs', value: 480, sample: 480 },
    { name: 'avg_duration_ms', value: 14200, sample: 480 },
    { name: 'total_cost_usd', value: 12.85, sample: 480 },
    { name: 'avg_runs_per_thread', value: 16, sample: 30 },
    { name: 'cost_per_run', value: 0.0268, sample: 480 },
  ];
  for (const m of aggMetrics) {
    db.upsertMetric({ metricName: m.name, value: m.value, sampleCount: m.sample, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
    metricCount++;
  }

  console.log(`  ✓ ${metricCount} metrics created (30 daily + 12 weekly + all_time)`);
}

// ── Realistic Thread Conversations ─────────────────────────────

const THREAD_CONVERSATIONS: Record<string, Array<{ role: 'user' | 'assistant'; content: string }>> = {
  'Weekly Sales Pipeline Review': [
    { role: 'user', content: 'Give me an overview of the current sales pipeline.' },
    { role: 'assistant', content: '**Sales Pipeline Summary**\n\nI pulled the latest data from your CRM:\n\n| Stage | Deals | Value |\n|-------|-------|-------|\n| Qualified | 12 | €340K |\n| Proposal | 5 | €180K |\n| Negotiation | 3 | €210K |\n| Closing | 2 | €95K |\n\n**Total pipeline value: €825K**\n\nNotable changes since last week:\n- DataVault moved to Negotiation (€120K)\n- 3 new leads from the Berlin conference\n- CloudBridge deal is at risk — no response in 14 days' },
    { role: 'user', content: 'What should we focus on this week?' },
    { role: 'assistant', content: 'Based on the pipeline analysis, I recommend three priorities:\n\n1. **Close DataVault** — They requested final pricing. Tom should send the enterprise quote today. This is our largest deal this quarter.\n\n2. **Re-engage CloudBridge** — 14 days of silence is a red flag. I drafted a "checking in" email for Anna. Want me to send it?\n\n3. **Qualify Berlin leads** — 3 new contacts from the event. I stored their details in Contacts. Schedule discovery calls this week before they go cold.\n\nShall I create tasks for these?' },
    { role: 'user', content: 'Yes, create tasks and send that email to CloudBridge.' },
    { role: 'assistant', content: 'Done.\n\n- ✅ Task created: "Send DataVault enterprise quote" → assigned to Tom, due today\n- ✅ Task created: "Discovery calls with Berlin leads" → assigned to Anna, due Friday\n- ✅ Email sent to CloudBridge (Michael Torres): "Quick check-in on the NovaPlatform evaluation"\n\nI\'ll monitor for a reply and notify you.' },
  ],
  'Q1 Product Launch Planning': [
    { role: 'user', content: 'We need to plan the Q1 launch for NovaConnect. What\'s the current status?' },
    { role: 'assistant', content: 'Here\'s where we stand with NovaConnect:\n\n**Development:** 85% complete\n- Core API integration: ✅ Done\n- OAuth2 flow: ✅ Done\n- Webhook system: 🔄 In progress (Jan estimates 3 days)\n- Rate limiting: ⏳ Not started\n\n**Marketing:** 40% complete\n- Landing page draft: ✅ Done\n- Blog post: 🔄 Lisa is writing\n- Email campaign: ⏳ Not started\n- Partner announcements: ⏳ Waiting on legal\n\n**Blockers:**\n- Legal review for partner API terms (Elena is following up)\n- Need sign-off from Marcus on pricing tiers' },
    { role: 'user', content: 'Set the launch date to March 15. What needs to happen before then?' },
    { role: 'assistant', content: 'Launch date locked: **March 15**. Here\'s the countdown plan:\n\n**Week 1 (now → Feb 28)**\n- Jan finishes webhook system + rate limiting\n- Elena gets legal sign-off on API terms\n- Marcus approves pricing (I scheduled a 30-min slot for Thursday)\n\n**Week 2 (Mar 1–7)**\n- QA sprint: security review + load testing\n- Lisa finalizes blog post + email sequence\n- David ships landing page to production\n\n**Week 3 (Mar 8–14)**\n- Soft launch to beta customers (DataVault, Meridian)\n- Partner notifications go out\n- Support docs published\n\n**March 15 — Public launch**\n\nI created a workflow that checks progress daily and alerts you if anything falls behind. Want me to notify the team?' },
    { role: 'user', content: 'Yes, notify everyone and set up the daily check.' },
    { role: 'assistant', content: 'All set:\n\n- 📧 Sent launch plan to: Sarah, Jan, Lisa, Elena, David, Marcus\n- 🔄 Daily workflow created: checks task completion at 9:00 AM, alerts you on delays\n- 📅 Added "NovaConnect Launch" to the team calendar\n- 📊 Tracking board created in DataStore with status for all 14 launch tasks\n\nI\'ll give you a progress update every morning.' },
  ],
  'Customer Churn Analysis': [
    { role: 'user', content: 'We lost 3 customers last month. Analyze why.' },
    { role: 'assistant', content: 'I analyzed the 3 churned accounts and found clear patterns:\n\n**1. PixelForge Studios** (€2.4K/mo)\n- Reason: Switched to a cheaper competitor\n- Warning signs: Support tickets increased 3x in December, login frequency dropped 60%\n- Last contact: Jan 5 — complained about API latency\n\n**2. GreenTech Solutions** (€1.8K/mo)\n- Reason: Budget cuts — downsized team from 15 to 8\n- Warning signs: Reduced seat count in November, no feature requests in 2 months\n- Last contact: Dec 12 — asked about downgrade options\n\n**3. Nordic Retail Group** (€3.2K/mo)\n- Reason: Acquired by larger company that uses SAP\n- Warning signs: None — external event\n- Last contact: Jan 15 — friendly farewell\n\n**Total MRR lost: €7.4K**' },
    { role: 'user', content: 'What can we do to prevent this going forward?' },
    { role: 'assistant', content: 'Three actionable recommendations:\n\n**1. Health Score Monitoring** (prevents cases like PixelForge)\n- I built a customer health score combining: login frequency, support tickets, feature usage, NPS\n- 4 accounts are currently "at risk": CloudBridge, TechStart, FlowMotion, Alpine Digital\n- I\'ll alert you when any account drops below the threshold\n\n**2. Proactive Downsell** (prevents cases like GreenTech)\n- When usage drops >30%, automatically flag for Anna to offer a smaller plan\n- Better to keep them at €800/mo than lose €1.8K/mo\n\n**3. Annual Contracts with Discount** (reduces overall churn)\n- Offer 15% discount for annual commitment\n- Currently 78% of customers are monthly — high risk\n\nWant me to set up the health score monitoring as a daily workflow?' },
  ],
  'DataVault Enterprise Onboarding': [
    { role: 'user', content: 'DataVault signed the enterprise contract. Start the onboarding.' },
    { role: 'assistant', content: 'Congratulations! DataVault is your largest enterprise deal at **€120K/year**.\n\nI\'ve initiated the onboarding sequence:\n\n**Week 1: Setup**\n- ✅ Created DataVault workspace with enterprise config\n- ✅ Invited Michael Torres (CTO) and 4 team members\n- ✅ Provisioned dedicated API endpoints\n- 📋 Sent onboarding questionnaire (integration needs, data migration, training schedule)\n\n**Week 2: Integration**\n- Custom API setup based on their PostgreSQL stack\n- Data migration from their legacy CRM\n- SSO configuration (they use Okta)\n\n**Week 3: Training**\n- 2× training sessions for their team\n- Admin training for Michael\n\n**Week 4: Go-live**\n- Parallel run with old system\n- Sign-off meeting\n\nAnna is the primary contact. I\'ll track all milestones.' },
  ],
  'Pricing Strategy Review': [
    { role: 'user', content: 'Our conversion rate dropped from 4.2% to 2.8% last month. Could it be pricing?' },
    { role: 'assistant', content: 'I analyzed the data and pricing is likely a factor. Here\'s what I found:\n\n**Conversion funnel breakdown:**\n- Website → Signup: 12% (unchanged)\n- Signup → Trial: 68% (unchanged)\n- Trial → Paid: **2.8%** (was 4.2%) ← the drop is here\n\n**What changed:**\n- We raised the Starter plan from €29 to €49 on Jan 15\n- The drop started exactly on Jan 16\n- Competitor PipelineHQ launched a €19/mo plan on Jan 10\n\n**Key metric:** 73% of churned trials cited "too expensive for my stage" in the exit survey.\n\n**Price sensitivity analysis:**\n- At €29: estimated 4.5% conversion → €13K MRR from new signups\n- At €39: estimated 3.5% conversion → €13.6K MRR\n- At €49: actual 2.8% conversion → €13.7K MRR\n\nRevenue per tier is almost flat, but at €49 we\'re losing volume and market share.' },
    { role: 'user', content: 'What do you recommend?' },
    { role: 'assistant', content: 'I\'d recommend a **tiered approach** rather than rolling back:\n\n**Option A: Add a Solo plan at €19/mo** (recommended)\n- Limited to 1 user, 1K API calls\n- Captures the "too expensive" segment\n- Creates an upgrade path to Starter (€49)\n- Low support cost — self-serve only\n\n**Projected impact:**\n- Solo conversions: ~3% at €19 = €5.7K additional MRR\n- 20% of Solo users upgrade within 6 months\n- Net new MRR: +€8.2K/mo within 6 months\n\n**Option B: Rollback Starter to €29**\n- Simple but leaves money on the table for power users\n- We\'d need to grandfather existing €49 customers\n\nI lean toward Option A. Should I draft the pricing page copy and update the billing config?' },
    { role: 'user', content: 'Go with Option A. Draft everything.' },
    { role: 'assistant', content: 'On it. Here\'s what I\'m preparing:\n\n1. ✅ **Pricing page copy** — saved as artifact "Solo Plan Pricing Copy"\n2. ✅ **Feature comparison table** — Solo vs Starter vs Pro\n3. 📋 **Billing config** — drafted Stripe product for Solo plan\n4. 📋 **Email campaign** — re-engagement for churned trials: "We heard you. Introducing Solo."\n5. 📋 **Internal brief** — for Tom\'s sales team on how to position the upgrade path\n\nI also updated the DataStore with the new pricing tiers and projected revenue models.\n\nMarcus should approve before we push to production. Want me to schedule a 15-min review with him?' },
  ],
  'Monthly Business Review Prep': [
    { role: 'user', content: 'Prepare the monthly business review for March.' },
    { role: 'assistant', content: '**March Business Review — Draft**\n\n📊 **Revenue**\n- MRR: €47.2K (+8.3% MoM)\n- ARR run-rate: €566K\n- New MRR: €6.1K (12 new customers)\n- Churned MRR: €2.3K (2 customers)\n- Net revenue retention: 112%\n\n👥 **Customers**\n- Total: 89 (+12, -2)\n- Enterprise: 4 (DataVault onboarded this month)\n- NPS: 52 → 58\n\n🚀 **Product**\n- Features shipped: 14\n- Uptime: 99.94%\n- API latency p95: 180ms (improved from 240ms)\n\n💰 **Burn & Runway**\n- Monthly burn: €32K\n- Cash: €840K\n- Runway: 26 months (at current burn)\n\n📈 **Key wins:**\n- DataVault enterprise deal closed (€120K ARR)\n- NovaConnect beta launched to 3 partners\n- Hired 2 engineers (start April)\n\n⚠️ **Risks:**\n- 4 accounts flagged as at-risk\n- Marketing spend ROI declining (CAC up 15%)\n\nWant me to generate the slides?' },
  ],
  'Partnership Strategy Discussion': [
    { role: 'user', content: 'Horizon Ventures wants to explore a strategic partnership. What do we know about them?' },
    { role: 'assistant', content: 'Here\'s everything I have on **Horizon Ventures**:\n\n**Company Profile:**\n- B2B SaaS VC fund, Berlin-based\n- AUM: ~€200M\n- Focus: Early-stage enterprise software (Series A)\n- Notable portfolio: StreamKit, DataLayer, CloudBridge\n\n**Key People:**\n- Julia Bergmann — Managing Partner (met Marcus at Berlin Tech Week)\n- Michael Torres — Portfolio Operations (also CTO at DataVault)\n\n**Our Connection:**\n- Marcus had coffee with Julia on Feb 12 — she mentioned co-investment interest\n- DataVault (their portfolio company) is our largest customer\n- They hosted a roundtable we attended in January\n\n**Potential partnership angles:**\n1. Portfolio introductions (8 companies in their portfolio match our ICP)\n2. Co-marketing at their annual summit\n3. Strategic investment as part of our Series A\n\nJulia\'s assistant emailed yesterday to schedule a follow-up. Want me to draft a reply?' },
  ],
  'Bug Triage Session': [
    { role: 'user', content: 'We got 5 new bug reports overnight. Triage them.' },
    { role: 'assistant', content: 'I reviewed all 5 tickets from the support queue:\n\n**🔴 Critical (fix today)**\n1. **#1247** — API returns 500 on bulk import >1000 rows\n   - Affects: DataVault (enterprise), 3 other customers\n   - Root cause: Memory spike in batch processor\n   - Assigned to: Jan\n\n**🟡 High (fix this week)**\n2. **#1248** — Webhook retries not respecting backoff\n   - Affects: 2 customers using webhook integrations\n   - Likely: Race condition in retry queue\n   - Assigned to: Jan\n\n3. **#1249** — Dashboard charts blank after timezone change\n   - Affects: Singapore users (3 accounts)\n   - Likely: UTC offset not applied in chart queries\n   - Assigned to: David\n\n**🟢 Low (next sprint)**\n4. **#1250** — Typo in German localization ("Einstelungen")\n5. **#1251** — Export CSV missing header row for custom fields\n\nI created Jira tickets for all 5 and notified the team. Jan is already looking at #1247.' },
  ],
};

/** Get realistic messages for a thread, falling back to generic business conversation. */
function getThreadMessages(title: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (THREAD_CONVERSATIONS[title]) {
    return THREAD_CONVERSATIONS[title];
  }
  // Generic business conversation for threads without specific content
  const genericPairs = [
    { role: 'user' as const, content: `Let's review the current status of ${title.toLowerCase()}.` },
    { role: 'assistant' as const, content: `I pulled together the latest data. Here's the overview:\n\n**Current Status:** On track with minor adjustments needed.\n\n**Key Metrics:**\n- Progress: 72% complete\n- Timeline: 3 days ahead of schedule\n- Budget: Within 5% of allocation\n\n**Recent Updates:**\n- Sarah completed the technical review yesterday\n- Tom's team provided the Q1 numbers\n- Elena flagged 2 items that need your input\n\nWant me to dive deeper into any of these areas?` },
    { role: 'user' as const, content: 'What are the open items that need my attention?' },
    { role: 'assistant' as const, content: `There are 3 items requiring your input:\n\n1. **Budget approval** — Elena needs sign-off on the €15K allocation for external tooling. The ROI analysis shows 4x payback in 6 months.\n\n2. **Timeline decision** — We can either ship the full scope by March 30 or release a smaller version by March 15 and iterate. Sarah recommends the phased approach.\n\n3. **Stakeholder review** — Marcus wants a 15-minute walkthrough before we present to the team. I blocked Thursday 2 PM.\n\nShall I prepare a summary document for the stakeholder review?` },
    { role: 'user' as const, content: 'Approve the budget and go with the phased approach. Prepare the summary.' },
    { role: 'assistant' as const, content: `Done:\n\n- ✅ Budget approved — notified Elena\n- ✅ Updated timeline to phased release (March 15 → v1, March 30 → full)\n- ✅ Summary document drafted — saved as artifact\n- 📅 Confirmed Marcus walkthrough for Thursday 2 PM\n\nI'll track the March 15 milestone and alert you if anything slips.` },
  ];
  return genericPairs;
}

function seedRunHistory(h: RunHistory): void {
  console.log('\n📊 Seeding history.db...');

  // Access internal db for raw SQL (date backdating)
  const db = h['db'] as import('better-sqlite3').Database;

  // ── Threads ──
  const ts = new ThreadStore(db);
  const threadIds: string[] = [];

  const stmtBackdateThread = db.prepare(
    `UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?`,
  );
  const stmtBackdateMsg = db.prepare(
    `UPDATE thread_messages SET created_at = ? WHERE thread_id = ? AND seq >= 0`,
  );

  for (const title of THREAD_TITLES) {
    const id = randomUUID();
    threadIds.push(id);
    const threadDaysOld = randomBetween(2, 85);
    ts.createThread(id, {
      title,
      model_tier: pick(['sonnet', 'haiku', 'opus']),
      context_id: CONTEXT_ID,
    });

    // Add realistic messages to threads
    const threadMessages = getThreadMessages(title);
    ts.appendMessages(id, threadMessages as any[], 0);

    const tokens = randomBetween(5000, 80000);
    const cost = tokens * 0.000003 + randomBetween(1, 50) * 0.001;
    ts.updateThread(id, {
      message_count: threadMessages.length,
      total_tokens: tokens,
      total_cost_usd: cost,
      is_archived: Math.random() < 0.15,
    });

    // Backdate thread timestamps
    const createdAt = daysAgo(threadDaysOld);
    const updatedAt = daysAgo(Math.max(0, threadDaysOld - randomBetween(0, 10)));
    stmtBackdateThread.run(createdAt, updatedAt, id);
    stmtBackdateMsg.run(createdAt, id);
  }
  console.log(`  ✓ ${THREAD_TITLES.length} threads with messages created`);

  // ── Runs ──
  const allEntityNames = [...PEOPLE.map(p => p.name), ...ORGANIZATIONS.map(o => o.name)];
  const allProjectNames = PROJECTS.map(p => p.name);
  const allProductNames = PRODUCTS.map(p => p.name);
  const allConceptNames = CONCEPTS.map(c => c.name);
  const allOrgNames = ORGANIZATIONS.map(o => o.name);

  let totalRuns = 0;
  let totalToolCalls = 0;

  // Prepared statement to backdate run created_at
  const stmtBackdateRun = db.prepare(`UPDATE runs SET created_at = ? WHERE id = ?`);

  // Spread 400 runs over 90 days with increasing density
  for (let day = 90; day >= 0; day--) {
    // More runs in recent days (simulate growing usage)
    const runsToday = day > 60 ? randomBetween(1, 3)
      : day > 30 ? randomBetween(3, 6)
      : randomBetween(5, 10);

    for (let r = 0; r < runsToday; r++) {
      const sessionId = pick(threadIds);
      const modelTier = pick(['sonnet', 'sonnet', 'sonnet', 'haiku', 'opus']);  // weighted toward sonnet
      const modelId = modelTier === 'opus' ? 'claude-opus-4-6'
        : modelTier === 'sonnet' ? 'claude-sonnet-4-6'
        : 'claude-haiku-4-5-20251001';

      // Generate realistic task text
      let taskText = pick(TASK_TEMPLATES);
      taskText = taskText
        .replace('{person}', pick(allEntityNames))
        .replace('{project}', pick(allProjectNames))
        .replace('{product}', pick(allProductNames))
        .replace('{concept}', pick(allConceptNames))
        .replace('{org}', pick(allOrgNames))
        .replace('{metric}', pick(['revenue', 'churn', 'NPS', 'pipeline', 'usage']));

      const runId = h.insertRun({
        sessionId,
        taskText,
        modelTier,
        modelId,
        promptHash: `ph-${randomUUID().slice(0, 8)}`,
        runType: Math.random() < 0.05 ? 'batch_parent' : 'single',
        contextId: CONTEXT_ID,
      });

      // Backdate the run to the target day (with random hour/minute)
      const runDate = new Date(NOW.getTime() - day * DAY_MS);
      runDate.setHours(randomBetween(8, 22), randomBetween(0, 59), randomBetween(0, 59));
      stmtBackdateRun.run(runDate.toISOString().replace('T', ' ').slice(0, 19), runId);

      // Status: mostly completed, some failed
      const failed = Math.random() < 0.12;
      const durationMs = failed
        ? randomBetween(500, 5000)
        : randomBetween(3000, 45000);
      const tokensIn = randomBetween(500, 8000);
      const tokensOut = randomBetween(200, 4000);
      const costUsd = (tokensIn * 0.000003 + tokensOut * 0.000015) * (modelTier === 'opus' ? 5 : modelTier === 'sonnet' ? 1 : 0.2);

      h.updateRun(runId, {
        responseText: failed
          ? `Error: ${pick(['API timeout', 'Rate limit exceeded', 'Invalid input', 'Permission denied', 'Connection reset'])}`
          : `[Completed task: ${taskText}]`,
        tokensIn,
        tokensOut,
        tokensCacheRead: randomBetween(0, tokensIn * 0.3),
        tokensCacheWrite: randomBetween(0, tokensIn * 0.1),
        costUsd,
        durationMs,
        userWaitMs: durationMs + randomBetween(100, 2000),
        stopReason: failed ? 'error' : 'end_turn',
        status: failed ? 'failed' : 'completed',
        toolCallCount: 0,  // will update after adding tool calls
      });

      // ── Tool Calls per Run ──
      const toolCount = failed
        ? randomBetween(0, 2)
        : randomBetween(1, 6);

      for (let t = 0; t < toolCount; t++) {
        const toolName = pick(TOOLS);
        const toolDuration = randomBetween(50, 5000);
        h.insertToolCall({
          runId,
          toolName,
          inputJson: JSON.stringify({ query: taskText.slice(0, 50), step: t }),
          outputJson: JSON.stringify({ success: !failed || t < toolCount - 1, result: `Step ${t + 1} output` }),
          durationMs: toolDuration,
          sequenceOrder: t,
        });
        totalToolCalls++;
      }

      if (toolCount > 0) {
        h.updateRun(runId, { toolCallCount: toolCount });
      }

      totalRuns++;
    }
  }
  console.log(`  ✓ ${totalRuns} runs created (spread over 90 days)`);
  console.log(`  ✓ ${totalToolCalls} tool calls created`);
}

function seedDataStore(ds: DataStore): void {
  console.log('\n🗃️  Seeding datastore.db...');

  // ── Leads collection ──
  ds.createCollection({
    name: 'leads',
    columns: [
      { name: 'company', type: 'string' as const },
      { name: 'contact', type: 'string' as const },
      { name: 'email', type: 'string' as const },
      { name: 'stage', type: 'string' as const },
      { name: 'deal_value', type: 'number' as const },
      { name: 'source', type: 'string' as const },
      { name: 'created_date', type: 'date' as const },
      { name: 'last_contact', type: 'date' as const },
      { name: 'notes', type: 'string' as const },
    ],
    scope: { type: 'context', id: CONTEXT_ID },
  });

  const stages = ['prospect', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] as const;
  const sources = ['inbound', 'outbound', 'referral', 'event', 'website'] as const;
  const leadCompanies = [
    'DataVault Corp', 'FinanceHub AG', 'EduSpark', 'LogiTrans GmbH', 'HealthCore Systems',
    'RetailMax', 'CyberShield AG', 'AgriSmart', 'FoodChain Pro', 'TravelWise',
    'SmartFactory GmbH', 'UrbanPlan Tech', 'FitLife Digital', 'PetCare Plus', 'AutoDrive Systems',
    'SolarWatt AG', 'CloudNine Media', 'LegalEase', 'InsureTech Pro', 'EstatePro GmbH',
    'FashionForward', 'GameStudio Berlin', 'BioTech Solutions', 'AeroSpace Digital', 'MarineLog Systems',
  ];

  const leadRecords = leadCompanies.map((company, i) => {
    const dayCreated = randomBetween(5, 80);
    const dayContact = randomBetween(0, dayCreated);
    return {
      company,
      contact: `Contact Person ${i + 1}`,
      email: `contact${i + 1}@${company.toLowerCase().replace(/[^a-z]/g, '')}.com`,
      stage: pick(stages),
      deal_value: randomBetween(5, 200) * 1000,
      source: pick(sources),
      created_date: daysAgo(dayCreated).split('T')[0]!,
      last_contact: daysAgo(dayContact).split('T')[0]!,
      notes: `${pick(['Initial meeting went well', 'Needs follow-up demo', 'Budget approved', 'Waiting on legal', 'Champion identified', 'Decision in Q2'])}. ${pick(['High priority', 'Medium priority', 'Needs nurturing', 'Ready to close'])}`,
    };
  });

  ds.insertRecords({ collection: 'leads', records: leadRecords });
  console.log(`  ✓ leads: ${leadRecords.length} records`);

  // ── Revenue collection ──
  ds.createCollection({
    name: 'revenue',
    columns: [
      { name: 'month', type: 'date' as const },
      { name: 'mrr', type: 'number' as const },
      { name: 'new_mrr', type: 'number' as const },
      { name: 'churned_mrr', type: 'number' as const },
      { name: 'expansion_mrr', type: 'number' as const },
      { name: 'customers', type: 'number' as const },
      { name: 'arpu', type: 'number' as const },
      { name: 'churn_rate', type: 'number' as const },
    ],
    scope: { type: 'context', id: CONTEXT_ID },
  });

  const revenueData = [
    { month: '2023-09-01', mrr: 12000, new_mrr: 12000, churned_mrr: 0, expansion_mrr: 0, customers: 12, arpu: 1000, churn_rate: 0 },
    { month: '2023-10-01', mrr: 18500, new_mrr: 7200, churned_mrr: 700, expansion_mrr: 0, customers: 18, arpu: 1028, churn_rate: 0.038 },
    { month: '2023-11-01', mrr: 28000, new_mrr: 10800, churned_mrr: 1300, expansion_mrr: 0, customers: 25, arpu: 1120, churn_rate: 0.046 },
    { month: '2023-12-01', mrr: 34500, new_mrr: 8200, churned_mrr: 1700, expansion_mrr: 0, customers: 30, arpu: 1150, churn_rate: 0.049 },
    { month: '2024-01-01', mrr: 38200, new_mrr: 5500, churned_mrr: 1800, expansion_mrr: 0, customers: 33, arpu: 1158, churn_rate: 0.047 },
    { month: '2024-02-01', mrr: 45000, new_mrr: 8200, churned_mrr: 1400, expansion_mrr: 0, customers: 38, arpu: 1184, churn_rate: 0.032 },
    { month: '2024-03-01', mrr: 52000, new_mrr: 9500, churned_mrr: 2500, expansion_mrr: 0, customers: 42, arpu: 1238, churn_rate: 0.028 },
  ];

  ds.insertRecords({ collection: 'revenue', records: revenueData });
  console.log(`  ✓ revenue: ${revenueData.length} records`);

  // ── Inventory / Product metrics ──
  ds.createCollection({
    name: 'product_metrics',
    columns: [
      { name: 'product', type: 'string' as const },
      { name: 'week', type: 'date' as const },
      { name: 'active_users', type: 'number' as const },
      { name: 'api_calls', type: 'number' as const },
      { name: 'p95_latency_ms', type: 'number' as const },
      { name: 'error_rate', type: 'number' as const },
      { name: 'uptime_pct', type: 'number' as const },
    ],
    scope: { type: 'context', id: CONTEXT_ID },
  });

  const products = ['NovaPlatform', 'NovaAPI', 'NovaConnect', 'NovaDash'];
  const productRecords = [];
  for (const product of products) {
    for (let week = 12; week >= 0; week--) {
      const baseUsers = product === 'NovaPlatform' ? 180 : product === 'NovaAPI' ? 120 : product === 'NovaConnect' ? 45 : 75;
      const growth = (12 - week) * (baseUsers * 0.03);
      productRecords.push({
        product,
        week: daysAgo(week * 7).split('T')[0]!,
        active_users: Math.round(baseUsers + growth + randomBetween(-10, 10)),
        api_calls: randomBetween(5000, 50000) * (product === 'NovaAPI' ? 3 : 1),
        p95_latency_ms: product === 'NovaPlatform' ? randomBetween(150, 250) : randomBetween(80, 180),
        error_rate: Math.round((Math.random() * 0.02 + 0.001) * 10000) / 10000,
        uptime_pct: Math.round((99.8 + Math.random() * 0.19) * 100) / 100,
      });
    }
  }

  ds.insertRecords({ collection: 'product_metrics', records: productRecords });
  console.log(`  ✓ product_metrics: ${productRecords.length} records`);

  // ── Support tickets ──
  ds.createCollection({
    name: 'support_tickets',
    columns: [
      { name: 'ticket_id', type: 'string' as const },
      { name: 'customer', type: 'string' as const },
      { name: 'priority', type: 'string' as const },
      { name: 'category', type: 'string' as const },
      { name: 'status', type: 'string' as const },
      { name: 'created', type: 'date' as const },
      { name: 'resolved', type: 'date' as const },
      { name: 'resolution_hours', type: 'number' as const },
    ],
    scope: { type: 'context', id: CONTEXT_ID },
  });

  const priorities = ['P1', 'P2', 'P3', 'P4'] as const;
  const categories = ['billing', 'api', 'performance', 'feature_request', 'bug', 'onboarding', 'security'] as const;
  const ticketStatuses = ['open', 'in_progress', 'resolved', 'resolved', 'resolved'] as const;
  const customers = ['DataVault Corp', 'GreenLeaf Retail', 'MedTech Pro', 'FinanceHub AG', 'EduSpark', 'SmartFactory GmbH', 'CloudNine Media'];

  const tickets = Array.from({ length: 60 }, (_, i) => {
    const created = randomBetween(1, 70);
    const status = pick(ticketStatuses);
    const resolved = status === 'resolved' ? Math.max(0, created - randomBetween(0, 5)) : null;
    return {
      ticket_id: `TK-${String(1000 + i).padStart(4, '0')}`,
      customer: pick(customers),
      priority: pick(priorities),
      category: pick(categories),
      status,
      created: daysAgo(created).split('T')[0]!,
      resolved: resolved !== null ? daysAgo(resolved).split('T')[0]! : '',
      resolution_hours: resolved !== null ? randomBetween(1, 72) : 0,
    };
  });

  ds.insertRecords({ collection: 'support_tickets', records: tickets });
  console.log(`  ✓ support_tickets: ${tickets.length} records`);

  // ── Tasks / OKRs ──
  ds.createCollection({
    name: 'okrs',
    columns: [
      { name: 'objective', type: 'string' as const },
      { name: 'key_result', type: 'string' as const },
      { name: 'owner', type: 'string' as const },
      { name: 'target', type: 'number' as const },
      { name: 'current', type: 'number' as const },
      { name: 'progress_pct', type: 'number' as const },
      { name: 'quarter', type: 'string' as const },
      { name: 'status', type: 'string' as const },
    ],
    scope: { type: 'context', id: CONTEXT_ID },
  });

  const okrs = [
    { objective: 'Accelerate revenue growth', key_result: 'Reach €60K MRR', owner: 'Tom Richter', target: 60000, current: 52000, progress_pct: 87, quarter: 'Q1-2024', status: 'on_track' },
    { objective: 'Accelerate revenue growth', key_result: 'Close 3 enterprise deals', owner: 'Tom Richter', target: 3, current: 2, progress_pct: 67, quarter: 'Q1-2024', status: 'at_risk' },
    { objective: 'Accelerate revenue growth', key_result: 'Reduce churn to <2.5%', owner: 'Anna Müller', target: 2.5, current: 2.8, progress_pct: 72, quarter: 'Q1-2024', status: 'behind' },
    { objective: 'Ship world-class product', key_result: 'Complete API v3 migration', owner: 'Jan Krüger', target: 100, current: 80, progress_pct: 80, quarter: 'Q1-2024', status: 'on_track' },
    { objective: 'Ship world-class product', key_result: 'Launch NovaMobile MVP', owner: 'David Park', target: 100, current: 45, progress_pct: 45, quarter: 'Q1-2024', status: 'behind' },
    { objective: 'Ship world-class product', key_result: 'p95 latency < 200ms', owner: 'Oliver Braun', target: 200, current: 180, progress_pct: 100, quarter: 'Q1-2024', status: 'completed' },
    { objective: 'Build scalable team', key_result: 'Hire 4 engineers', owner: 'Sarah Chen', target: 4, current: 2, progress_pct: 50, quarter: 'Q1-2024', status: 'at_risk' },
    { objective: 'Build scalable team', key_result: 'NPS > 50', owner: 'Anna Müller', target: 50, current: 42, progress_pct: 84, quarter: 'Q1-2024', status: 'on_track' },
    { objective: 'Secure funding', key_result: 'Close Series A by June', owner: 'Marcus Weber', target: 100, current: 70, progress_pct: 70, quarter: 'Q1-2024', status: 'on_track' },
    { objective: 'Secure funding', key_result: 'Prepare data room with 15 docs', owner: 'Marcus Weber', target: 15, current: 12, progress_pct: 80, quarter: 'Q1-2024', status: 'on_track' },
  ];

  ds.insertRecords({ collection: 'okrs', records: okrs });
  console.log(`  ✓ okrs: ${okrs.length} records`);
}

// ── Knowledge Memory Files ──────────────────────────────────────

function seedMemoryFiles(): void {
  console.log('\n📝 Seeding memory files...');
  const memDir = join(LYNOX_DIR, 'memory', 'global');
  mkdirSync(memDir, { recursive: true });

  const files: Record<string, string> = {
    'knowledge.txt': `NovaTech GmbH was founded in 2023 by Marcus Weber in Berlin. Focus: B2B SaaS for enterprise operations.
DataVault Corp is our largest enterprise customer (€120K/year). CTO: Michael Torres. Stack: PostgreSQL + custom ETL.
Horizon Ventures (Julia Bergmann) is our Series A lead investor candidate. AUM ~€200M, focus on early-stage enterprise.
GreenLeaf Retail signed last month (€2.4K/mo). Uses NovaPlatform for inventory management. Contact: Nina Ortega.
MedTech Pro is a mid-market customer (€4.8K/mo). Regulatory compliance is their top priority. Contact: Dr. Felix Neumann.
Current MRR: €47.2K. ARR run-rate: €566K. 89 active customers across 4 products.
NovaPlatform is the flagship product. 180 active users, p95 latency 180ms, 99.94% uptime.
NovaAPI handles 150K+ calls/day. Rate limiting and webhook system are the newest features.
NovaConnect launched in beta to 3 partners. Full public launch planned for March 15.
NovaDash is the analytics dashboard. 75 active users, mostly used for executive reporting.
Singapore expansion planned for Q2. Target: 5 pilot customers in fintech vertical.
CAC is currently €340. LTV/CAC ratio: 4.2x. Payback period: 8 months.
Marcus Weber handles investor relations and company strategy. Prefers concise bullet points.
Sarah Chen (CTO) leads engineering. Deep expertise in distributed systems and PostgreSQL.
Tom Richter (Head of Sales) manages the pipeline. Runs weekly review every Monday at 9 AM.`,

    'methods.txt': `Sales qualification uses BANT framework: Budget, Authority, Need, Timeline.
Customer onboarding follows 5 steps: Welcome call → Integration setup → Data migration → Training → Go-live sign-off.
Bug triage classification: P1 (data loss/security) → fix today, P2 (broken workflow) → fix this week, P3/P4 → next sprint.
Weekly standup format: What shipped → What's blocked → What's next. Keep under 15 minutes.
Enterprise proposals include: Technical overview, security questionnaire, SLA terms, pricing tiers, case studies.
Content calendar runs on a 2-week sprint: Week 1 = draft + review, Week 2 = publish + distribute.
Sprint planning uses T-shirt sizing (S/M/L/XL). Anything bigger than L gets broken into sub-tasks.
Cold email sequence: 3 touches over 10 days. Subject line A/B tested. Current best: 2.1% reply rate.
Monthly business review structure: Revenue → Product → Customers → Team → Outlook.
Churn prevention: Health score drops below 60 → Anna reaches out within 24 hours.`,

    'status.txt': `NovaConnect launch: March 15. Webhook system in progress (Jan, 3 days), rate limiting not started.
Series A fundraising: Term sheet received from Horizon Ventures. Due diligence prep at 70%.
API v3 migration: 80% complete. Breaking changes documented. Customer migration guide drafted.
Q1 hiring: 2 of 4 engineers hired (started April). 2 more interviews scheduled this week.
Marketing rebrand: Logo finalized. Website copy 60% done. Launch aligned with NovaConnect release.
Singapore pilot: 2 fintech prospects identified. Julia Bergmann offered portfolio introductions.
Infrastructure costs: Optimized in February. Saved €1.2K/mo by right-sizing Kubernetes pods.
Support backlog: 12 open tickets. 3 P2 (webhook + timezone + bulk import). Average resolution: 18 hours.`,

    'learnings.txt': `Batch API calls reduce latency by 60% compared to sequential requests. Implemented in NovaAPI v2.3.
Annual contracts with 15% discount reduce churn significantly. 78% of customers are still monthly — high risk.
Cold outreach converts at 2.1% reply rate. Best performing channel: LinkedIn + personalized follow-up.
Customer health score combining login frequency + support tickets + feature usage predicts churn 3 weeks early.
Solo pricing tier at €19/mo could capture price-sensitive segment without cannibalizing Starter (€49) revenue.
PostgreSQL JSONB outperforms document stores for our use case. 40% faster queries, simpler operations.
Markdown artifacts preferred over plain text for reports. Users engage 3x more with formatted output.
German-speaking markets respond better to "du" (informal) in product copy. Formal "Sie" in legal/enterprise.
Proactive downsell (offer smaller plan before churn) retains 40% of at-risk accounts.
Documentation with code examples gets 5x more page views than prose-only docs.`,
  };

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(memDir, filename), content, 'utf-8');
  }
  console.log(`  ✓ ${Object.keys(files).length} memory files created (knowledge, methods, status, learnings)`);
}

// ── CRM Contacts & Deals ────────────────────────────────────────

function seedCRM(ds: DataStore): void {
  console.log('\n👥 Seeding CRM (contacts, deals, interactions)...');
  const crm = new CRM(ds);
  crm.ensureSchema();

  const contacts = [
    { name: 'Michael Torres', email: 'michael@datavault.io', company: 'DataVault Corp', type: 'customer', source: 'email', language: 'en', notes: 'Enterprise CTO. Technical decision maker.', tags: '["enterprise","technical"]' },
    { name: 'Julia Bergmann', email: 'julia@horizonvc.com', company: 'Horizon Ventures', type: 'partner', source: 'web', language: 'de', notes: 'Series A lead investor. Met at Berlin Tech Week.', tags: '["investor","series-a"]' },
    { name: 'Nina Ortega', email: 'nina@greenleaf.co', company: 'GreenLeaf Retail', type: 'customer', source: 'email', language: 'en', notes: 'Inventory manager. Signed last month.', tags: '["mid-market"]' },
    { name: 'Felix Neumann', email: 'f.neumann@medtech-pro.de', company: 'MedTech Pro', type: 'customer', source: 'web', language: 'de', notes: 'Dr. Compliance-focused. Needs GDPR documentation.', tags: '["mid-market","compliance"]' },
    { name: 'Sophie Laurent', email: 'sophie@cloudbridge.io', company: 'CloudBridge', type: 'prospect', source: 'web', language: 'en', notes: 'Evaluating NovaPlatform. No response in 14 days.', tags: '["at-risk"]' },
    { name: 'Kenji Tanaka', email: 'kenji@techstart.sg', company: 'TechStart SG', type: 'lead', source: 'web', language: 'en', notes: 'Singapore fintech. Interested in NovaConnect API.', tags: '["singapore","fintech"]' },
    { name: 'Anna Fischer', email: 'anna.f@alpinedigital.ch', company: 'Alpine Digital', type: 'customer', source: 'manual', language: 'de', notes: 'Swiss agency. Uses NovaDash for client reporting.', tags: '["agency","swiss"]' },
    { name: 'Rajesh Patel', email: 'rajesh@flowmotion.io', company: 'FlowMotion', type: 'customer', source: 'email', language: 'en', notes: 'Heavy API user. Interested in API v3 batch endpoints.', tags: '["api-heavy"]' },
    { name: 'Lena Schmidt', email: 'lena@smartfactory.de', company: 'SmartFactory GmbH', type: 'customer', source: 'web', language: 'de', notes: 'Manufacturing IoT. Uses custom API integrations.', tags: '["enterprise","iot"]' },
    { name: 'Carlos Mendez', email: 'carlos@meridian.lat', company: 'Meridian Analytics', type: 'customer', source: 'email', language: 'en', notes: 'Beta tester for NovaConnect. Positive feedback.', tags: '["beta","analytics"]' },
    { name: 'Emma Wilson', email: 'emma@cloudnine.media', company: 'CloudNine Media', type: 'lead', source: 'web', language: 'en', notes: 'Content agency. Interested in NovaDash.', tags: '["media","lead"]' },
    { name: 'Thomas Huber', email: 'thomas@financehub.ch', company: 'FinanceHub AG', type: 'customer', source: 'manual', language: 'de', notes: 'Swiss fintech. Compliance and security priority.', tags: '["fintech","swiss"]' },
  ];

  for (const c of contacts) {
    crm.upsertContact({ name: c.name, email: c.email, company: c.company, type: c.type as any, source: c.source as any, language: c.language, notes: c.notes });
  }
  console.log(`  ✓ ${contacts.length} contacts created`);

  const deals = [
    { title: 'Enterprise Platform License', contact_name: 'Michael Torres', value: 120000, stage: 'won', next_action: 'Onboarding kickoff', due_date: daysAgo(-5).split('T')[0] },
    { title: 'Series A Investment', contact_name: 'Julia Bergmann', value: 2000000, stage: 'negotiation', next_action: 'Due diligence review', due_date: daysAgo(-14).split('T')[0] },
    { title: 'NovaPlatform Annual', contact_name: 'Nina Ortega', value: 28800, stage: 'won', next_action: '', due_date: '' },
    { title: 'MedTech Compliance Package', contact_name: 'Felix Neumann', value: 57600, stage: 'proposal', next_action: 'Send GDPR docs', due_date: daysAgo(-3).split('T')[0] },
    { title: 'CloudBridge Evaluation', contact_name: 'Sophie Laurent', value: 36000, stage: 'qualified', next_action: 'Re-engage', due_date: daysAgo(0).split('T')[0] },
    { title: 'Singapore Pilot', contact_name: 'Kenji Tanaka', value: 18000, stage: 'lead', next_action: 'Discovery call', due_date: daysAgo(-7).split('T')[0] },
    { title: 'FlowMotion API Upgrade', contact_name: 'Rajesh Patel', value: 42000, stage: 'proposal', next_action: 'Send migration guide', due_date: daysAgo(-5).split('T')[0] },
    { title: 'SmartFactory Integration', contact_name: 'Lena Schmidt', value: 84000, stage: 'negotiation', next_action: 'Technical review', due_date: daysAgo(-2).split('T')[0] },
  ];

  for (const d of deals) {
    crm.upsertDeal({ title: d.title, contact_name: d.contact_name, value: d.value, currency: 'EUR', stage: d.stage as any, next_action: d.next_action, due_date: d.due_date });
  }
  console.log(`  ✓ ${deals.length} deals created`);

  const interactions = [
    { contact_name: 'Michael Torres', type: 'meeting', channel: 'web', summary: 'Onboarding kickoff. Discussed integration timeline and SSO.', date: daysAgo(2) },
    { contact_name: 'Michael Torres', type: 'email', channel: 'email', summary: 'Sent enterprise API docs and security questionnaire.', date: daysAgo(5) },
    { contact_name: 'Julia Bergmann', type: 'meeting', channel: 'web', summary: 'Coffee with Marcus. Series A terms and portfolio synergies.', date: daysAgo(8) },
    { contact_name: 'Sophie Laurent', type: 'email', channel: 'email', summary: 'Follow-up on evaluation. No response yet.', date: daysAgo(14) },
    { contact_name: 'Felix Neumann', type: 'call', channel: 'manual', summary: 'GDPR compliance requirements. Needs DPA agreement.', date: daysAgo(6) },
    { contact_name: 'Kenji Tanaka', type: 'email', channel: 'web', summary: 'Inbound inquiry about NovaConnect for fintech workflows.', date: daysAgo(3) },
    { contact_name: 'Lena Schmidt', type: 'meeting', channel: 'web', summary: 'Technical deep-dive on IoT data integration with Jan.', date: daysAgo(4) },
    { contact_name: 'Carlos Mendez', type: 'email', channel: 'email', summary: 'NovaConnect beta feedback: positive on webhooks.', date: daysAgo(7) },
  ];

  for (const i of interactions) {
    crm.logInteraction({ contact_name: i.contact_name, type: i.type as any, channel: i.channel as any, summary: i.summary, date: i.date });
  }
  console.log(`  ✓ ${interactions.length} interactions created`);
}

// ── Tasks & Pipeline Runs ───────────────────────────────────────

function seedTasksAndPipelines(h: RunHistory): void {
  console.log('\n🔄 Seeding tasks & pipeline runs...');
  const db = h['db'] as import('better-sqlite3').Database;

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'medium',
      assignee TEXT DEFAULT 'lynox',
      scope_type TEXT, scope_id TEXT,
      due_date TEXT, tags TEXT DEFAULT '[]',
      parent_task_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      schedule_cron TEXT, next_run_at TEXT, last_run_at TEXT,
      last_run_result TEXT, last_run_status TEXT,
      task_type TEXT DEFAULT 'manual',
      watch_config TEXT, max_retries INTEGER DEFAULT 3, retry_count INTEGER DEFAULT 0,
      notification_channel TEXT, pipeline_id TEXT
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      manifest_name TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      manifest_json TEXT,
      total_duration_ms INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      total_tokens_in INTEGER DEFAULT 0, total_tokens_out INTEGER DEFAULT 0,
      step_count INTEGER DEFAULT 0, parent_run_id TEXT,
      error TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pipeline_step_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT DEFAULT 'success',
      result TEXT, error TEXT,
      duration_ms INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0
    );
  `);

  const tasks = [
    { title: 'Weekly sales pipeline review', status: 'completed', priority: 'high', assignee: 'lynox', task_type: 'scheduled', schedule_cron: '0 9 * * 1' },
    { title: 'Monitor competitor pricing pages', status: 'completed', priority: 'medium', assignee: 'lynox', task_type: 'watch' },
    { title: 'Daily customer health check', status: 'completed', priority: 'high', assignee: 'lynox', task_type: 'scheduled', schedule_cron: '0 8 * * *' },
    { title: 'Send DataVault enterprise quote', status: 'completed', priority: 'urgent', assignee: 'user', task_type: 'manual' },
    { title: 'Prepare March business review', status: 'completed', priority: 'high', assignee: 'lynox', task_type: 'manual' },
    { title: 'Monthly churn risk analysis', status: 'completed', priority: 'medium', assignee: 'lynox', task_type: 'scheduled', schedule_cron: '0 9 1 * *' },
    { title: 'Re-engage CloudBridge', status: 'open', priority: 'high', assignee: 'user', task_type: 'manual' },
    { title: 'NovaConnect launch checklist', status: 'in_progress', priority: 'urgent', assignee: 'lynox', task_type: 'manual' },
    { title: 'Discovery calls with Berlin leads', status: 'open', priority: 'medium', assignee: 'user', task_type: 'manual' },
    { title: 'Weekly content publishing', status: 'completed', priority: 'low', assignee: 'lynox', task_type: 'scheduled', schedule_cron: '0 10 * * 3' },
  ];

  const insertTask = db.prepare(`INSERT OR REPLACE INTO tasks (id,title,status,priority,assignee,task_type,schedule_cron,last_run_status,scope_type,scope_id,created_at,updated_at,completed_at,last_run_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const t of tasks) {
    const id = randomUUID().slice(0, 8);
    const created = daysAgo(randomBetween(5, 40));
    const completed = t.status === 'completed' ? daysAgo(randomBetween(0, 5)) : null;
    const lastRun = t.task_type === 'scheduled' ? daysAgo(randomBetween(0, 3)) : null;
    insertTask.run(id, t.title, t.status, t.priority, t.assignee, t.task_type, t.schedule_cron ?? null, t.status === 'completed' ? 'completed' : null, 'context', CONTEXT_ID, created, daysAgo(randomBetween(0, 3)), completed, lastRun);
  }
  console.log(`  ✓ ${tasks.length} tasks created`);

  const pipelines = [
    { name: 'Weekly Sales Pipeline Review', steps: ['memory_recall', 'data_store_query', 'web_search', 'artifact_save'] },
    { name: 'Customer Health Analysis', steps: ['data_store_query', 'memory_recall', 'data_store_aggregate'] },
    { name: 'Monthly Business Review', steps: ['data_store_query', 'data_store_aggregate', 'memory_recall', 'artifact_save', 'send_email'] },
    { name: 'Competitor Price Monitor', steps: ['web_search', 'memory_recall', 'memory_store'] },
    { name: 'Daily Email Triage', steps: ['gmail_search', 'memory_recall', 'send_email'] },
    { name: 'Lead Qualification Report', steps: ['data_store_query', 'web_search', 'memory_recall', 'artifact_save'] },
    { name: 'Churn Risk Alert', steps: ['data_store_query', 'data_store_aggregate', 'send_email'] },
    { name: 'NovaConnect Launch Tracker', steps: ['memory_recall', 'data_store_query', 'calendar'] },
  ];

  const insertPipeline = db.prepare(`INSERT INTO pipeline_runs (id,manifest_name,status,manifest_json,step_count,total_duration_ms,total_cost_usd,total_tokens_in,total_tokens_out,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertStep = db.prepare(`INSERT INTO pipeline_step_results (pipeline_run_id,step_id,status,duration_ms,tokens_in,tokens_out,cost_usd) VALUES (?,?,?,?,?,?,?)`);

  let totalPipelineRuns = 0;
  for (const p of pipelines) {
    const manifest = JSON.stringify({ name: p.name, steps: p.steps.map(s => ({ id: s, tool: s })) });
    for (let r = 0; r < randomBetween(3, 8); r++) {
      const runId = randomUUID();
      const started = daysAgo(randomBetween(1, 60));
      const dur = p.steps.length * randomBetween(2000, 8000);
      const tIn = p.steps.length * randomBetween(800, 3000);
      const tOut = p.steps.length * randomBetween(300, 1500);
      const cost = tIn * 0.000003 + tOut * 0.000015;
      insertPipeline.run(runId, p.name, 'completed', manifest, p.steps.length, dur, cost, tIn, tOut, started, started);
      for (const step of p.steps) {
        insertStep.run(runId, step, 'success', randomBetween(1000, 8000), randomBetween(500, 3000), randomBetween(200, 1500), cost / p.steps.length);
      }
      totalPipelineRuns++;
    }
  }
  console.log(`  ✓ ${totalPipelineRuns} pipeline runs (${pipelines.length} workflows)`);
}

// ── API Profiles Cleanup ────────────────────────────────────────

function cleanApiProfiles(): void {
  console.log('\n🔌 Cleaning API profiles...');
  const apisDir = join(LYNOX_DIR, 'apis');
  if (existsSync(apisDir)) {
    const files = readdirSync(apisDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      rmSync(join(apisDir, f));
    }
    console.log(`  ✓ Removed ${files.length} old API profiles`);
  } else {
    mkdirSync(apisDir, { recursive: true });
    console.log('  ✓ Created apis directory');
  }
}

// ── Main ────────────────────────────────────────────────────────

function main(): void {
  console.log('🌱 lynox Test Data Seeder');
  console.log('========================');
  console.log(`Mode: ${CLEAN ? 'CLEAN (wipe + seed)' : 'APPEND (add to existing)'}`);
  console.log(`Target: ${LYNOX_DIR}`);

  // Step 1: Backup
  console.log('\n💾 Backing up databases...');
  backupDatabases();

  if (CLEAN) {
    console.log('\n🧹 Cleaning databases & files...');
    for (const name of ['agent-memory.db', 'history.db', 'datastore.db']) {
      const p = join(LYNOX_DIR, name);
      if (existsSync(p)) {
        unlinkSync(p);
        for (const ext of ['-wal', '-shm']) {
          const walPath = p + ext;
          if (existsSync(walPath)) unlinkSync(walPath);
        }
        console.log(`  ✓ Removed ${name}`);
      }
    }
    // Clean memory files
    const memDir = join(LYNOX_DIR, 'memory');
    if (existsSync(memDir)) {
      rmSync(memDir, { recursive: true });
      console.log('  ✓ Removed memory files');
    }
    // Clean API profiles
    cleanApiProfiles();
  }

  // Step 2: Open databases
  const memDb = new AgentMemoryDb(join(LYNOX_DIR, 'agent-memory.db'));
  const runHistory = new RunHistory(join(LYNOX_DIR, 'history.db'));
  const dataStore = new DataStore(join(LYNOX_DIR, 'datastore.db'));

  try {
    // Step 3: Seed
    seedAgentMemory(memDb);
    seedRunHistory(runHistory);
    seedTasksAndPipelines(runHistory);
    seedDataStore(dataStore);
    seedCRM(dataStore);
    seedMemoryFiles();

    // Step 4: Run pattern detection + KPI computation
    console.log('\n🧠 Running pattern detection & KPI computation...');
    const patternEngine = new PatternEngine(runHistory, memDb);
    const newPatterns = patternEngine.detectPatterns();
    patternEngine.computeKPIs();
    console.log(`  ✓ ${newPatterns} new patterns detected from run history`);
    console.log('  ✓ KPIs computed');

    // Step 5: Summary
    console.log('\n✅ Seeding complete!');
    console.log('─'.repeat(50));

    // Count everything
    const counts = {
      entities: memDb.getEntityCount(),
      relations: memDb.getRelationCount(),
      patterns: memDb.getPatternCount(),
      memories: (memDb as any).db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt,
      metrics: (memDb as any).db.prepare('SELECT COUNT(*) as cnt FROM metrics').get().cnt,
      runs: (runHistory as any).db.prepare('SELECT COUNT(*) as cnt FROM runs').get().cnt,
      toolCalls: (runHistory as any).db.prepare('SELECT COUNT(*) as cnt FROM run_tool_calls').get().cnt,
      threads: (runHistory as any).db.prepare('SELECT COUNT(*) as cnt FROM threads').get().cnt,
      messages: (runHistory as any).db.prepare('SELECT COUNT(*) as cnt FROM thread_messages').get().cnt,
    };

    console.log(`  agent-memory.db:`);
    console.log(`    Entities:  ${counts.entities}`);
    console.log(`    Relations: ${counts.relations}`);
    console.log(`    Memories:  ${counts.memories}`);
    console.log(`    Patterns:  ${counts.patterns}`);
    console.log(`    Metrics:   ${counts.metrics}`);
    console.log(`  history.db:`);
    console.log(`    Runs:       ${counts.runs}`);
    console.log(`    Tool Calls: ${counts.toolCalls}`);
    console.log(`    Threads:    ${counts.threads}`);
    console.log(`    Messages:   ${counts.messages}`);
    const crmCounts = {
      contacts: (dataStore as any).db.prepare("SELECT COUNT(*) as cnt FROM ds_contacts").get()?.cnt ?? 0,
      deals: (dataStore as any).db.prepare("SELECT COUNT(*) as cnt FROM ds_deals").get()?.cnt ?? 0,
      interactions: (dataStore as any).db.prepare("SELECT COUNT(*) as cnt FROM ds_interactions").get()?.cnt ?? 0,
      tasks: (runHistory as any).db.prepare('SELECT COUNT(*) as cnt FROM tasks').get()?.cnt ?? 0,
      pipelines: (runHistory as any).db.prepare('SELECT COUNT(*) as cnt FROM pipeline_runs').get()?.cnt ?? 0,
    };
    console.log(`  datastore.db:`);
    console.log(`    Collections: leads, revenue, product_metrics, support_tickets, okrs`);
    console.log(`    CRM: ${crmCounts.contacts} contacts, ${crmCounts.deals} deals, ${crmCounts.interactions} interactions`);
    console.log(`  tasks & workflows:`);
    console.log(`    Tasks:     ${crmCounts.tasks}`);
    console.log(`    Pipelines: ${crmCounts.pipelines}`);
    console.log(`  memory files: knowledge, methods, status, learnings`);

  } finally {
    memDb.close();
    runHistory.close();
    (dataStore as any).db.close();
  }
}

main();
