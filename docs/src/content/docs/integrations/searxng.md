---
title: SearXNG
description: Free, self-hosted web search for lynox via SearXNG.
sidebar:
  order: 4
---

SearXNG is a free, open-source metasearch engine that aggregates results from Google, Bing, DuckDuckGo, and dozens of other sources. By running your own instance, lynox gets unlimited web search — no API key, no monthly limits, no cost.

## How It Fits In

lynox has two independent web search mechanisms:

1. **Anthropic built-in `web_search`** — server-side, automatic, only with Anthropic direct API
2. **`web_research` tool** — client-side, works with all LLM providers (SearXNG or Tavily)

Both can coexist — the model chooses which to use.

For the `web_research` tool, **SearXNG is the default when configured**. If you set up a SearXNG instance and provide the URL, lynox uses it — even if you also have a Tavily API key. This is intentional: setting up SearXNG is a deliberate choice, and it's unlimited.

| Config | `web_research` provider |
|--------|------------------------|
| SearXNG URL configured | **SearXNG** (default when present) |
| SearXNG URL + `search_provider: 'tavily'` | Tavily (explicit override) |
| Only Tavily API key | Tavily |
| Nothing | No `web_research` tool |

:::tip
Anthropic users get `web_search` automatically — `web_research` via SearXNG is an additional tool, not a replacement.
:::

## Setup

### 1. Start SearXNG

```bash
docker run -d --name searxng -p 8888:8080 searxng/searxng:latest
```

Verify it's running:

```bash
curl http://localhost:8888/healthz
```

### 2. Configure lynox

**Via Web UI:** Go to Settings → Integrations → SearXNG. Enter the URL and test the connection.

**Via environment variable:**

```bash
export SEARXNG_URL=http://localhost:8888
```

**Via config file** (`~/.lynox/config.json`):

```json
{
  "searxng_url": "http://localhost:8888"
}
```

**Via Docker:**

```bash
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SEARXNG_URL=http://host.docker.internal:8888 \
  ghcr.io/lynox-ai/lynox:webui
```

:::note
When running lynox in Docker, use `host.docker.internal` (macOS/Windows) or the Docker bridge IP (Linux) to reach SearXNG on the host.
:::

### 3. Verify

lynox checks the SearXNG health endpoint on startup. If reachable, the `web_research` tool becomes available. You can verify in the Web UI under Settings → Integrations — the SearXNG card shows "Connected".

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

| | Anthropic Built-in | Tavily | SearXNG |
|---|---|---|---|
| Cost | Included | Free tier, then paid | Free |
| API key required | No | Yes | No |
| Providers | Anthropic only | All | All |
| Content extraction | Deep (full page) | Deep (raw_content) | Auto-enriched (top 3 results) |
| Quality | High (Claude-optimized) | High (AI-optimized) | High (enriched + multi-engine) |
| Setup | Zero | Account creation | Docker container |
| Rate limits | API rate limits | 1,000/month free | Unlimited |

**Content enrichment:** lynox automatically fetches full page content for the top 3 search results using its built-in content extractor (Readability-based). This closes the quality gap to Tavily. A 10-second timeout ensures search stays responsive even when pages are slow.

## Search Categories

The `web_research` tool supports topic-based search:

| Topic | SearXNG Category | Engines |
|-------|-----------------|---------|
| `general` | (default) | Google, DuckDuckGo, Bing, Wikipedia |
| `news` | news | Google News, DuckDuckGo News, Bing News |
| `science` | science | Google Scholar, Semantic Scholar, arXiv |
| `it` | it | GitHub, StackOverflow, npm, PyPI |
| `finance` | (general) | Google, DuckDuckGo, Bing + currency engine |

## Customizing

Edit `searxng/settings.yml` in the repo to:

- **Add/remove engines** — see `use_default_settings.engines.keep_only`
- **Change language** — `search.default_lang` (default: `auto`)
- **Adjust timeout** — `outgoing.request_timeout` (default: 5s)

See the [SearXNG documentation](https://docs.searxng.org/) for all options.
