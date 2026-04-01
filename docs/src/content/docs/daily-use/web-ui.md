---
title: Web UI
description: Your primary interface for working with lynox.
sidebar:
  order: 1
---

The Web UI is where you interact with lynox day-to-day. It runs at [localhost:3000](http://localhost:3000) and works as a PWA — install it on your device for a native app feel.

**Phone access:** Open Settings → Mobile Access, scan the QR code with your phone — you're logged in instantly. For access outside your WiFi, see [Remote Access](/daily-use/remote-access/).

## Chat

The main view. Type a message or drop a file to start a conversation. lynox streams responses in real time, showing tool calls inline as they happen.

![Chat view with sales pipeline review](../../../assets/screenshots/chat.jpg)

During workflows, a **progress bar** appears above the input showing each step as it executes.

### Threads

Every conversation is saved as a thread. The sidebar lists your threads — click to resume any past conversation with full context.

You can **rename**, **archive**, or **delete** threads from the sidebar.

### Artifacts

When lynox generates files, code, or other outputs, they're saved as **artifacts**. Access them from the artifacts gallery — view, download, or delete.

### Command Palette

Press `Ctrl+K` to open the command palette for quick navigation between views.

## Views

### Memory

Browse what lynox has learned — organized into four namespaces:

- **Knowledge** — Facts, relationships, business context
- **Methods** — How you do things, preferences, workflows
- **Status** — Current state of projects and tasks
- **Learnings** — Insights from past interactions

![Knowledge memory view](../../../assets/screenshots/knowledge.jpg)

You can edit or delete any memory entry.

### Knowledge Graph

Visual explorer for entities and their relationships. See how contacts, companies, projects, and concepts are connected. Click any entity to see its details and related nodes.

![Knowledge Graph with entities and relationships](../../../assets/screenshots/graph.jpg)

### Insights

Success rates, cost trends, detected patterns, and per-thread analytics. All computed from your actual usage data.

![Memory Insights dashboard](../../../assets/screenshots/insights.jpg)

### Workflows

View and manage your automated workflows. See execution history, success rates, and upcoming schedules. Expand any workflow to inspect individual steps and their results.

![Workflows with pipeline runs](../../../assets/screenshots/workflows.jpg)

### Tasks

Your task board — create tasks manually or let lynox create them during conversations. Track status, update priorities, and mark tasks complete.

### Activity

History of all runs — what was asked, which model was used, token cost, and duration. Filter by date, model, or status. Useful for reviewing what lynox did in background tasks.

![Activity dashboard with cost breakdown](../../../assets/screenshots/activity.jpg)

### Contacts & CRM

Browse your contact database and deals. lynox builds this automatically from your conversations and integrations. See interaction history for any contact.

![Contacts with deals tab](../../../assets/screenshots/contacts.jpg)

## Settings

Access via the gear icon or navigate to `/app/settings/`.

| Section | What it does |
|---------|-------------|
| **Mobile Access** | QR code to connect your phone — scan once, auto-login, install as PWA |
| **Config** | Model selection, cost limits, greeting, memory settings |
| **Keys** | Manage your encrypted vault — API keys and secrets |
| **Integrations** | Connect Telegram, Google Workspace |
| **APIs** | REST API profiles for external services |
| **Data** | Browse structured data collections |
| **Tasks** | Manage scheduled background tasks |
| **Backups** | Create, schedule, and restore backups |

## Languages

The Web UI supports **German** and **English**. Switch languages at runtime from the settings — no restart required.
