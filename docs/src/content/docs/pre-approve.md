---
title: "Pre-Approve System"
description: "Glob-based auto-approval patterns and audit trail"
---

Reduces operator approval bottleneck in autonomous modes by auto-approving predictable operations via glob-based pattern matching.

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Core pattern matching + `isDangerous` integration + `--pre-approve` CLI flag | Done |
| **Phase 2** | Haiku planning pass + tabbed approval UI | Done |
| **Phase 3** | Audit trail (SQLite) + DAG integration | Done |

---

## Phase 1 — Core Pattern Matching (Done)

### Types

```typescript
interface PreApprovalPattern {
  tool: string;        // 'bash', 'write_file', 'read_file', etc.
  pattern: string;     // Glob: "npm run *", "dist/**"
  label: string;       // Human-readable description
  risk: 'low' | 'medium' | 'high';
}

interface PreApprovalSet {
  id: string;
  approvedAt: string;
  approvedBy: 'operator';
  taskSummary: string;
  patterns: PreApprovalPattern[];
  maxUses: number;           // 0 = unlimited
  ttlMs: number;             // 0 = session-scoped
  usageCounts: number[];     // Per-pattern counter
}
```

### Modules

- **`src/core/pre-approve.ts`** — `globToRegex()`, `extractMatchString()`, `matchesPreApproval()`, `buildApprovalSet()`
- **`src/tools/permission-guard.ts`** — `isDangerous()` 4th param `preApproval?`, inline matching (avoids circular dep)
- **`src/core/agent.ts`** — `preApproval` field, passed to `isDangerous()`
- **`src/index.ts`** — `--pre-approve <glob>` (repeatable)

### Security

- Critical patterns (CRITICAL_BASH) silently filtered by `buildApprovalSet()`
- Session-scoped by default (ttlMs=0)
- maxUses=10 default
- Glob-only, no backtracking
- `autoApprovePatterns` NOT in `PROJECT_SAFE_KEYS`

### Usage

```bash
lynox --pre-approve "npm run *" \
  --pre-approve "rm dist/**"
```

---

## Phase 2 — Haiku Planning Pass + Approval UI (Done)

### Overview

Before executing a task in autonomous modes, a fast Haiku planning pass analyzes the goal and **proposes** pre-approval patterns. The operator reviews them in a tabbed dialog before execution begins.

### Flow

```
User: --approve "bash:npm run *" --approve "write_file:dist/**"
                 │
                 ▼
     ┌─── CLI Patterns ────────────┐
     │ Build PreApprovalSet from   │
     │ --approve patterns          │
     └───────────┬─────────────────┘
                 ▼
        Agent runs with approved set
```

### Supporting Files

#### `src/cli/approval-dialog.ts`

```typescript
interface ApprovalDialogResult {
  approved: boolean;
  patterns: PreApprovalPattern[];  // operator-selected subset
  maxUses: number;
  ttlMs: number;
}

async function showApprovalDialog(
  proposed: PlanningResult,
  goal: string,
  promptTabs: (questions: TabQuestion[]) => Promise<string[]>,
): Promise<ApprovalDialogResult>
```

- Tab 1: Goal + Haiku reasoning (read-only)
- Tab 2: Pattern checkboxes with risk badges (low/medium default checked, high unchecked)
- Tab 3: Limits — maxUses (5/10/25/unlimited), TTL (session/30min/1h/4h)

### Modified Files

- **`src/index.ts`** — `--auto-approve-all` auto-approves low + medium risk patterns
- **`src/core/session.ts`** — Pass `apiKey`/`apiBaseURL` to mode controller for planner
- **`src/index.ts`** — `--no-pre-approve` (skip planning), `--auto-approve-all` (approve low+medium without dialog)

### Security

- Haiku receives only goal text + tool names (no secrets)
- All proposed patterns filtered through `isCriticalTool()` (in `permission-guard.ts`)
- Operator has final approval via dialog
- `--auto-approve-all` only auto-approves low + medium risk
- Planning failure is never fatal

---

## Phase 3 — Audit Trail + DAG Integration (Done)

### Overview

All pre-approval decisions and usage are persisted to SQLite for compliance tracking. The DAG engine supports per-step pre-approval patterns.

### Implementation

- **~~`src/core/pre-approve-audit.ts`~~** — *(deleted)* Audit trail functionality consolidated into `permission-guard.ts`
- **SQLite tables** (migration v4):
  - `pre_approval_sets` — set metadata (id, run_id, patterns JSON, approved_by, task_summary, etc.)
  - `pre_approval_events` — individual check decisions (set_id, tool, pattern, decision, timestamp)
- **`src/tools/permission-guard.ts`** — 5th `audit` param on `isDangerous()`: records approval/exhausted/expired decisions via `PreApproveAuditLike`
- **`src/core/agent.ts`** — `audit` field in AgentConfig, passed to `isDangerous()`
- **DAG per-step pre-approval** — manifest steps can declare `pre_approve` patterns, built into per-step `PreApprovalSet`
- **`/approvals` slash command** — list sets, show details, audit history, export
- **Observability channels**: `lynox:preapproval:match`, `lynox:preapproval:exhausted`, `lynox:preapproval:expired`
- **RunHistory** — `insertPreApprovalSet()`, `insertPreApprovalEvent()`, `getPreApprovalSets()`, `getPreApprovalEvents()`, `getPreApprovalSummary()`

### Tests

- ~~`pre-approve-audit.test.ts`~~ — *(deleted)* Tests consolidated into `permission-guard.test.ts`
