---
title: "CRM"
description: "Contact and deal pipeline management"
---

lynox remembers everyone you work with — clients, partners, contacts, and deals. Just mention people in conversation and lynox tracks them automatically. Ask *"What's the status with [client]?"* or *"Show me my open deals"* anytime via Telegram.

No setup needed. No data entry. lynox learns from your conversations and organizes contacts, companies, and deals automatically.

## How It Works

```
Knowledge Graph (automatic)
    → Entities: "Lisa Weber works at Acme AG"
    → Relationships: "Acme AG interested in Pro Package"
    → Primary source for "what do I know about X?"

DataStore (agent-driven)
    → contacts: tracked when business-relevant
    → deals: pipeline with stages and values
    → interactions: significant touchpoints logged

Agent decides
    → Recognizes business-relevant person → adds to contacts
    → User discusses opportunity → creates deal
    → Important call/meeting → logs interaction
    → NOT every Telegram message is tracked
```

The CRM schema is created on first Engine startup. Contact creation is agent-driven, not automatic.

## Schema

Three DataStore tables, auto-created:

### contacts
| Column | Type | Description |
|--------|------|-------------|
| `name` | string | Contact name (unique key, used for upsert) |
| `email` | string | Email address |
| `phone` | string | Phone number |
| `company` | string | Company/organization |
| `type` | string | `prospect`, `lead`, `customer`, `partner`, `other` |
| `source` | string | `telegram`, `email`, `web`, `manual` |
| `channel_id` | string | External ID (e.g. `telegram:12345`) |
| `language` | string | Preferred language (auto-detected from Telegram) |
| `notes` | string | Free-text notes |

### deals
| Column | Type | Description |
|--------|------|-------------|
| `title` | string | Deal name (unique with contact_name) |
| `contact_name` | string | Associated contact |
| `value` | number | Deal value |
| `currency` | string | Currency (default: CHF) |
| `stage` | string | Pipeline stage |
| `next_action` | string | Next step to take |
| `due_date` | date | Deadline for next action |

**Pipeline stages:** `lead` → `qualified` → `proposal` → `negotiation` → `won` / `lost`

### interactions
| Column | Type | Description |
|--------|------|-------------|
| `contact_name` | string | Associated contact |
| `type` | string | `message`, `email`, `call`, `meeting`, `note` |
| `channel` | string | `telegram`, `email`, `web`, `manual` |
| `summary` | string | Interaction summary (auto-truncated) |
| `date` | date | Timestamp |

## Agent-Driven Contact Management

Contacts are NOT auto-created from every message. The agent decides when someone is business-relevant:

- User mentions "Lisa from Acme called about pricing" → agent recognizes business relevance, creates contact + logs interaction
- User sends a casual test message → nothing tracked
- User says "Add Roland as a lead" → agent creates contact explicitly

The Knowledge Graph automatically captures people and companies mentioned in any conversation. The DataStore `contacts` table is for explicit business tracking (leads, pipeline).

## Conversational CRM

You interact with the CRM through natural conversation:

```
"Zeig mir alle meine Leads"
→ data_store_query on contacts WHERE type = 'lead'

"Erstelle einen Deal für Lisa: Pro Paket, CHF 4800"
→ data_store_insert into deals

"Wie steht meine Pipeline?"
→ data_store_query on deals, aggregation by stage

"Erinnere mich in 3 Tagen bei Roland nachzufragen"
→ task_create with due_date + contact context

"Was weiß ich über Acme AG?"
→ Knowledge Graph: relationships + DataStore: contact + deals + interactions
```

## Knowledge Graph Integration

The CRM data is automatically indexed in the Knowledge Graph:
- Contact entities: "Lisa Weber works at Acme AG"
- Relationships: "Acme AG is a customer since March 2026"
- Context: "Roland prefers email communication"
- Deal history: "v-skin.ch Pro deal at CHF 4800 in negotiation"

This means when you ask "What do I know about Roland?", lynox combines structured CRM data with semantic knowledge.

## CLI Access

CRM data is stored in standard DataStore tables. Use existing commands:

```bash
/data list              # See contacts, deals, interactions tables
```

Or ask the agent directly — it knows about the CRM tables and can query them.

## SDK Usage

```typescript
import { Engine, CRM } from '@lynox-ai/core';

const engine = new Engine({});
await engine.init();

const crm = engine.getCRM();

// Agent-driven contact creation
crm.upsertContact({
  name: 'Lisa Weber',
  email: 'lisa@acme.ch',
  company: 'Acme AG',
  type: 'lead',
  source: 'telegram',
});

// Create a deal
crm.upsertDeal({
  title: 'Pro Package',
  contact_name: 'Lisa Weber',
  value: 4800,
  stage: 'proposal',
  due_date: '2026-04-01T00:00:00Z',
});

// Query pipeline
const pipeline = crm.getPipelineSummary();
// → [{ stage: 'proposal', count: 1, total_value: 4800 }]

// Log interaction
crm.logInteraction({
  contact_name: 'Lisa Weber',
  type: 'email',
  channel: 'email',
  summary: 'Sent proposal for Pro Package',
});
```

## Configuration

No configuration needed. The CRM is initialized automatically when the DataStore is available. To disable, don't initialize the DataStore (set via Engine config).
