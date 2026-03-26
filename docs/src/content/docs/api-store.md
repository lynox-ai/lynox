---
title: "API Store"
description: "API profiles, rate limiting, and agent knowledge injection"
---

The API Store teaches lynox how to properly use external APIs. Instead of blind trial-and-error, the agent gets structured knowledge about each API before making requests — including endpoints, auth methods, rate limits, and common mistakes.

## Conversational Setup

The easiest way to add an API is to tell lynox about it:

```
You: "I want to use the Stripe API"

lynox: → Searches Stripe API documentation
       → Creates a complete profile (endpoints, auth, rate limits, guidelines)
       → Asks for your API key
       → Stores credentials securely
       → Tests the connection
       → "Stripe is set up and working."
```

The agent uses the `api_setup` tool which enforces a complete profile — it will not accept profiles without endpoints, guidelines, and auth configuration. This forces the agent to research the API documentation first.

## Manual Setup

You can also create profiles manually:

1. Create the API profiles directory:
```bash
mkdir -p ~/.lynox/apis
```

2. Add a profile (e.g. `~/.lynox/apis/my-api.json`):
```json
{
  "id": "my-api",
  "name": "My API",
  "base_url": "https://api.example.com/v3",
  "description": "Product search and inventory management API.",
  "auth": {
    "type": "bearer",
    "instructions": "Use the API key from secret:MY_API_KEY"
  },
  "rate_limit": {
    "requests_per_second": 5,
    "requests_per_minute": 200
  },
  "endpoints": [
    { "method": "POST", "path": "/search", "description": "Full-text search across products" },
    { "method": "GET", "path": "/products/{id}", "description": "Get product by ID" },
    { "method": "POST", "path": "/orders", "description": "Create a new order" }
  ],
  "guidelines": [
    "Always use POST with JSON body for search",
    "Include pagination: offset and limit params",
    "Set Content-Type: application/json on all requests"
  ],
  "avoid": [
    "Don't use GET for search — it's POST-only",
    "Don't send more than 100 items per batch request",
    "Don't omit the Authorization header — requests will silently return empty results"
  ],
  "notes": [
    "Responses use cursor-based pagination (next_cursor field)",
    "Error responses include an 'error_code' field — check it before retrying"
  ]
}
```

3. Start lynox — the profile is automatically loaded and the agent knows how to use the API.

## Profile Format

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (used in CLI and rate limiting) |
| `name` | Yes | Display name |
| `base_url` | Yes | API base URL (used for hostname matching) |
| `description` | Yes | What the API does (injected into agent context) |
| `auth` | No | Authentication method and instructions |
| `rate_limit` | No | Request limits (enforced automatically) |
| `endpoints` | No | Available endpoints with descriptions |
| `guidelines` | No | Best practices — what the agent SHOULD do |
| `avoid` | No | Common mistakes — what the agent should NOT do |
| `notes` | No | Extra context (pagination, error handling, etc.) |

### Auth Types

| Type | Description | Extra Fields |
|------|-------------|--------------|
| `basic` | HTTP Basic Auth (username:password base64) | — |
| `bearer` | Bearer token in Authorization header | — |
| `header` | API key in custom header | `header_name` (default: `X-Api-Key`) |
| `query` | API key in query parameter | `query_param` (default: `key`) |

All types support an `instructions` field for additional auth guidance to the agent.

### Rate Limits

```json
{
  "rate_limit": {
    "requests_per_second": 5,
    "requests_per_minute": 200,
    "requests_per_hour": 5000,
    "requests_per_day": 50000
  }
}
```

Rate limits are **enforced automatically** by the `http_request` tool. When a limit is hit, the request is blocked with a friendly error message. Multiple windows can be combined.

## How It Works

1. On `Engine.init()`, profiles are loaded from `~/.lynox/apis/*.json`
2. Profile knowledge is injected into the agent's system prompt:

```
## Registered APIs

### My API
Product search and inventory management API.
Base URL: https://api.example.com/v3
Auth: Bearer Token
Rate limit: 5/s, 200/min

Endpoints:
- POST /search — Full-text search across products
- GET /products/{id} — Get product by ID

Guidelines:
- Always use POST with JSON body for search
- Include pagination: offset and limit params

Avoid:
- Don't use GET for search — it's POST-only
- Don't send more than 100 items per batch request
```

3. When the agent calls `http_request`, the per-API rate limiter checks the hostname against registered profiles and blocks requests that exceed configured limits.

## Safety Guards

### Profile-First Enforcement

When the agent tries to call an API URL that looks like an API endpoint (contains `api.`, `/v1`, `/v2`, `/v3`, or `/api/`) but has no registered profile, the request is **blocked** with a message directing the agent to create a profile first.

This prevents blind trial-and-error against unknown APIs. The agent must research the API and register a profile before making requests.

Exceptions: common non-API hosts (google.com, github.com, localhost) are not blocked.

### Research Enforcement

The `api_setup` tool rejects incomplete profiles. All of these are required before a profile is accepted:

- **endpoints** — at least one endpoint with method, path, and description
- **guidelines** — at least one best practice
- **avoid** — at least one common mistake to prevent
- **auth** — authentication method

If any are missing, the agent is told to research the API documentation first.

## CLI Commands

```bash
/api              # List all registered API profiles
/api list         # Same as above
/api show <id>    # Show full details of a profile
```

## SDK Usage

```typescript
import { ApiStore } from '@lynox-ai/core';

const store = new ApiStore();
store.loadFromDirectory('/path/to/apis');

// Or register programmatically
store.register({
  id: 'my-api',
  name: 'My API',
  base_url: 'https://api.example.com',
  description: 'Does things',
  rate_limit: { requests_per_minute: 60 },
});

// Check rate limit before request
const blocked = store.checkRateLimit('api.example.com');
if (blocked) console.log(blocked); // "API rate limit reached..."

// Get system prompt context
const promptContext = store.formatForSystemPrompt();
```

## Why This Matters

Without API profiles, agents:
- Try wrong HTTP methods (GET instead of POST)
- Miss required headers or parameters
- Exceed rate limits and get blocked
- Retry failed requests without understanding why
- Waste tokens on trial-and-error

With API profiles, the agent gets the knowledge upfront and makes correct requests on the first try.
