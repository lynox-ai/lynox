---
title: SearXNG
description: Free, self-hosted web search for lynox via SearXNG.
sidebar:
  order: 4
---

SearXNG is a free, open-source metasearch engine that aggregates results from Google, Bing, DuckDuckGo, and dozens of other sources. By running your own instance, lynox gets unlimited web search — no API key, no monthly limits, no cost.

## How It Fits In

lynox has two independent web search mechanisms:

1. **Anthropic built-in `web_search`** — server-side, automatic, only with Anthropic direct API.
2. **`web_research` tool** — client-side, works with every LLM provider. Backed by SearXNG when you configure it, otherwise a best-effort DuckDuckGo HTML-scrape fallback (so the tool is always registered and the agent never has to fabricate).

Both can coexist — the model chooses which to use.

For the `web_research` tool, **SearXNG is the supported full-quality backend.** Setting up a SearXNG instance is a deliberate, unlimited choice; the DDG fallback is there to keep `web_research` honest on a no-config install, not as a long-term substitute.

| Config | `web_research` backend |
|--------|------------------------|
| `SEARXNG_URL` set (or docker-compose) | **SearXNG** |
| Neither set | DuckDuckGo HTML-scrape (best-effort fallback) |

:::tip
Anthropic users get `web_search` automatically — `web_research` via SearXNG is an additional tool, not a replacement.
:::

:::caution
The Tavily backend was retired on 2026-05-24. The `TAVILY_API_KEY` env var is ignored. Use SearXNG (sidecar via docker-compose, or any `SEARXNG_URL` you already host).
:::

## Setup

### Docker Compose (default — no setup needed)

SearXNG is included in the standard `docker-compose.yml`. Just run:

```bash
docker compose up -d
```

Web search works immediately. Verify in the Web UI under Settings → Integrations — the SearXNG card shows "Connected".

### Standalone (for npx or single-container users only)

:::tip
If you use Docker Compose, SearXNG is already included. No setup needed — skip this section.
:::

If you're not using docker-compose, start SearXNG separately:

```bash
docker run -d --name searxng -p 8888:8080 searxng/searxng:latest
```

Then configure lynox:

**Via Web UI:** Settings → Integrations → SearXNG. Enter the URL and test the connection.

**Via environment variable or config:**

```bash
export SEARXNG_URL=http://localhost:8888
```

## Docker Compose

SearXNG is **included and active by default** in the standard `docker-compose.yml`. No extra setup needed — just `docker compose up`.

lynox ships a pre-configured `searxng/settings.yml` with optimized engines:

- **General**: Google, DuckDuckGo, Bing, Wikipedia, Wikidata
- **News**: Google News, DuckDuckGo News, Bing News
- **Science**: Google Scholar, Semantic Scholar, arXiv
- **IT**: GitHub, StackOverflow, npm, PyPI

:::tip
SearXNG doesn't need to be exposed to the internet — only lynox needs to reach it on the internal Docker network.
:::

## Comparison

| | Anthropic Built-in | SearXNG | DDG fallback |
|---|---|---|---|
| Cost | Included | Free | Free |
| API key required | No | No | No |
| Providers | Anthropic only | All | All |
| Content extraction | Deep (full page) | Auto-enriched (top 3 results) | Snippet only (no enrichment) |
| Quality | High (Claude-optimized) | High (enriched + multi-engine) | Best-effort (single engine, HTML scrape) |
| Setup | Zero | Docker container or URL env | Zero |
| Rate limits | API rate limits | Unlimited | DDG may rate-limit / CAPTCHA |

**Content enrichment:** lynox automatically fetches full page content for the top 3 search results using its built-in content extractor (Readability-based). A 10-second timeout ensures search stays responsive even when pages are slow.

**DDG fallback caveats:** parses HTML (brittle if DDG changes layout), no `time_range` filter, no topic categories, and occasional empty results under load. Treat it as the "agent doesn't have to fabricate" safety net, not a replacement for SearXNG.

## Search Categories

The `web_research` tool supports topic-based search:

| Topic | SearXNG Category | Engines |
|-------|-----------------|---------|
| `general` | (default) | Google, DuckDuckGo, Bing, Wikipedia |
| `news` | news | Google News, DuckDuckGo News, Bing News |
| `science` | science | Google Scholar, Semantic Scholar, arXiv |
| `finance` | (general) | Google, DuckDuckGo, Bing + currency engine |

Code/library/API queries (GitHub, npm, PyPI, StackOverflow) are intentionally **not** routed via the SearXNG `it` category — the dedicated code-index engines lack full-text web indices, so filtered queries return zero hits. The general engines surface the same sources reliably; omit `topic` for IT/code searches.

## Customizing

Edit `searxng/settings.yml` in the repo to:

- **Add/remove engines** — see `use_default_settings.engines.keep_only`
- **Change language** — `search.default_lang` (default: `auto`)
- **Adjust timeout** — `outgoing.request_timeout` (default: 5s)

See the [SearXNG documentation](https://docs.searxng.org/) for all options.
