---
title: LLM Providers
description: Choose where AI requests are processed — direct, cloud-hosted, or fully local.
sidebar:
  order: 1
---

:::note[Multi-Provider BYOK]
lynox supports multiple LLM providers out of the box. The **installer** lets you choose your provider and enter credentials — stored encrypted in your local vault. You can switch providers anytime in **Settings → Config**.
:::

lynox stores all your data locally. Only the AI inference (the LLM request) leaves your machine. You choose where it goes.

## At a Glance

| | **Claude (Anthropic)** | **Claude (AWS Bedrock)** | **OpenAI-Compatible** | **Custom Proxy** |
|---|---|---|---|---|
| **Status** | Stable | Stable | Stable | Experimental |
| **Setup** | API key | AWS IAM credentials | API key + base URL | Proxy URL |
| **AI quality** | Claude | Claude (same models) | Model-dependent | Model-dependent |
| | | | | |
| **Features** | | | | |
| Chat + Streaming | ✅ | ✅ | ✅ | ✅ |
| Tool Calling | ✅ | ✅ | ✅ Native | ✅ via LiteLLM |
| Extended Thinking | ✅ | ✅ | ❌ Auto-disabled | ❌ Auto-disabled |
| Prompt Caching | ✅ 1h TTL | ✅ 5min TTL | ❌ | ❌ |
| Web Search (built-in) | ✅ | ❌ | ❌ | ❌ |
| Web Search (SearXNG / Tavily) | ✅ | ✅ | ✅ | ✅ |
| MCP Server-Side | ✅ | ❌ | ❌ | ❌ |
| | | | | |
| **Privacy** | | | | |
| Data residency | US | Your AWS region | Provider-dependent | 🏠 Your server |
| DPA available | ✅ Auto | ✅ AWS | Provider-dependent | N/A |
| Training on data | ❌ Never | ❌ Never | Provider-dependent | ❌ Never |
| | | | | |
| **Cost** | | | | |
| API pricing | $3/$15 (Sonnet), $15/$75 (Opus), $0.80/$4 (Haiku) per MTok | Similar to Anthropic (region surcharge may apply) | From $0.50/$1.50 (Mistral) | Free (your hardware) |
| Infrastructure | — | — | — | GPU server ~€150/mo |
| Typical monthly | $30–150 | $30–150 | $10–50 | $150 fixed |

:::note[BYOK only]
AWS Bedrock is supported as a **Bring-Your-Own-Key** option for Self-Hosted and Hosted tier customers who already run on AWS. lynox's own Managed / Managed Pro tiers ship with Anthropic Direct as the primary model and Mistral AI as the secondary model — AWS Bedrock is not part of those managed offerings.
:::

## Claude (Anthropic) — Default

Direct connection to the Anthropic API. Simplest setup, recommended for most users.

```json
{
  "provider": "anthropic"
}
```

**Privacy:**
- API data is **not used for model training** (API Terms)
- DPA (Data Processing Agreement) is automatically included with Commercial Terms
- Default retention: 30 days, then deleted
- Zero Data Retention available for Enterprise customers (contact Anthropic Sales)

**Environment:**
```bash
ANTHROPIC_API_KEY=sk-ant-...
```

## Claude (AWS Bedrock) — BYOK

Same Claude models, hosted in your own AWS account. Useful if you already have an AWS footprint, need to keep LLM billing inside AWS, or have a regional residency requirement that your AWS region covers.

```json
{
  "provider": "bedrock",
  "aws_region": "eu-central-1"
}
```

**Setup:**
1. Enable Claude models in **AWS Bedrock → Model Access**
2. Create an IAM user (or role) with `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream`
3. Generate access keys for that user

**Environment:**
```bash
LYNOX_LLM_PROVIDER=bedrock
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=eu-central-1
```

**Trade-offs vs. Anthropic Direct:** Prompt cache TTL is 5 minutes on Bedrock vs. 1 hour on Anthropic, which materially affects costs on cache-heavy workflows. A region surcharge may apply depending on your AWS region. Web Search (built-in) and MCP server-side are not available through the Bedrock path.

## OpenAI-Compatible Providers — Mistral & Gemini

Connect directly to any OpenAI-compatible LLM API. No proxy needed — lynox translates natively.

```json
{
  "provider": "openai",
  "api_base_url": "https://api.mistral.ai/v1",
  "openai_model_id": "mistral-large-latest"
}
```

**Environment:**
```bash
LYNOX_LLM_PROVIDER=openai
ANTHROPIC_BASE_URL=https://api.mistral.ai/v1
ANTHROPIC_API_KEY=your-mistral-key
OPENAI_MODEL_ID=mistral-large-latest
```

### Supported Providers

| Provider | Base URL | Model ID | Role | Pricing |
|----------|----------|----------|------|---------|
| **Mistral Large** (France) | `https://api.mistral.ai/v1` | `mistral-large-latest` | Fallback + background + bulk | $0.50/$1.50 per MTok |
| **Gemini 2.5 Flash** (Google) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | Long-context tasks, agentic workflows | ~$0.30/$2.50 per MTok |

Tool calling quality validated against lynox's agent loop: Mistral 97%, Gemini 80% (fails on complex aggregations).

:::tip[Mistral — Main Fallback]
Mistral Large is lynox's official Claude fallback. It scored 97% on tool calling tests — near Claude quality at ~6x lower cost. No CLOUD Act exposure (French company).
:::

