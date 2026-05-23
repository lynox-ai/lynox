---
title: API Store
description: Wire any external HTTP API into lynox by pointing the agent at its docs URL — no hand-written integrations.
sidebar:
  order: 8
---

lynox doesn't ship pre-wired integrations to 500 services. Instead, the agent has a single tool — `api_setup` — that learns any HTTP API from its public documentation. Point it at a docs URL, the agent extracts endpoints + auth shape + rate limits from the live page, stores a profile in `~/.lynox/apis/`, and from then on `http_request` calls to that API are enforced (rate limits, response shaping, auth attachment) per the profile.

This page documents what's supported today and the curated catalog of free public APIs the agent can offer to bootstrap on demand.

## Supported auth flows

| Flow | Status | Example |
|------|--------|---------|
| `none` (public, no key) | ✓ | Hacker News, Wikipedia, arXiv, Open-Meteo |
| API key in custom header (`X-Api-Key` etc.) | ✓ | Tavily, Brevo |
| API key in query parameter | ✓ | many news / data APIs |
| Bearer token in `Authorization` header | ✓ | OpenAI, Anthropic, GitHub PAT |
| Basic auth (user/pass or pre-encoded base64) | ✓ | DataForSEO |
| OAuth2 `client_credentials` grant (server-to-server) | ✓ | Shopify private apps, Auth0 M2M |
| OAuth2 `refresh_token` grant (token already in vault) | ✓ | Google Workspace once token is held |
| OAuth2 `authorization_code` with browser-redirect / callback URL | **In progress** | "Sign in with Google" / "Connect Slack" buttons — not yet supported |

If an API requires the browser-redirect OAuth flow (the user clicks a button, gets redirected to the provider, and the provider POSTs a code back to your app's callback URL), lynox can't bootstrap it today. This includes most consumer-grade SaaS auth (Google Workspace user-context, Microsoft 365, Slack user-context, Twitter/X, Reddit). Server-to-server OAuth flows like Shopify private apps work fine because they don't involve a user redirect.

## Curated suggestions

The agent has a small catalog of free public APIs it can offer to bootstrap when your query implies external data. Examples shipped today:

| API | Category | Auth |
|-----|----------|------|
| Hacker News (Algolia) | search / community | none |
| GitHub REST (public read) | code / repos | none (PAT bumps rate limit) |
| npm Registry | code / package metadata | none |
| Wikipedia (MediaWiki) | knowledge | none |
| arXiv | research / papers | none |
| Open-Meteo | weather | none |
| Frankfurter (ECB) | currency / FX | none |
| REST Countries | geography / reference | none |
| Nager.Date | calendar / public holidays | none |
| VATcomply | EU VAT + IBAN + FX | none |

The catalog lives in `data/suggested-apis.json` and is shipped with the npm package. It contains the API name + category + docs URL — **not** a pre-built profile. The real profile (endpoints, rate limits, response-shaping rules) is extracted by `api_setup` from the live docs at bootstrap time, so the agent doesn't rely on stale training-data assumptions about API shapes.

## What the agent will NOT proactively suggest

Some classes of API never get a proactive bootstrap-offer, regardless of whether the auth flow is technically supported:

- **Payment providers** (Stripe, PayPal, Adyen, etc.) — require explicit user-initiated setup, never silent bootstrap.
- **Cloud / hosting / infrastructure** (Hetzner, AWS, GCP, Azure, Cloudflare account API) — destructive-action risk.
- Any API that mutates production billing, customer records, or live financial state.

You can always bootstrap these yourself by giving the agent a direct instruction (*"set up Stripe with this docs URL"*) — the policy is about what the agent will offer unprompted, not what it can do on request.

## Wiring a new API

Ask the agent something like:

> *"Set up the Brevo API for me, docs are at https://developers.brevo.com/reference"*

The agent will:

1. Fetch the docs page (`api_setup` action=bootstrap)
2. Extract endpoints, auth requirements, rate limits, response shape
3. Ask you for any credentials it needs (via `ask_secret`, stored in the encrypted vault)
4. Store the profile at `~/.lynox/apis/brevo.json`

From then on, any `http_request` call to that hostname is routed through the profile — rate-limit-checked, response-shaped, auth-attached.

## Opt-out

If you want a completely empty API context (no suggestion catalog injected into the agent's prompt):

```sh
LYNOX_SKIP_SUGGESTED_APIS=1 lynox
```

The agent still has the `api_setup` tool — it just won't have the curated suggestion list as context. You can still wire any API manually.

## Inspecting and editing profiles

Profiles are plain JSON files at `~/.lynox/apis/`. You can:

- Read them directly to see what the agent learned
- Edit `guidelines` / `avoid` / `notes` to add organization-specific knowledge ("never call this endpoint between 9-10am UTC — it's their batch window")
- Delete a file to remove the API from the agent's context

Or use the agent: *"show me the Brevo profile"* / *"add a note that the Brevo /contacts endpoint is 5x slower than the docs claim"*.
