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
// Memory scope: use 'global' so data is visible without a specific contextId.
// Engines without LYNOX_CONTEXT_ID read from global scope.
const SCOPE_TYPE = 'global';
const SCOPE_ID = 'global';

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

/**
 * Compute daily/weekly/all-time metrics from actual run data in history.db.
 * This ensures Insights charts and forecasts are consistent with seeded runs.
 */
function computeMetricsFromRuns(memDb: AgentMemoryDb, runHistory: RunHistory): number {
  const histDb = (runHistory as any).db as import('better-sqlite3').Database;
  const agentDb = (memDb as any).db as import('better-sqlite3').Database;
  const stmtInsert = agentDb.prepare(`
    INSERT INTO metrics (id, metric_name, scope_type, scope_id, value, sample_count, window, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;

  // ── Daily metrics (last 90 days) ──
  const dailyRows = histDb.prepare(`
    SELECT date(created_at) as day,
           COUNT(*) as total,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
           AVG(duration_ms) as avg_dur,
           SUM(cost_usd) as total_cost
    FROM runs
    GROUP BY day
    ORDER BY day
  `).all() as Array<{ day: string; total: number; completed: number; avg_dur: number; total_cost: number }>;

  for (const row of dailyRows) {
    const date = new Date(row.day + 'T12:00:00Z').toISOString();
    const successRate = row.total > 0 ? row.completed / row.total : 0;
    stmtInsert.run(randomUUID(), 'success_rate', SCOPE_TYPE, SCOPE_ID, successRate, row.total, 'daily', date);
    stmtInsert.run(randomUUID(), 'avg_duration_ms', SCOPE_TYPE, SCOPE_ID, row.avg_dur, row.total, 'daily', date);
    stmtInsert.run(randomUUID(), 'total_cost_usd', SCOPE_TYPE, SCOPE_ID, row.total_cost, row.total, 'daily', date);
    count += 3;
  }

  // ── Weekly metrics (last 12 weeks) ──
  const weeklyRows = histDb.prepare(`
    SELECT strftime('%Y-W%W', created_at) as week,
           MIN(date(created_at)) as week_start,
           COUNT(*) as total,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
           AVG(duration_ms) as avg_dur,
           SUM(cost_usd) as total_cost
    FROM runs
    GROUP BY week
    ORDER BY week
  `).all() as Array<{ week: string; week_start: string; total: number; completed: number; avg_dur: number; total_cost: number }>;

  for (const row of weeklyRows) {
    const date = new Date(row.week_start + 'T12:00:00Z').toISOString();
    const successRate = row.total > 0 ? row.completed / row.total : 0;
    stmtInsert.run(randomUUID(), 'success_rate', SCOPE_TYPE, SCOPE_ID, successRate, row.total, 'weekly', date);
    stmtInsert.run(randomUUID(), 'avg_duration_ms', SCOPE_TYPE, SCOPE_ID, row.avg_dur, row.total, 'weekly', date);
    stmtInsert.run(randomUUID(), 'total_cost_usd', SCOPE_TYPE, SCOPE_ID, row.total_cost, row.total, 'weekly', date);
    count += 3;
  }

  // ── All-time aggregates ──
  const allTime = histDb.prepare(`
    SELECT COUNT(*) as total_runs,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
           AVG(duration_ms) as avg_dur,
           SUM(cost_usd) as total_cost
    FROM runs
  `).get() as { total_runs: number; completed: number; avg_dur: number; total_cost: number };

  const threadCount = histDb.prepare(`SELECT COUNT(*) as cnt FROM threads`).get() as { cnt: number };

  memDb.upsertMetric({ metricName: 'total_runs', value: allTime.total_runs, sampleCount: allTime.total_runs, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
  memDb.upsertMetric({ metricName: 'success_rate', value: allTime.completed / allTime.total_runs, sampleCount: allTime.total_runs, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
  memDb.upsertMetric({ metricName: 'avg_duration_ms', value: allTime.avg_dur, sampleCount: allTime.total_runs, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
  memDb.upsertMetric({ metricName: 'total_cost_usd', value: allTime.total_cost, sampleCount: allTime.total_runs, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
  memDb.upsertMetric({ metricName: 'cost_per_run', value: allTime.total_cost / allTime.total_runs, sampleCount: allTime.total_runs, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
  memDb.upsertMetric({ metricName: 'avg_runs_per_thread', value: allTime.total_runs / threadCount.cnt, sampleCount: threadCount.cnt, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
  count += 6;

  // ── Tool usage (from actual tool calls) ──
  const toolRows = histDb.prepare(`
    SELECT tool_name, COUNT(*) as cnt
    FROM run_tool_calls
    GROUP BY tool_name
  `).all() as Array<{ tool_name: string; cnt: number }>;

  for (const t of toolRows) {
    memDb.upsertMetric({ metricName: `tool_usage.${t.tool_name}`, value: t.cnt, sampleCount: allTime.total_runs, window: 'all_time', scopeType: SCOPE_TYPE, scopeId: SCOPE_ID });
    count++;
  }

  return count;
}

function seedAgentMemory(db: AgentMemoryDb, runHistory: RunHistory): void {
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

  // ── Metrics — computed from actual seeded run data ──
  // Note: runs must be seeded in history.db BEFORE calling this function
  console.log('  Computing metrics from actual run data...');
  const metricCount = computeMetricsFromRuns(db, runHistory);
  console.log(`  ✓ ${metricCount} metrics created (daily + weekly + all_time from real runs)`);
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
  'Series A Due Diligence Prep': [
    { role: 'user', content: 'Horizon Ventures sent a due diligence checklist. What do they need?' },
    { role: 'assistant', content: '**Due Diligence Checklist — Horizon Ventures**\n\nI matched their request against our existing docs:\n\n**✅ Ready to share (8/14)**\n- Cap table & incorporation docs\n- Financial statements (2024-2025)\n- Customer contracts (anonymized)\n- Employee agreements\n- Privacy policy & DPA\n- Technical architecture diagram\n- SOC 2 readiness report\n- IP assignment agreements\n\n**📋 Need preparation (6/14)**\n1. Revenue cohort analysis — I can generate this from DataStore\n2. Customer concentration risk — top 10 customers by revenue\n3. Competitor landscape — need Marcus\'s input\n4. Key person dependencies — org chart with bus factor\n5. Churn analysis by segment — available, need to format\n6. 3-year financial model — Elena has a draft\n\nShall I start with the revenue cohort and churn analysis?' },
    { role: 'user', content: 'Yes, generate both and send everything that\'s ready to Julia.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ **Revenue cohort analysis** generated — 12 monthly cohorts, net retention 112%, saved as artifact\n- ✅ **Churn analysis** — breakdown by plan tier, company size, geography. Key insight: annual customers churn 3x less\n- ✅ **Data room** — uploaded 8 ready documents to shared folder\n- 📧 Email sent to Julia: "Due diligence materials — first batch"\n\nRemaining 4 items need human input. I created tasks for Marcus (competitor landscape) and Elena (financial model).' },
  ],
  'API Redesign Sprint Planning': [
    { role: 'user', content: 'The API v2 redesign starts next sprint. Plan it.' },
    { role: 'assistant', content: '**API v3 Sprint Plan — 2 weeks**\n\nBased on the 47 GitHub issues tagged "api-v3" and customer feedback:\n\n**Sprint 1 (Week 1-2):**\n\n| Task | Owner | Est | Priority |\n|------|-------|-----|----------|\n| RESTful resource naming | Jan | 2d | P0 |\n| Pagination (cursor-based) | Jan | 1d | P0 |\n| Rate limiting per tier | Oliver | 2d | P0 |\n| Webhook 2.0 (retry + signing) | Oliver | 3d | P1 |\n| Batch endpoints | Jan | 2d | P1 |\n| OpenAPI spec generation | Jan | 1d | P2 |\n\n**Breaking changes:**\n- `/api/v2/*` → `/api/v3/*` (v2 deprecated, 6-month sunset)\n- Auth: API key in header (not query param)\n- Response format: envelope `{data, meta, errors}`\n\n**Migration:**\n- Auto-migration tool for existing integrations\n- v2 → v3 compatibility shim for the transition period\n\nTotal: 11 dev-days across 2 engineers. Want me to create the tickets?' },
    { role: 'user', content: 'Create all tickets and notify the team.' },
    { role: 'assistant', content: 'Created:\n\n- ✅ 6 tickets in the sprint board with estimates and assignments\n- ✅ Sprint goal set: "Ship API v3 beta to staging"\n- 📧 Notified Jan + Oliver with sprint overview\n- 📋 Migration guide draft started — I\'ll update it as endpoints change\n- 📅 Demo scheduled for sprint review (Friday, Week 2)\n\nI\'ll track velocity and alert you if we\'re at risk of not completing P0 items.' },
  ],
  'Marketing Rebrand Coordination': [
    { role: 'user', content: 'Lisa wants to rebrand NovaTech. What\'s involved?' },
    { role: 'assistant', content: '**Rebrand Scope Assessment**\n\nI audited all brand touchpoints:\n\n**Digital (estimated 3-4 weeks)**\n- Website: 23 pages with current branding\n- Product UI: Logo, colors, fonts in 14 views\n- Email templates: 8 transactional + 4 marketing\n- Social profiles: LinkedIn, Twitter, GitHub\n- Documentation site: header, footer, favicon\n\n**Legal (1-2 weeks parallel)**\n- Trademark search for new name\n- Update contracts & invoices\n- Privacy policy & terms\n- Domain registration\n\n**Materials (1 week)**\n- Pitch deck\n- Business cards\n- Email signatures\n- Brand guidelines PDF\n\n**Risk:** Customer confusion during transition. Recommend:\n1. Announcement email 2 weeks before\n2. "Formerly NovaTech" badge for 3 months\n3. Redirect old domain for 1 year\n\nTotal timeline: **5-6 weeks**. Budget estimate: €8-12K (design + legal).' },
  ],
  'Performance Sprint Retrospective': [
    { role: 'user', content: 'Run the retrospective for the performance sprint.' },
    { role: 'assistant', content: '**Performance Sprint Retro — Results**\n\nI compiled the metrics and team feedback:\n\n**🎯 Goals vs Results:**\n| Metric | Goal | Before | After | |\n|--------|------|--------|-------|-|\n| API p95 latency | <200ms | 340ms | 180ms | ✅ |\n| Page load (LCP) | <2s | 3.1s | 1.8s | ✅ |\n| DB query avg | <50ms | 120ms | 35ms | ✅ |\n| Memory usage | <512MB | 780MB | 420MB | ✅ |\n| Error rate | <0.1% | 0.3% | 0.08% | ✅ |\n\n**What went well:**\n- Database index optimization had 3x more impact than expected\n- Jan\'s connection pooling fix resolved the memory leak\n- Load testing caught 2 issues before production\n\n**What didn\'t:**\n- Image optimization was descoped (not enough time)\n- CDN setup blocked by DNS migration (external dependency)\n\n**Action items:**\n- Image optimization → next sprint (David)\n- CDN → waiting on DNS provider (Oliver tracking)' },
  ],
  'GDPR Compliance Checklist': [
    { role: 'user', content: 'We need to verify GDPR compliance before the enterprise push. Run the checklist.' },
    { role: 'assistant', content: '**GDPR Compliance Audit**\n\n**✅ Compliant (9/13)**\n- Data Processing Agreement (DPA) template ready\n- Privacy policy covers all data categories\n- Cookie consent banner (Klaro) implemented\n- Data encryption at rest (AES-256) and in transit (TLS 1.3)\n- Right to access: export endpoint exists\n- Right to deletion: delete endpoint exists\n- Data breach notification process documented\n- Sub-processor list maintained\n- DPO contact published\n\n**⚠️ Gaps (4/13)**\n1. **Data retention policy** — no auto-deletion after X days\n2. **Consent records** — we track consent but don\'t log changes\n3. **DPIA** — not completed for the AI processing pipeline\n4. **Cross-border transfers** — need SCCs for US sub-processors\n\nGaps 1-2 are engineering work (~3 days). Gaps 3-4 need legal review.\n\nShall I create tasks and draft the data retention policy?' },
    { role: 'user', content: 'Yes, and schedule a legal review with Elena.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ Task: "Implement data retention auto-deletion" → Jan, 2 days\n- ✅ Task: "Add consent change logging" → Jan, 1 day\n- ✅ Draft: Data Retention Policy (30/90/365 day tiers) — saved as artifact\n- 📅 Legal review with Elena: Thursday 10 AM (DPIA + SCCs)\n- 📋 DPIA questionnaire pre-filled with our AI pipeline details\n\nAfter Elena\'s review, we should be fully compliant. I\'ll track all 4 gaps to completion.' },
  ],
  'Mobile MVP Feature Prioritization': [
    { role: 'user', content: 'We\'re building NovaMobile. Prioritize the MVP features.' },
    { role: 'assistant', content: '**NovaMobile MVP — Feature Prioritization**\n\nI analyzed customer requests (127 mentions), competitor apps, and development effort:\n\n**Must-have (MVP) — 4 weeks**\n1. Dashboard overview (daily KPIs, pipeline)\n2. Push notifications (deal updates, alerts)\n3. Quick actions (approve, reply, reassign)\n4. Contact lookup + call logging\n5. Offline mode for basic data access\n\n**Should-have (v1.1) — 2 weeks**\n6. Voice notes → text transcription\n7. Document scanner (receipts, contracts)\n8. Calendar integration\n\n**Nice-to-have (v1.2)**\n9. AR business card scanner\n10. Widgets (iOS/Android)\n\n**Technical decisions:**\n- React Native (shared codebase, 1 dev)\n- API: reuse existing v3 endpoints\n- Auth: biometric + existing session\n\nDavid can ship the MVP in 4 weeks if we start Monday. Want me to create the sprint board?' },
    { role: 'user', content: 'Create the board and assign David. Skip AR scanner, not worth it.' },
    { role: 'assistant', content: 'Created:\n\n- ✅ Sprint board "NovaMobile MVP" with 5 must-have stories\n- ✅ Assigned to David, sprint starts Monday\n- ✅ Removed AR scanner from backlog\n- 📋 Technical spec draft for offline mode (the trickiest part)\n- 📅 Design review with David: Wednesday 2 PM\n\nI\'ll track sprint velocity and flag any blockers. TestFlight/Play Store beta target: 4 weeks from Monday.' },
  ],
  'Infrastructure Cost Optimization': [
    { role: 'user', content: 'Our infra costs are growing faster than revenue. Find savings.' },
    { role: 'assistant', content: '**Infrastructure Cost Analysis**\n\nMonthly spend: **€4,280** (+23% MoM, revenue grew 8%)\n\n**Top savings opportunities:**\n\n| Action | Savings | Effort | Risk |\n|--------|---------|--------|------|\n| Reserved instances (1yr) | €540/mo | Low | None |\n| Right-size DB (8GB→4GB) | €45/mo | Low | Monitor |\n| Move embeddings to local ONNX | €120/mo | Medium | Test |\n| API response caching (15min) | €380/mo | Medium | Stale data |\n| Compress log retention (90→30d) | €25/mo | Low | Compliance |\n| **Total potential** | **€1,110/mo** | | |\n\n**Quick wins (this week, €585/mo):**\n- Reserved instances: commit now, saves immediately\n- Right-size DB: current usage is 1.2GB of 8GB\n- Log compression: 30 days is enough for debugging\n\n**Projected after optimization:** €3,170/mo (26% reduction)' },
    { role: 'user', content: 'Do the quick wins. Hold off on caching — stale data risk is too high.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ Reserved instances committed — saves €540/mo starting next billing cycle\n- ✅ DB resized to 4GB — monitoring dashboard set up, alert at 80% usage\n- ✅ Log retention changed to 30 days — old logs archived to cold storage\n- ✅ ONNX migration ticket created for Oliver (€120/mo savings, medium effort)\n\nProjected new monthly spend: **€3,695** (↓14%). I\'ll track costs weekly and alert you if spending exceeds €4K.' },
  ],
  'Investor Update Draft': [
    { role: 'user', content: 'Draft the monthly investor update for our angels.' },
    { role: 'assistant', content: '**Investor Update — March 2026**\n\n📊 **Highlights**\n- MRR: €47.2K (+8.3% MoM) — on track for €55K by Q2\n- Closed DataVault (€120K ARR) — our first enterprise deal\n- NovaConnect launched in beta — 3 partners onboarded\n- Hired 2 senior engineers (start April)\n\n💰 **Financials**\n- Revenue: €47.2K MRR / €566K ARR run-rate\n- Burn: €32K/mo\n- Runway: 26 months\n- CAC payback: 9 months (improving)\n\n🚀 **Product**\n- Shipped 14 features, 99.94% uptime\n- API v3 in development (ships April)\n- NovaMobile MVP starting next week\n\n🤝 **Ask**\nIntroductions to: enterprise SaaS buyers in DACH, fintech companies needing workflow automation.\n\n📅 **Next month**\n- Series A conversations starting (Horizon Ventures, 2 others)\n- NovaConnect public launch March 15\n\nShall I send this to the distribution list?' },
    { role: 'user', content: 'Looks great. Send it.' },
    { role: 'assistant', content: 'Sent:\n\n- ✅ Email sent to 8 angel investors\n- ✅ PDF version saved as artifact\n- ✅ Metrics snapshot stored in DataStore for historical tracking\n- 📅 Reminder set: April 1 — next investor update\n\nTwo investors replied within the hour — I\'ll flag anything that needs your response.' },
  ],
  'Customer Health Score Review': [
    { role: 'user', content: 'Show me which customers are at risk right now.' },
    { role: 'assistant', content: '**Customer Health Scores — At-Risk Accounts**\n\n4 accounts scored below 60 (threshold for "at risk"):\n\n| Customer | Score | MRR | Warning Signs |\n|----------|-------|-----|---------------|\n| CloudBridge | 35 | €3K | No login 14d, support ticket unresolved |\n| TechStart | 42 | €1.2K | Usage dropped 60%, downgrade inquiry |\n| FlowMotion | 55 | €3.5K | Key contact left, new buyer evaluating |\n| Alpine Digital | 58 | €0.8K | Payment failed twice, no response to emails |\n\n**Total at-risk MRR: €8.5K** (18% of total MRR)\n\n**Health score formula:**\n- Login frequency (30%) — daily=100, weekly=60, monthly=20\n- Support tickets (20%) — open P1/P2 = -40pts\n- Feature usage (25%) — active features / available features\n- Billing health (15%) — payment failures = -50pts\n- Engagement (10%) — response to emails, NPS survey' },
    { role: 'user', content: 'Create a save plan for each account.' },
    { role: 'assistant', content: 'Save plans created:\n\n**CloudBridge (€3K) — Executive outreach**\n- ✅ Escalation email from Marcus to their VP Engineering\n- 📅 Call scheduled: Tomorrow 3 PM\n- 📋 Prepared: usage report showing their ROI\n\n**TechStart (€1.2K) — Proactive downsell**\n- ✅ Anna will offer Starter plan (€49→€29) to retain\n- Better to keep them at €29 than lose €1.2K\n\n**FlowMotion (€3.5K) — Relationship rebuild**\n- ✅ Identified new buyer: Sara Kim (Head of Ops)\n- 📧 Intro email drafted, pending Tom\'s review\n- 📋 Custom onboarding for the new stakeholder\n\n**Alpine Digital (€0.8K) — Payment recovery**\n- ✅ Dunning email sequence started (3 emails over 10 days)\n- If no response after 10 days → flag for churn\n\nI\'ll update health scores daily and alert you on any changes.' },
  ],
  'Hiring Pipeline Management': [
    { role: 'user', content: 'We have 3 open positions. Status update.' },
    { role: 'assistant', content: '**Hiring Pipeline — 3 Open Positions**\n\n**1. Senior Backend Engineer**\n- 📊 Funnel: 45 applications → 12 screened → 4 interviews → 2 final round\n- 🏆 Top candidates:\n  - Alex Chen — 8yr Go/TS, ex-Stripe, strong system design\n  - Maria Kovac — 6yr, ex-Vercel, excellent references\n- ⏰ Timeline: Final interviews this week, offer by Friday\n\n**2. Product Designer**\n- 📊 Funnel: 28 applications → 8 screened → 3 interviews\n- Challenge: Salary expectations 15% above budget\n- Next: Portfolio reviews scheduled Tuesday\n\n**3. Customer Success Manager**\n- 📊 Funnel: 52 applications → 15 screened → 5 interviews → 1 final\n- 🏆 Top candidate: Lena Weber — 4yr SaaS CS, speaks DE/EN/FR\n- ⏰ Offer sent yesterday, waiting for response\n\n**Cost:** Recruiter fees for Backend role: €12K. Others via job boards: €2K total.' },
    { role: 'user', content: 'Extend offers to Alex and Lena. Increase designer budget by 10%.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ Offer letter sent to **Alex Chen** — Senior Backend, €85K + 0.3% equity\n- ✅ Follow-up sent to **Lena Weber** — CS Manager, asking for decision by Friday\n- ✅ Designer budget updated: €65K → €71.5K (+10%)\n- 📧 Notified recruiter about new designer budget range\n- 📅 Alex onboarding prep: desk, equipment order, accounts — starts April 1 if accepted\n\nI\'ll track responses and alert you immediately when they reply.' },
  ],
  'Content Marketing Strategy': [
    { role: 'user', content: 'Our blog gets 3K views/month. How do we 10x it?' },
    { role: 'assistant', content: '**Content Growth Strategy — 3K → 30K views/month**\n\nI analyzed your current content and top SaaS blogs in the space:\n\n**Current issues:**\n- Publishing 2x/month (competitors: 8-12x/month)\n- No SEO strategy (only 3 pages rank on Google page 1)\n- No content distribution beyond posting links\n\n**Phase 1: Foundation (Month 1-2)**\n1. Keyword research: 50 target keywords mapped to content\n2. Publish 2x/week (mix of SEO + thought leadership)\n3. Update 5 existing posts with better keywords\n\n**Phase 2: Distribution (Month 2-3)**\n4. Repurpose blog → LinkedIn posts, Twitter threads\n5. Guest posts on 3 industry blogs\n6. Email newsletter (bi-weekly)\n\n**Phase 3: Scale (Month 3-6)**\n7. Community content (customer stories, use cases)\n8. Video content (YouTube shorts, product demos)\n9. Webinar series with partners\n\n**Expected trajectory:**\n- Month 1: 5K (SEO improvements kick in)\n- Month 3: 12K (distribution multiplier)\n- Month 6: 25-35K (compounding)\n\nLisa can handle Phase 1 alone. Phase 2+ needs a freelance writer (€2K/month).' },
  ],
  'OKR Progress Review': [
    { role: 'user', content: 'Pull up our OKRs. How are we doing overall?' },
    { role: 'assistant', content: '**Q1 2026 OKR Summary — Week 11 of 13**\n\n| Objective | Progress | Status |\n|-----------|----------|--------|\n| O1: €50K MRR | 94% (€47.2K) | 🟡 Stretch |\n| O2: Ship NovaConnect | 85% | 🟢 On track |\n| O3: Team NPS >70 | 68/70 | 🟡 Close |\n| O4: Series A prep | 70% | 🟡 Active |\n\n**Overall: 82%** — solid quarter, 2 objectives likely to hit, 2 are stretch.\n\n**Key risks in final 2 weeks:**\n- MRR gap (€2.8K) depends on FlowMotion closing this week\n- Team NPS: 2 points away — the new hire onboarding experience might tip it\n- Series A: 3 more investor meetings needed\n\n**Bright spots:**\n- NovaConnect ahead of schedule\n- Customer churn at all-time low (2.8%)\n- DataVault deal exceeded target by €30K' },
    { role: 'user', content: 'What do we need to do to hit O1?' },
    { role: 'assistant', content: 'To close the **€2.8K MRR gap** in 2 weeks:\n\n**High-confidence (€2.1K):**\n1. FlowMotion API upgrade — €3.5K, proposal sent, decision expected Thursday\n2. GreenLeaf Retail upsell — €400, Anna has verbal commitment\n\n**Medium-confidence (€1.8K):**\n3. SmartFactory integration — €7K, but timeline uncertain\n4. 2 self-serve signups/week at avg €200 = €800\n\n**Actions I\'m taking:**\n- ✅ Reminded Tom about FlowMotion follow-up\n- ✅ Anna sending GreenLeaf invoice today\n- 📋 Fast-track: SmartFactory can do a 1-month pilot at €1.2K to get MRR on the books\n\nIf FlowMotion closes + GreenLeaf upsell: €47.2K + €3.9K = **€51.1K** — target exceeded.\n\nWorst case without FlowMotion: €48.4K (96.8% of target). Still a strong quarter.' },
  ],
  'Product Demo Preparation': [
    { role: 'user', content: 'I have a product demo for a prospect tomorrow. Help me prepare.' },
    { role: 'assistant', content: '**Demo Prep — MedTech Pro**\n\nI pulled their info from the CRM:\n\n**Company:** MedTech Pro GmbH (Munich)\n**Contact:** Felix Neumann (CTO)\n**Stage:** Proposal (€57.6K ARR)\n**Their pain:** Manual compliance reporting takes 3 FTEs, error-prone\n\n**Tailored demo script (15 min):**\n1. **Hook (2 min):** Show how lynox auto-generates compliance reports from their data\n2. **Core flow (8 min):**\n   - Import their sample dataset (I prepared a sanitized version)\n   - Run a compliance check workflow\n   - Generate audit trail + PDF report\n3. **Wow moment (3 min):** Show the knowledge graph connecting their regulatory requirements to data sources\n4. **Close (2 min):** Pricing, timeline, next steps\n\n**Objection prep:**\n- "Is it GDPR compliant?" → Yes, show our DPA + data residency options\n- "Can it integrate with SAP?" → Yes, via API. Show webhook integration\n- "What about data security?" → Show vault encryption + audit trail\n\nWant me to create a demo environment with their sample data?' },
    { role: 'user', content: 'Yes, set up the demo environment.' },
    { role: 'assistant', content: 'Demo environment ready:\n\n- ✅ Sandbox workspace "MedTech Demo" created\n- ✅ Sample dataset loaded (50 compliance records, anonymized)\n- ✅ 3 demo workflows pre-configured:\n  - "Daily Compliance Check"\n  - "Generate Audit Report"\n  - "Regulatory Change Monitor"\n- ✅ Knowledge graph seeded with medical device regulations (MDR, ISO 13485)\n- 📋 Demo script saved as artifact — print for reference\n\n**Login:** demo-medtech.novanova.app\n**Access:** felix.neumann@medtech-pro.de (temporary)\n\nGood luck tomorrow! I\'ll archive the demo environment after 7 days.' },
  ],
  'Security Audit Follow-up': [
    { role: 'user', content: 'What\'s the status on the security audit findings from last month?' },
    { role: 'assistant', content: '**Security Audit Follow-up — 14 findings**\n\n**✅ Resolved (10/14)**\n1. Upgraded TLS to 1.3 only\n2. Added CSP headers\n3. Fixed SQL injection in search endpoint\n4. Enabled rate limiting on all public endpoints\n5. Rotated all API keys and secrets\n6. Added input sanitization for file uploads\n7. Disabled directory listing\n8. Fixed CORS misconfiguration\n9. Added security headers (HSTS, X-Frame-Options)\n10. Removed debug endpoints from production\n\n**🔄 In Progress (3/14)**\n11. WAF rules — Oliver implementing, ETA Friday\n12. Penetration test — scheduled with external firm next week\n13. SOC 2 Type II — auditor engaged, 6-month process started\n\n**⏳ Blocked (1/14)**\n14. Multi-factor auth — needs product decision (TOTP vs WebAuthn)\n\n**Risk assessment:** No critical findings remain open. The 3 in-progress items are enhancements, not vulnerabilities.' },
    { role: 'user', content: 'Go with WebAuthn for MFA. It\'s better UX.' },
    { role: 'assistant', content: 'Decided:\n\n- ✅ MFA approach: **WebAuthn** (passkeys/biometrics)\n- ✅ Task created for Jan: "Implement WebAuthn MFA" — estimated 3 days\n- ✅ Updated security roadmap document\n- 📋 Fallback: TOTP for devices without biometrics\n- 📅 Target: MFA available for enterprise customers by end of April\n\nThis also helps the enterprise sales pitch — DataVault and MedTech both asked about MFA in their security questionnaires.' },
  ],
  'Singapore Expansion Planning': [
    { role: 'user', content: 'We\'re considering expanding to Singapore. What should we know?' },
    { role: 'assistant', content: '**Singapore Market Assessment**\n\nI researched the opportunity:\n\n**Market:**\n- SaaS market: $2.1B (growing 18% YoY)\n- 5,800 tech companies, 65% are SMBs (our ICP)\n- English-speaking, no localization needed\n- Strong data privacy laws (PDPA) — similar to GDPR\n\n**Competition:**\n- Local: 2 competitors (weaker feature set, strong relationships)\n- Global: Same players as EU (Salesforce, HubSpot) — enterprise focused\n- Gap: No AI-native SMB solution\n\n**Go-to-market options:**\n1. **Remote-first** (low risk): Hire 1 BD person in Singapore, run from Berlin. Cost: €8K/mo\n2. **Local entity** (medium risk): Register company, hire 2-3 people. Cost: €25K/mo\n3. **Partnership** (low cost): Find a local reseller. Revenue share, no upfront cost\n\n**Kenji Tanaka** (fintech contact from Berlin Tech Week) offered to make introductions. He knows the Singapore startup ecosystem well.\n\nRecommendation: Start with Option 1 + Kenji\'s network. Test with 3-5 customers before committing to a local entity.' },
    { role: 'user', content: 'Go with Option 1. Set up a pilot with Kenji\'s contacts.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ Email sent to Kenji: "Partnership opportunity — lynox in Singapore"\n- ✅ Job posting drafted: "Business Development — APAC" (remote, Singapore-based)\n- ✅ Created deal in CRM: "Singapore Pilot" — €18K, stage: Lead\n- 📋 Singapore compliance checklist: PDPA registration, data residency requirements\n- 📅 Target: First Singapore customer by end of Q2\n\nI\'ll track the APAC pipeline separately and give you weekly updates.' },
  ],
  'Support Ticket Analysis': [
    { role: 'user', content: 'Analyze our support tickets from the last quarter. Find patterns.' },
    { role: 'assistant', content: '**Q1 Support Analysis — 387 tickets**\n\n**Volume trend:** ↓15% MoM (good — fewer issues per customer)\n\n**Resolution metrics:**\n- First response: 2.1h avg (target: <4h) ✅\n- Resolution: 18h avg (target: <24h) ✅\n- Customer satisfaction: 4.3/5 ✅\n\n**Top 5 root causes:**\n1. **API integration errors** — 28% (mostly wrong auth format)\n2. **Billing questions** — 19% (annual vs monthly confusion)\n3. **Performance issues** — 14% (specific to >10K record imports)\n4. **Feature confusion** — 12% (users don\'t find existing features)\n5. **Onboarding friction** — 11% (setup wizard unclear)\n\n**Pattern:** 39% of tickets (causes 1, 4, 5) are preventable with better docs and UX.\n\n**Actionable insight:** A contextual help system (tooltips + in-app guide) could reduce ticket volume by 25-30%.' },
    { role: 'user', content: 'Implement contextual help and fix the top 3 issues.' },
    { role: 'assistant', content: 'Plan created:\n\n- ✅ **API auth errors:** Added clear error messages with example code. Before: "401 Unauthorized". After: "Invalid API key format. Expected: sk-ant-... See docs.novanova.com/api"\n- ✅ **Billing page:** Redesigned with comparison table (annual vs monthly, savings highlighted)\n- ✅ **Import performance:** Created batch import guide with chunking recommendation\n- 📋 **Contextual help system:** 15 tooltip placements mapped, David will implement next sprint\n\nEstimated impact: 30% fewer tickets by next quarter. I\'ll compare the numbers in 4 weeks.' },
  ],
  'Feature Flag Rollout Plan': [
    { role: 'user', content: 'We need to roll out the new dashboard behind a feature flag. Plan it.' },
    { role: 'assistant', content: '**Feature Flag Rollout — New Dashboard**\n\n**Rollout stages:**\n\n| Stage | Audience | Duration | Success criteria |\n|-------|----------|----------|------------------|\n| 1. Internal | Team (15 users) | 1 week | No P1 bugs |\n| 2. Beta | 10% of customers | 1 week | Error rate <0.1%, LCP <2s |\n| 3. Gradual | 25% → 50% → 100% | 2 weeks | NPS stable, no increase in support tickets |\n| 4. GA | All users, old dashboard removed | Permanent | — |\n\n**Rollback plan:**\n- Feature flag: `dashboard_v2` → toggle in config\n- If error rate >0.5% or 3+ P1 bugs → auto-rollback\n- Old dashboard code preserved for 30 days after GA\n\n**Monitoring:**\n- Custom dashboard (heh) tracking: load time, click-through, error rate, support tickets mentioning "dashboard"\n- Daily Slack digest during rollout\n\nOliver will set up the flag infrastructure. Should I create the rollout tickets?' },
    { role: 'user', content: 'Create the tickets. Start internal rollout Monday.' },
    { role: 'assistant', content: 'Created:\n\n- ✅ Feature flag `dashboard_v2` configured — currently: OFF\n- ✅ 4 rollout tickets with clear go/no-go criteria\n- ✅ Monitoring dashboard set up (Grafana)\n- 📅 Timeline:\n  - Monday: Internal (flag ON for team)\n  - Next Monday: 10% beta\n  - +1 week: 25% → 50% → 100%\n- 📧 Notified team: "New dashboard rolling out internally Monday"\n\nI\'ll run the automated checks at each gate and flag issues before you need to decide on progression.' },
  ],
  'Technical Debt Prioritization': [
    { role: 'user', content: 'Engineering says we have too much tech debt. Quantify it.' },
    { role: 'assistant', content: '**Technical Debt Inventory**\n\nI scanned the codebase and gathered input from Jan and Oliver:\n\n**Critical (blocks feature work):**\n1. Legacy auth middleware — 2,400 lines, no tests, blocks OAuth2 migration. **5 days to rewrite.**\n2. Monolithic API handler — single file with 3,800 lines. **4 days to split.**\n\n**High (causes bugs):**\n3. Date handling inconsistency — 3 different timezone approaches. **2 days.**\n4. Error handling — 40% of endpoints swallow errors silently. **3 days.**\n5. Database migrations — manual SQL scripts, no version tracking. **2 days.**\n\n**Medium (slows development):**\n6. No TypeScript strict mode — 150+ `any` types. **3 days.**\n7. Test coverage at 45% — target 80%. **Ongoing, 1 day/sprint.**\n8. Build time: 4.5 minutes — target <1 minute. **2 days.**\n\n**Total estimated debt: 21 dev-days** (about 2 sprints)\n\n**Recommendation:** Allocate 20% of each sprint to debt (the "tech debt tax"). Items 1-2 should be dedicated sprints — they\'re blockers.' },
    { role: 'user', content: 'Schedule items 1 and 2 as a dedicated sprint next month. 20% rule for the rest.' },
    { role: 'assistant', content: 'Scheduled:\n\n- ✅ **Sprint "Debt Zero"** — April 14-25 (2 weeks)\n  - Week 1: Auth middleware rewrite (Jan)\n  - Week 2: API handler split (Oliver)\n  - Both include: tests, documentation, migration guide\n\n- ✅ **20% rule** — added recurring "Tech Debt" swimlane to sprint board\n  - Each sprint: 2 days reserved for items 3-8\n  - Priority order: dates → errors → migrations → strict mode → tests → build\n\n- 📋 Tracking: Created DataStore collection "tech_debt" with all 8 items + status\n- 📅 Monthly debt review added to sprint retrospective agenda\n\nAt this pace, critical+high debt cleared by June, full inventory by September.' },
  ],
  'Revenue Forecasting Model': [
    { role: 'user', content: 'Build a revenue forecast for the next 6 months.' },
    { role: 'assistant', content: '**Revenue Forecast — April-September 2026**\n\nBased on current MRR (€47.2K), growth rate (8% MoM), and pipeline:\n\n| Month | MRR | New | Churn | Net | Cumulative |\n|-------|-----|-----|-------|-----|------------|\n| Apr | €51K | €6K | €2.2K | +€3.8K | €306K |\n| May | €55K | €6.5K | €2K | +€4.5K | €636K |\n| Jun | €59K | €7K | €2.1K | +€4.9K | €990K |\n| Jul | €63K | €7K | €2.3K | +€4.7K | €1.37M |\n| Aug | €67K | €7.5K | €2.5K | +€5K | €1.77M |\n| Sep | €72K | €8K | €2.8K | +€5.2K | €2.2M |\n\n**Key assumptions:**\n- Growth rate holds at 8% (conservative — could accelerate with Singapore)\n- Churn stays at ~4% (improving with health scores)\n- No enterprise whale deals (upside risk)\n- Series A closes in May (not modeled as revenue)\n\n**ARR by September: €864K** — within striking distance of €1M.\n\n**Scenario analysis saved as artifact** — includes bull/bear cases.' },
    { role: 'user', content: 'What gets us to €1M ARR by year end?' },
    { role: 'assistant', content: '**Path to €1M ARR by December 2026:**\n\nNeed: €83.3K MRR (currently €47.2K → need to grow 76%)\n\n**Three levers:**\n\n1. **Maintain 8% MoM growth** → hits €94K MRR by Dec = €1.13M ARR ✅\n   - This is the base case. Just keep executing.\n\n2. **Accelerate to 10% MoM** → hits €112K MRR by Dec = €1.34M ARR\n   - Requires: Singapore launch + 2 more enterprise deals\n\n3. **Enterprise push** → 3 deals at DataVault scale (€120K each)\n   - MedTech (pipeline), SmartFactory (pipeline), + 1 new\n   - These alone add €30K MRR\n\n**My recommendation:** Stick with the 8% base case and invest in the enterprise pipeline as upside. The math works without heroics.\n\n**What could derail it:**\n- Losing 2+ enterprise customers (CloudBridge is the risk)\n- Hiring delays (if new engineers start late)\n- Series A negotiations consuming too much founder time\n\nI updated the DataStore forecast model with all three scenarios.' },
  ],
  'Team Capacity Planning': [
    { role: 'user', content: 'We have too many projects and not enough people. Map it out.' },
    { role: 'assistant', content: '**Team Capacity — Q2 2026**\n\nCurrent team: 8 people (2 new hires starting April)\n\n| Person | Current load | Projects |\n|--------|-------------|----------|\n| Jan (Backend) | 120% ⚠️ | API v3, debt sprint, bug fixes |\n| Oliver (DevOps) | 95% | Infrastructure, WAF, monitoring |\n| David (Frontend) | 110% ⚠️ | NovaMobile, dashboard v2, design system |\n| Sarah (CTO) | 80% | Architecture, code review, hiring |\n| Lisa (Marketing) | 90% | Content, rebrand, launch materials |\n| Tom (Sales) | 85% | Pipeline, enterprise deals |\n| Anna (CS) | 75% | Onboarding, health scores, support |\n| Elena (PM) | 100% | Roadmap, compliance, investor prep |\n\n**Problem:** Jan and David are overloaded. 3 projects are at risk:\n- API v3 deadline\n- NovaMobile MVP\n- Tech debt sprint\n\n**Options:**\n1. Defer NovaMobile by 4 weeks (David freed up for dashboard)\n2. Hire a frontend contractor for 3 months (€12K)\n3. Descope API v3 (ship without batch endpoints)' },
    { role: 'user', content: 'Defer NovaMobile and hire a contractor for David.' },
    { role: 'assistant', content: 'Updated:\n\n- ✅ NovaMobile deferred to June (was April) — communicated to stakeholders\n- ✅ Contractor job posting published: "Frontend Engineer — 3 month contract"\n- ✅ Capacity sheet updated — Jan drops to 95%, David to 85%\n- 📋 David\'s new focus: dashboard v2 (priority) + design system\n- 📅 Contractor interviews: next week (3 candidates from network)\n\nI\'ll monitor team capacity weekly and flag when anyone goes above 100% again.' },
  ],
  'Customer Interview Insights': [
    { role: 'user', content: 'We did 8 customer interviews this month. Summarize the insights.' },
    { role: 'assistant', content: '**Customer Interview Summary — 8 interviews**\n\nI analyzed the transcripts and extracted key themes:\n\n**Top 3 reasons they chose us:**\n1. "It actually remembers context" (6/8 mentioned)\n2. "We replaced 4 tools with one" (5/8)\n3. "Self-hosted = we control our data" (4/8)\n\n**Top 3 pain points:**\n1. "Setup took longer than expected" (5/8) — especially API key + database\n2. "Can\'t share workflows with team members" (4/8) — #1 feature request\n3. "Mobile experience is limited" (3/8)\n\n**Surprising findings:**\n- 6/8 use lynox for tasks we didn\'t design for (compliance tracking, inventory)\n- 3/8 want to pay more for a "managed cloud version" (validates Pro model)\n- The knowledge graph is the #1 "wow factor" but only 50% of users discover it\n\n**Quotes worth sharing:**\n- _"It\'s like having a junior employee who never forgets anything"_ — DataVault CTO\n- _"We tried building this internally. Gave up after 6 months."_ — GreenLeaf CEO\n\nFull transcript summaries saved as artifacts.' },
    { role: 'user', content: 'Turn the top insights into action items.' },
    { role: 'assistant', content: 'Action items created:\n\n**Setup friction (5/8 mentioned):**\n- ✅ Task: "One-click setup wizard" — reduce setup from 15 min to 3 min\n- ✅ Task: "Docker one-liner in README" — copy-paste deployment\n\n**Team sharing (4/8 requested):**\n- ✅ Added to Pro roadmap: "Shared workflows" — Q3 milestone\n- This validates the multi-user Pro model\n\n**Knowledge graph discoverability:**\n- ✅ Task: "Add KG onboarding prompt" — suggest exploring graph after 10 conversations\n- ✅ Task: "Knowledge tab in sidebar" — make it more visible\n\n**Marketing:**\n- ✅ Customer quotes added to testimonials page\n- ✅ "Replaced 4 tools" angle → new blog post topic for Lisa\n\n**Product positioning update:**\n- The "remembers context" angle is stronger than we thought. I updated the positioning doc.' },
  ],
  'Year-End Planning Session': [
    { role: 'user', content: 'Let\'s plan the goals for the rest of 2026.' },
    { role: 'assistant', content: '**2026 Goals — Q2-Q4**\n\nBased on our trajectory and Series A plans:\n\n**Q2 (Apr-Jun): Foundation**\n- 🎯 €55K MRR → €65K MRR\n- Ship API v3 GA\n- Close Series A (€2M target)\n- Singapore: first 3 customers\n- Team: 10 people (hire 2 more engineers)\n\n**Q3 (Jul-Sep): Growth**\n- 🎯 €65K MRR → €85K MRR\n- Launch NovaMobile\n- Launch lynox Pro (multi-user, cloud)\n- 50 enterprise evaluations\n- SOC 2 Type II certification\n\n**Q4 (Oct-Dec): Scale**\n- 🎯 €85K MRR → €100K+ MRR (€1.2M ARR)\n- 200 total customers\n- APAC expansion (2nd market)\n- Team: 15 people\n- Break-even or clear path to profitability\n\n**Key dependencies:**\n- Series A closes (Q2) → enables aggressive Q3/Q4 hiring\n- Pro launch (Q3) → unlocks enterprise revenue\n- Singapore success (Q2) → validates APAC in Q4' },
    { role: 'user', content: 'Looks right. Create OKRs for Q2 and share with the team.' },
    { role: 'assistant', content: 'Q2 OKRs created:\n\n**O1: Grow revenue to €65K MRR**\n- KR1: Close 20 new customers\n- KR2: 3 enterprise deals >€50K ARR\n- KR3: Net revenue retention >110%\n\n**O2: Ship API v3 and go GA**\n- KR1: 100% API v3 endpoint coverage\n- KR2: Migration tool used by 80% of v2 customers\n- KR3: Zero P1 bugs for 2 consecutive weeks\n\n**O3: Close Series A**\n- KR1: Term sheet signed by May 31\n- KR2: Due diligence complete\n- KR3: Board formed, first meeting scheduled\n\n**O4: Establish Singapore presence**\n- KR1: BD hire in Singapore\n- KR2: 3 paying customers\n- KR3: PDPA compliance confirmed\n\n- ✅ Shared via email to all 8 team members\n- ✅ OKRs stored in DataStore for tracking\n- 📅 Weekly OKR check-in: Monday 9 AM\n\nI\'ll track progress and update you every Monday.' },
  ],
};

// Additional unique conversations for threads not in THREAD_CONVERSATIONS
const GENERIC_CONVERSATIONS: Array<Array<{ role: 'user' | 'assistant'; content: string }>> = [
  [
    { role: 'user', content: 'Run a security audit on our current infrastructure.' },
    { role: 'assistant', content: '**Infrastructure Security Audit**\n\nI scanned our production environment and found:\n\n**✅ Passing (7/10)**\n- TLS 1.3 on all endpoints\n- Database encryption at rest\n- API rate limiting active\n- CORS properly configured\n- Secrets in vault (not env vars)\n- Docker images scanned, no CVEs\n- Backup encryption verified\n\n**⚠️ Needs attention (3/10)**\n1. **SSH keys**: 2 team members still use password auth\n2. **Dependencies**: 4 packages have known vulnerabilities (non-critical)\n3. **Logs**: PII detected in 3 log streams — needs scrubbing\n\nOverall score: **7.8/10** — solid, but the PII in logs should be fixed this sprint.' },
    { role: 'user', content: 'Fix the PII issue and update the dependencies.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ Added PII scrubbing filter to all 3 log streams\n- ✅ Updated 4 vulnerable packages (no breaking changes)\n- ✅ Created task for Jan: "Enforce SSH key auth for all team members"\n- 📋 Security report saved as artifact\n\nI\'ll run this audit weekly and alert you on any regressions.' },
  ],
  [
    { role: 'user', content: 'Analyze our customer support ticket trends for the last 30 days.' },
    { role: 'assistant', content: '**Support Ticket Analysis — Last 30 Days**\n\n📊 **Volume:** 142 tickets (↓12% vs previous month)\n\n**By Priority:**\n- P1 Critical: 3 (all resolved <4h)\n- P2 High: 18 (avg resolution: 8h)\n- P3 Medium: 67 (avg resolution: 2 days)\n- P4 Low: 54 (avg resolution: 5 days)\n\n**Top Categories:**\n1. API integration questions — 34% (mostly onboarding)\n2. Billing/invoice — 22% (recurring: annual vs monthly confusion)\n3. Performance complaints — 15% (p95 latency spikes)\n4. Feature requests — 29% (export formats, webhooks)\n\n**Insight:** 34% of tickets are onboarding-related. A better getting-started guide could cut volume by 20%.' },
    { role: 'user', content: 'Create a plan to reduce onboarding tickets.' },
    { role: 'assistant', content: 'Here\'s my plan:\n\n1. ✅ **Interactive setup wizard** — I drafted a 5-step flow that replaces the current docs page\n2. ✅ **Video walkthrough** — Script written, 3 minutes, covers the top 5 onboarding questions\n3. ✅ **FAQ bot** — Added 12 common Q&As to the help widget\n4. 📋 **Metrics tracking** — Created DataStore collection to track onboarding completion rates\n\nProjected impact: 20-30% reduction in P3/P4 tickets within 2 months.\n\nAnna will review the wizard flow. I scheduled her review for tomorrow.' },
  ],
  [
    { role: 'user', content: 'I need to prepare for the investor meeting next Tuesday.' },
    { role: 'assistant', content: '**Investor Meeting Prep — Series A**\n\nI prepared a briefing based on Julia Bergmann\'s (Horizon Ventures) likely questions:\n\n**Metrics she\'ll ask about:**\n- MRR: €47.2K (growing 8% MoM)\n- ARR run-rate: €566K\n- Customers: 89 (4 enterprise)\n- Net retention: 112%\n- CAC payback: 9 months\n- Runway: 26 months\n\n**Her portfolio overlap:**\n- DataVault (already our customer — strong reference)\n- CloudBridge (prospect, at-risk — don\'t mention)\n- StreamKit (potential integration partner)\n\n**Key narrative:**\n"We\'re the operating system for SMB operations — replacing 5-7 SaaS tools with one AI agent that learns your business."\n\nI also found 3 recent LinkedIn posts from Julia about "AI-native SaaS" — she\'s bullish on the category.' },
    { role: 'user', content: 'Perfect. Create a one-pager and rehearsal questions.' },
    { role: 'assistant', content: 'Created:\n\n- ✅ **One-pager** saved as artifact — covers problem, solution, traction, team, ask\n- ✅ **10 rehearsal questions** with suggested answers:\n  1. "Why can\'t incumbents just add AI?"\n  2. "What\'s your moat?"\n  3. "How do you handle data privacy?"\n  4. "What\'s the expansion revenue story?"\n  5. "Who\'s your ideal customer?"\n  ...and 5 more\n\n- 📅 I blocked Monday 4-5 PM for a rehearsal session with Marcus\n\nGood luck Tuesday! I\'ll pull the latest metrics right before the meeting.' },
  ],
  [
    { role: 'user', content: 'Let\'s plan our content calendar for the next 4 weeks.' },
    { role: 'assistant', content: '**Content Calendar — March/April**\n\nBased on your audience analytics and SEO data:\n\n**Week 1 (Mar 17)**\n- 📝 Blog: "How we reduced our SaaS stack from 7 tools to 1" (SEO: high intent)\n- 🐦 Thread: Customer story — DataVault onboarding results\n\n**Week 2 (Mar 24)**\n- 📝 Blog: "The hidden cost of context switching" (thought leadership)\n- 📧 Newsletter: Product update + NovaConnect launch preview\n\n**Week 3 (Mar 31)**\n- 📝 Blog: "Building an AI agent that actually remembers" (technical)\n- 🎥 Demo video: 2-minute NovaConnect walkthrough\n\n**Week 4 (Apr 7)**\n- 📝 Blog: "Why we chose Elastic License" (transparency play)\n- 🐦 Thread: Behind the scenes — our security architecture\n\nEstimated reach: 12K-15K views across channels.\nLisa has capacity for 2 blog posts, the others need freelance or AI drafts.' },
    { role: 'user', content: 'Draft the first blog post and the newsletter.' },
    { role: 'assistant', content: 'Done:\n\n- ✅ **Blog draft** saved: "How we reduced our SaaS stack from 7 tools to 1" (1,200 words)\n  - Includes: before/after comparison, cost savings, team quotes\n  - SEO optimized: target keyword "reduce SaaS tools"\n  \n- ✅ **Newsletter draft** saved: March product update\n  - Sections: What\'s new, NovaConnect preview, customer spotlight, upcoming events\n  - CTA: "Join the NovaConnect beta"\n\nBoth saved as artifacts. Lisa should review the blog for tone, and Marcus should approve the newsletter before send.' },
  ],
  [
    { role: 'user', content: 'We need to review our OKRs for this quarter. How are we tracking?' },
    { role: 'assistant', content: '**Q1 OKR Progress — Week 10 of 13**\n\n**O1: Hit €50K MRR** (Revenue)\n- KR1: Close 15 new customers → 12/15 (80%) 🟡\n- KR2: Upsell 5 existing accounts → 3/5 (60%) 🟡\n- KR3: Reduce churn to <3% → 2.8% ✅\n\n**O2: Ship NovaConnect** (Product)\n- KR1: Beta with 3 partners → 2/3 (67%) 🟡\n- KR2: <200ms p95 latency → 180ms ✅\n- KR3: 95% test coverage → 91% 🟡\n\n**O3: Build the team** (People)\n- KR1: Hire 2 engineers → 2/2 ✅\n- KR2: Team NPS >70 → 68 🟡\n- KR3: Complete onboarding docs → 85% 🟡\n\n**O4: Secure Series A** (Funding)\n- KR1: 10 investor meetings → 7/10 (70%) 🟡\n- KR2: Term sheet by March 31 → In progress\n\n**Overall: 65% on track.** Revenue and product need a push in the final 3 weeks.' },
    { role: 'user', content: 'What\'s the plan to close the gap on O1?' },
    { role: 'assistant', content: 'Here\'s the sprint plan for the last 3 weeks:\n\n**New customers (need 3 more):**\n- Pipeline has 5 qualified leads. Tom will prioritize:\n  1. FlowMotion (€42K, proposal stage — decision this week)\n  2. SmartFactory (€84K, negotiation — needs technical demo)\n  3. Alpine Digital (€18K, qualified — discovery call Thursday)\n\n**Upsells (need 2 more):**\n- GreenLeaf Retail: Using basic plan, ready for enterprise (Nina confirmed interest)\n- MedTech Pro: Compliance package upsell (Felix asked for a quote last week)\n\n**Actions I\'m taking:**\n- ✅ Created daily pipeline tracker in DataStore\n- ✅ Drafted follow-up email for FlowMotion\n- 📅 Scheduled technical demo for SmartFactory (next Tuesday)\n- 📋 Quote for MedTech compliance package (sending to Felix today)\n\nI\'ll update you every morning on pipeline movement.' },
  ],
  [
    { role: 'user', content: 'What happened with our infrastructure costs last month? They seem high.' },
    { role: 'assistant', content: '**Infrastructure Cost Analysis — February**\n\nTotal: **€4,280** (↑23% vs January)\n\n**Breakdown:**\n| Service | Cost | Change |\n|---------|------|--------|\n| Hetzner (3 servers) | €180 | — |\n| Cloudflare (Pro + Workers) | €45 | — |\n| Anthropic API | €2,890 | ↑38% |\n| HuggingFace (embeddings) | €120 | — |\n| Backups (S3) | €35 | — |\n| Monitoring (Grafana Cloud) | €65 | — |\n| Misc (domains, email) | €45 | — |\n| Unaccounted | €900 | ⚠️ NEW |\n\n**Root cause:** The €900 spike is from a runaway batch job on Feb 18. A customer\'s webhook triggered 12,000 API calls in 2 hours. The Anthropic bill alone was €890 for that incident.\n\n**The batch job had no cost cap.** This is a bug — we should enforce per-run and per-day limits.' },
    { role: 'user', content: 'Set up cost caps and make sure this can\'t happen again.' },
    { role: 'assistant', content: 'Implemented:\n\n- ✅ **Per-run cap**: €5 max (configurable per customer)\n- ✅ **Daily cap**: €50 per workspace (alerts at 80%)\n- ✅ **Monthly cap**: €500 per workspace (hard stop at limit)\n- ✅ **Webhook rate limit**: Max 100 triggers per hour per source\n- ✅ **Alert**: Slack notification when any workspace hits 50% of daily budget\n\nI also credited the affected customer €45 (their share of the overage) and emailed them about the new safeguards.\n\nProjected March cost: **€3,400** (back to normal, with caps preventing spikes).' },
  ],
];

let _genericIdx = 0;

/** Get realistic messages for a thread, falling back to unique varied conversations. */
function getThreadMessages(title: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (THREAD_CONVERSATIONS[title]) {
    return THREAD_CONVERSATIONS[title];
  }
  // Rotate through unique generic conversations so no two threads look the same
  const conv = GENERIC_CONVERSATIONS[_genericIdx % GENERIC_CONVERSATIONS.length]!;
  _genericIdx++;
  // Personalize the first user message with the thread title
  return [
    { role: 'user', content: `Let's review the current status of ${title.toLowerCase()}.` },
    ...conv.slice(1),
  ];
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
      email: `contact${i + 1}@example.com`,
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
  // Write to both global and http-api scopes so data is visible regardless of contextId.
  // Engine HTTP API uses contextId='http-api', standalone CLI uses global scope.
  const scopes = ['global', 'http-api'];
  for (const scope of scopes) {
    mkdirSync(join(LYNOX_DIR, 'memory', scope), { recursive: true });
  }
  const memDir = join(LYNOX_DIR, 'memory', 'global');

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
    for (const scope of scopes) {
      writeFileSync(join(LYNOX_DIR, 'memory', scope, filename), content, 'utf-8');
    }
  }
  console.log(`  ✓ ${Object.keys(files).length} memory files created (knowledge, methods, status, learnings)`);
}

// ── CRM Contacts & Deals ────────────────────────────────────────

function seedCRM(ds: DataStore): void {
  console.log('\n👥 Seeding CRM (contacts, deals, interactions)...');
  const crm = new CRM(ds);
  crm.ensureSchema();

  const contacts = [
    { name: 'Michael Torres', email: 'michael@example.com', company: 'DataVault Corp', type: 'customer', source: 'email', language: 'en', notes: 'Enterprise CTO. Technical decision maker.', tags: '["enterprise","technical"]' },
    { name: 'Julia Bergmann', email: 'julia@example.org', company: 'Horizon Ventures', type: 'partner', source: 'web', language: 'de', notes: 'Series A lead investor. Met at Berlin Tech Week.', tags: '["investor","series-a"]' },
    { name: 'Nina Ortega', email: 'nina@example.com', company: 'GreenLeaf Retail', type: 'customer', source: 'email', language: 'en', notes: 'Inventory manager. Signed last month.', tags: '["mid-market"]' },
    { name: 'Felix Neumann', email: 'f.neumann@example.org', company: 'MedTech Pro', type: 'customer', source: 'web', language: 'de', notes: 'Dr. Compliance-focused. Needs GDPR documentation.', tags: '["mid-market","compliance"]' },
    { name: 'Sophie Laurent', email: 'sophie@example.com', company: 'CloudBridge', type: 'prospect', source: 'web', language: 'en', notes: 'Evaluating NovaPlatform. No response in 14 days.', tags: '["at-risk"]' },
    { name: 'Kenji Tanaka', email: 'kenji@example.org', company: 'TechStart SG', type: 'lead', source: 'web', language: 'en', notes: 'Singapore fintech. Interested in NovaConnect API.', tags: '["singapore","fintech"]' },
    { name: 'Anna Fischer', email: 'anna.f@example.com', company: 'Alpine Digital', type: 'customer', source: 'manual', language: 'de', notes: 'Swiss agency. Uses NovaDash for client reporting.', tags: '["agency","swiss"]' },
    { name: 'Rajesh Patel', email: 'rajesh@example.org', company: 'FlowMotion', type: 'customer', source: 'email', language: 'en', notes: 'Heavy API user. Interested in API v3 batch endpoints.', tags: '["api-heavy"]' },
    { name: 'Lena Schmidt', email: 'lena@example.com', company: 'SmartFactory GmbH', type: 'customer', source: 'web', language: 'de', notes: 'Manufacturing IoT. Uses custom API integrations.', tags: '["enterprise","iot"]' },
    { name: 'Carlos Mendez', email: 'carlos@example.org', company: 'Meridian Analytics', type: 'customer', source: 'email', language: 'en', notes: 'Beta tester for NovaConnect. Positive feedback.', tags: '["beta","analytics"]' },
    { name: 'Emma Wilson', email: 'emma@example.com', company: 'CloudNine Media', type: 'lead', source: 'web', language: 'en', notes: 'Content agency. Interested in NovaDash.', tags: '["media","lead"]' },
    { name: 'Thomas Huber', email: 'thomas@example.org', company: 'FinanceHub AG', type: 'customer', source: 'manual', language: 'de', notes: 'Swiss fintech. Compliance and security priority.', tags: '["fintech","swiss"]' },
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

// ── Artifacts ──────────────────────────────────────────────────

function seedArtifacts(): void {
  console.log('\n🎨 Seeding artifacts...');
  const artifactsDir = join(LYNOX_DIR, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const artifacts: Array<{ id: string; title: string; description: string; type: 'html' | 'mermaid' | 'svg'; content: string; daysAgo: number }> = [
    {
      id: 'a1b2c3d4',
      title: 'Revenue Dashboard Q1',
      description: 'Interactive revenue dashboard with MRR, churn, and growth metrics',
      type: 'html',
      daysAgo: 5,
      content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revenue Dashboard Q1</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e4e4e7;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px}
.card h3{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#71717a;margin-bottom:8px}
.card .value{font-size:28px;font-weight:300;letter-spacing:-0.5px}
.card .delta{font-size:13px;margin-top:4px}
.up{color:#22c55e}.down{color:#ef4444}
.chart{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px;margin-bottom:16px}
.chart h3{font-size:14px;font-weight:500;margin-bottom:16px}
.bar-row{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.bar-label{width:60px;font-size:12px;color:#a1a1aa;text-align:right}
.bar{height:24px;border-radius:4px;background:linear-gradient(90deg,#7c3aed,#a78bfa);min-width:4px;transition:width 0.5s}
.bar-val{font-size:12px;color:#a1a1aa;min-width:60px}
</style></head><body>
<h1 style="font-size:20px;font-weight:400;margin-bottom:20px">NovaTech — Revenue Q1 2026</h1>
<div class="grid">
<div class="card"><h3>MRR</h3><div class="value">CHF 42,800</div><div class="delta up">+12.3% vs last quarter</div></div>
<div class="card"><h3>ARR</h3><div class="value">CHF 513,600</div><div class="delta up">+18.7% YoY</div></div>
<div class="card"><h3>Churn Rate</h3><div class="value">2.1%</div><div class="delta up">-0.4pp improved</div></div>
<div class="card"><h3>New Customers</h3><div class="value">28</div><div class="delta up">+8 vs Q4</div></div>
</div>
<div class="chart"><h3>Monthly Revenue (CHF)</h3>
<div class="bar-row"><span class="bar-label">Jan</span><div class="bar" style="width:72%"></div><span class="bar-val">38,200</span></div>
<div class="bar-row"><span class="bar-label">Feb</span><div class="bar" style="width:82%"></div><span class="bar-val">40,500</span></div>
<div class="bar-row"><span class="bar-label">Mar</span><div class="bar" style="width:100%"></div><span class="bar-val">42,800</span></div>
</div>
<div class="chart"><h3>Revenue by Plan</h3>
<div class="bar-row"><span class="bar-label">Enterprise</span><div class="bar" style="width:55%"></div><span class="bar-val">CHF 23,540</span></div>
<div class="bar-row"><span class="bar-label">Pro</span><div class="bar" style="width:35%"></div><span class="bar-val">CHF 14,980</span></div>
<div class="bar-row"><span class="bar-label">Starter</span><div class="bar" style="width:10%"></div><span class="bar-val">CHF 4,280</span></div>
</div>
</body></html>`,
    },
    {
      id: 'e5f6a7b8',
      title: 'Sales Pipeline Flow',
      description: 'Mermaid diagram showing the lead-to-close sales pipeline',
      type: 'mermaid',
      daysAgo: 12,
      content: `graph TD
    A[New Lead] -->|Qualify| B{Score > 60?}
    B -->|Yes| C[Discovery Call]
    B -->|No| D[Nurture Sequence]
    D -->|Re-engage| A
    C -->|Interested| E[Demo Scheduled]
    C -->|Not Ready| D
    E -->|Positive| F[Proposal Sent]
    E -->|Objections| G[Follow-up]
    G -->|Resolved| F
    G -->|Lost| H[Lost — Reason Logged]
    F -->|Accepted| I[Negotiation]
    F -->|Rejected| H
    I -->|Signed| J[🎉 Won — Onboarding]
    I -->|Stalled| G

    style A fill:#7c3aed,stroke:#5b21b6,color:#fff
    style J fill:#22c55e,stroke:#16a34a,color:#fff
    style H fill:#ef4444,stroke:#dc2626,color:#fff
    style B fill:#18181b,stroke:#7c3aed,color:#e4e4e7`,
    },
    {
      id: 'c9d0e1f2',
      title: 'Weekly Sales Report',
      description: 'Automated weekly sales performance summary with key metrics',
      type: 'html',
      daysAgo: 2,
      content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Sales Report</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e4e4e7;padding:24px;max-width:640px}
h1{font-size:18px;font-weight:400;margin-bottom:4px}
.subtitle{color:#71717a;font-size:13px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;margin-bottom:20px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#71717a;padding:8px 12px;border-bottom:1px solid #27272a}
td{padding:10px 12px;border-bottom:1px solid #18181b;font-size:14px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.highlight{background:#7c3aed20;border-radius:6px}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.won{background:#22c55e20;color:#22c55e}.lost{background:#ef444420;color:#ef4444}.open{background:#3b82f620;color:#3b82f6}
.section{margin-bottom:20px}
.section h2{font-size:14px;font-weight:500;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #27272a}
.metric{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
.metric .label{color:#a1a1aa}.metric .val{font-weight:500}
</style></head><body>
<h1>Sales Report — Week 13</h1>
<p class="subtitle">March 24–28, 2026 · Generated by lynox</p>
<div class="section"><h2>Pipeline Activity</h2>
<div class="metric"><span class="label">New leads</span><span class="val">12</span></div>
<div class="metric"><span class="label">Demos completed</span><span class="val">5</span></div>
<div class="metric"><span class="label">Proposals sent</span><span class="val">3</span></div>
<div class="metric"><span class="label">Deals closed</span><span class="val">2 · CHF 18,400</span></div>
</div>
<table><thead><tr><th>Deal</th><th>Contact</th><th>Value</th><th>Status</th></tr></thead><tbody>
<tr class="highlight"><td>DataSync Pro</td><td>Marcus Weber</td><td class="num">CHF 12,000</td><td><span class="tag won">Won</span></td></tr>
<tr class="highlight"><td>API Gateway</td><td>Lena Fischer</td><td class="num">CHF 6,400</td><td><span class="tag won">Won</span></td></tr>
<tr><td>Cloud Migration</td><td>Thomas Huber</td><td class="num">CHF 24,000</td><td><span class="tag open">Proposal</span></td></tr>
<tr><td>Analytics Suite</td><td>Sarah Meier</td><td class="num">CHF 8,800</td><td><span class="tag open">Demo</span></td></tr>
<tr><td>Security Audit</td><td>Jan Kowalski</td><td class="num">CHF 4,200</td><td><span class="tag lost">Lost</span></td></tr>
</tbody></table>
<div class="section"><h2>Key Takeaways</h2>
<div class="metric"><span class="label">Win rate</span><span class="val">40% (2/5)</span></div>
<div class="metric"><span class="label">Avg deal size</span><span class="val">CHF 9,200</span></div>
<div class="metric"><span class="label">Pipeline value</span><span class="val">CHF 32,800</span></div>
</div>
</body></html>`,
    },
    {
      id: 'a3b4c5d6',
      title: 'Customer Journey Map',
      description: 'Visual customer journey from awareness to advocacy',
      type: 'mermaid',
      daysAgo: 20,
      content: `graph LR
    subgraph Awareness
        A1[Blog / SEO] --> A2[Social Media]
        A2 --> A3[Referral]
    end
    subgraph Consideration
        A1 --> B1[Landing Page]
        A2 --> B1
        A3 --> B1
        B1 --> B2[Free Trial]
        B1 --> B3[Demo Request]
    end
    subgraph Decision
        B2 --> C1[Onboarding]
        B3 --> C2[Sales Call]
        C2 --> C1
        C1 --> C3{Convert?}
    end
    subgraph Retention
        C3 -->|Yes| D1[Active User]
        D1 --> D2[Support]
        D1 --> D3[Feature Requests]
        D2 --> D1
        D3 --> D1
    end
    subgraph Advocacy
        D1 --> E1[NPS Survey]
        E1 -->|Promoter| E2[Referral Program]
        E2 --> A3
    end

    style A1 fill:#7c3aed,stroke:#5b21b6,color:#fff
    style D1 fill:#22c55e,stroke:#16a34a,color:#fff
    style E2 fill:#f59e0b,stroke:#d97706,color:#fff`,
    },
    {
      id: 'f7e8d9c0',
      title: 'Competitor Analysis Matrix',
      description: 'Feature comparison across key competitors',
      type: 'html',
      daysAgo: 8,
      content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Competitor Analysis</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e4e4e7;padding:24px}
h1{font-size:18px;font-weight:400;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#71717a;padding:10px;border-bottom:2px solid #27272a}
td{padding:10px;border-bottom:1px solid #18181b;font-size:13px}
.us{background:#7c3aed10}
.yes{color:#22c55e}.no{color:#ef4444}.partial{color:#f59e0b}
.score{display:inline-block;width:36px;height:36px;border-radius:50%;text-align:center;line-height:36px;font-size:13px;font-weight:600}
.s-high{background:#22c55e20;color:#22c55e}.s-mid{background:#f59e0b20;color:#f59e0b}.s-low{background:#ef444420;color:#ef4444}
</style></head><body>
<h1>Competitive Landscape — March 2026</h1>
<table><thead><tr><th>Feature</th><th class="us">NovaTech</th><th>CompA</th><th>CompB</th><th>CompC</th></tr></thead><tbody>
<tr><td>AI-powered analytics</td><td class="us yes">✓ Native</td><td class="yes">✓</td><td class="partial">◐ Basic</td><td class="no">✗</td></tr>
<tr><td>Real-time dashboards</td><td class="us yes">✓</td><td class="yes">✓</td><td class="yes">✓</td><td class="partial">◐</td></tr>
<tr><td>API integrations</td><td class="us">42 connectors</td><td>28</td><td>15</td><td>35</td></tr>
<tr><td>Self-hosted option</td><td class="us yes">✓</td><td class="no">✗</td><td class="no">✗</td><td class="yes">✓</td></tr>
<tr><td>SSO / SAML</td><td class="us yes">✓</td><td class="yes">✓</td><td class="partial">◐ Enterprise only</td><td class="yes">✓</td></tr>
<tr><td>Data retention controls</td><td class="us yes">✓ GDPR</td><td class="partial">◐</td><td class="no">✗</td><td class="yes">✓</td></tr>
<tr><td>Mobile app</td><td class="us partial">◐ PWA</td><td class="yes">✓ Native</td><td class="no">✗</td><td class="partial">◐ PWA</td></tr>
<tr><td><strong>Overall Score</strong></td><td class="us"><span class="score s-high">92</span></td><td><span class="score s-high">78</span></td><td><span class="score s-mid">54</span></td><td><span class="score s-mid">68</span></td></tr>
</tbody></table>
</body></html>`,
    },
  ];

  const index = artifacts.map(a => ({
    id: a.id,
    title: a.title,
    description: a.description,
    type: a.type,
    createdAt: daysAgo(a.daysAgo),
    updatedAt: daysAgo(Math.max(0, a.daysAgo - randomBetween(0, 2))),
    threadId: '',
  }));

  writeFileSync(join(artifactsDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  for (const a of artifacts) {
    writeFileSync(join(artifactsDir, `${a.id}.html`), a.content, 'utf-8');
  }
  console.log(`  ✓ ${artifacts.length} artifacts (${artifacts.filter(a => a.type === 'html').length} HTML, ${artifacts.filter(a => a.type === 'mermaid').length} Mermaid)`);
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
    // Clean artifacts
    const artDir = join(LYNOX_DIR, 'artifacts');
    if (existsSync(artDir)) {
      rmSync(artDir, { recursive: true });
      console.log('  ✓ Removed artifacts');
    }
    // Clean API profiles
    cleanApiProfiles();
  }

  // Step 2: Open databases
  const memDb = new AgentMemoryDb(join(LYNOX_DIR, 'agent-memory.db'));
  const runHistory = new RunHistory(join(LYNOX_DIR, 'history.db'));
  const dataStore = new DataStore(join(LYNOX_DIR, 'datastore.db'));

  try {
    // Step 3: Seed (runs first, then agent-memory computes metrics from runs)
    seedRunHistory(runHistory);
    seedAgentMemory(memDb, runHistory);
    seedTasksAndPipelines(runHistory);
    seedDataStore(dataStore);
    seedCRM(dataStore);
    seedMemoryFiles();
    seedArtifacts();

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
    console.log(`  artifacts: 5 (3 HTML dashboards, 2 Mermaid diagrams)`);

  } finally {
    memDb.close();
    runHistory.close();
    (dataStore as any).db.close();
  }
}

main();