:::caution[Gemini — Long-Context Only]
Use Gemini only for tasks that need its 1M context window (deep research, large document processing, inbox triage). Gemini failed on structured aggregation queries in testing — use Mistral for anything else. Google AI Studio endpoint has no regional data residency guarantee — for strict EU sovereignty, use Mistral only.
:::

### Model Profiles (Multi-Provider)

Use named profiles to run different models for different tasks. Claude handles your interactive sessions while cheaper models handle background tasks and sub-agents.

```json
{
  "provider": "anthropic",
  "model_profiles": {
    "mistral-eu": {
      "provider": "openai",
      "api_base_url": "https://api.mistral.ai/v1",
      "api_key": "your-mistral-key",
      "model_id": "mistral-large-latest"
    },
    "gemini-research": {
      "provider": "openai",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "api_key": "your-gemini-key",
      "model_id": "gemini-2.5-flash",
      "context_window": 1000000
    }
  },
  "worker_profile": "mistral-eu"
}
```

- **Interactive sessions**: Claude (best quality, thinking, caching)
- **Background tasks** (`worker_profile`): Mistral or other — runs cron jobs, watch tasks, scheduled reports
- **Spawn agents** (`profile` in spawn spec): Sub-agents can use any profile for delegated tasks

## Custom Proxy — Experimental

Route requests through your own Anthropic-compatible proxy (e.g. LiteLLM).

```json
{
  "provider": "custom",
  "api_base_url": "http://localhost:4000"
}
```

**Environment:**
```bash
LYNOX_LLM_PROVIDER=custom
ANTHROPIC_BASE_URL=http://localhost:4000
```

### LiteLLM + Ollama (Local Qwen)

Run a fully local LLM — no data leaves your machine at all.

**1. Install:**
```bash
pip install litellm[proxy]
ollama pull qwen2.5:14b
```

**2. Start LiteLLM proxy:**
```bash
litellm --model ollama/qwen2.5:14b --port 4000
```

**3. Configure lynox:**
```json
{
  "provider": "custom",
  "api_base_url": "http://localhost:4000"
}
```

LiteLLM translates between Anthropic API format and OpenAI-compatible format, so lynox works without code changes.

lynox detects the provider and gracefully disables unsupported features — no errors, no configuration needed. See the comparison table above for details.

### Recommended Local Models

| Model | VRAM | Tool Calling | Quality |
|-------|------|-------------|---------|
| **Qwen 2.5 72B** | 48 GB | Excellent | Best local option |
| **Qwen 2.5 32B** | 24 GB | Good | Good balance |
| **Llama 3.3 70B** | 48 GB | Good | Strong reasoning |
| **Qwen 2.5 14B** | 12 GB | Decent | Minimum for tool calling |

### EU Cloud Providers via LiteLLM

Use LiteLLM to route requests to EU-hosted LLM providers. Your data stays in Europe — no CLOUD Act exposure, no transatlantic transfers.

**1. Start LiteLLM with your EU provider:**

**Mistral (France)** — French company, own models, native tool calling. No US parent company.
```bash
MISTRAL_API_KEY=your-key litellm --model mistral/mistral-large-latest --port 4000
```
Models: `mistral-large-latest` (flagship), `mistral-medium-latest`, `mistral-small-latest` (budget).

**Scaleway (France)** — 18+ open-source models hosted in Paris. Very affordable.
```bash
OPENAI_API_KEY=your-scw-key litellm --model openai/llama-3.3-70b-versatile \
  --api_base https://api.scaleway.ai/v1 --port 4000
```
Models: Llama 3.3 70B, Qwen 3, DeepSeek R1, Mistral variants.

**Nebius (Finland)** — 60+ models, Finland/Netherlands infrastructure, 99.9% SLA.
```bash
OPENAI_API_KEY=your-nebius-key litellm --model openai/Qwen3-235B-A22B-Instruct-2507 \
  --api_base https://api.studio.nebius.com/v1 --port 4000
```
Models: Qwen 3, DeepSeek V3/R1, Llama 3.3, GLM-4.5.

**2. Configure lynox:**
```json
{
  "provider": "custom",
  "api_base_url": "http://localhost:4000"
}
```

:::tip[EU Data Sovereignty]
Mistral, Scaleway, and Nebius are EU-based companies (or EU-hosted infrastructure) and are not subject to the US CLOUD Act. For regulated industries (healthcare, legal, finance), this can be a decisive compliance advantage over US-headquartered model providers.
:::

:::caution
EU cloud providers host open-source models (Mistral, Llama, Qwen, DeepSeek). These are capable but not on the same level as Claude for complex reasoning and tool calling. Test with your specific use case before committing.
:::

## Hosting lynox + LLM Together

For maximum data control, run lynox on a server close to your LLM provider — all data stays in one region.

| Setup | LLM | lynox | Data Residency |
|-------|-----|-------|---------------|
| **Hetzner + Mistral** | Mistral API (Paris) | Hetzner VPS (Falkenstein) | Everything in EU, no CLOUD Act |
| **Fully local** | Ollama on your server | Docker on your server | Nothing leaves your network |

lynox runs as a single Docker container — any platform that runs containers can host it. See [Docker Deployment](/setup/docker/) for container configuration.

## Changing Providers

You can switch providers anytime in **Settings → Config**. The change takes effect on the next message — no restart needed.

All your data (memory, contacts, knowledge graph, threads) stays local regardless of which provider you choose. Only the LLM inference is affected.
