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

| | **Claude (Anthropic)** | **Claude (AWS Bedrock)** | **Custom Proxy** |
|---|---|---|---|
| **Status** | Stable | Stable | Experimental |
| **Setup** | API key | AWS account + IAM | Proxy URL |
| **AI quality** | Claude | Claude (same models) | Model-dependent |
| | | | |
| **Features** | | | |
| Chat + Streaming | ✅ | ✅ | ✅ |
| Tool Calling | ✅ | ✅ | ✅ via LiteLLM |
| Extended Thinking | ✅ | ✅ | ❌ Auto-disabled |
| Prompt Caching | ✅ | ✅ | ❌ |
| Web Search (built-in) | ✅ | ❌ | ❌ |
| Web Search (SearXNG / Tavily) | ✅ | ✅ | ✅ |
| MCP Server-Side | ✅ | ❌ | ❌ |
| | | | |
| **Privacy** | | | |
| Data residency | US | 🇪🇺 EU (6 regions) | 🏠 Your server |
| DPA available | ✅ Auto | ✅ AWS | N/A |
| Training on data | ❌ Never | ❌ Never | ❌ Never |
| CLOUD Act exposure | ⚠️ Yes | ⚠️ AWS US parent | ❌ None |
| GDPR compliant | ✅ With DPA | ✅ | ✅ |
| Art. 321 StGB (CH) | ⚠️ Counsel | ⚠️ Better | ✅ Safe |
| | | | |
| **Cost** | | | |
| API pricing | $3/$15 (Sonnet), $15/$75 (Opus), $0.80/$4 (Haiku) per MTok | Same | Free (your hardware) |
| EU surcharge | — | +10% (EU CRIS) | — |
| Infrastructure | — | — | GPU server ~€150/mo |
| Typical monthly | €30–150 | €33–165 | €150 fixed |

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

## Claude (AWS Bedrock)

Same Claude models, hosted in AWS EU regions. Your data never leaves the EU.

```json
{
  "provider": "bedrock",
  "aws_region": "eu-central-1",
  "bedrock_eu_only": true
}
```

**Setup:**
1. Create an [AWS account](https://console.aws.amazon.com)
2. Open **Amazon Bedrock** → **Model access** → enable Anthropic Claude models
3. Create IAM credentials with `AmazonBedrockFullAccess` policy
4. Install the SDK: `pnpm add @anthropic-ai/bedrock-sdk` (pre-installed in Docker images)

**Credentials (choose one):**

**Web UI (recommended):** Enter your AWS Access Key ID and Secret Access Key in the setup banner on first run. Stored encrypted in the local vault. You can also add them later in **Settings → Keys**.

**Environment variables:**
```bash
LYNOX_LLM_PROVIDER=bedrock
AWS_REGION=eu-central-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Environment variables always override vault-stored credentials.

**EU Data Residency:**

With `bedrock_eu_only: true`, lynox uses EU Cross-Region Inference profiles (`eu.anthropic.claude-*`). This guarantees requests are routed exclusively to EU data centers (Frankfurt, Paris, Dublin, Stockholm, Zurich, Milan). 10% cost surcharge applies.

When `aws_region` starts with `eu-`, lynox auto-selects EU model IDs — you don't need `bedrock_eu_only` explicitly. The flag exists for cases where you want to force EU routing regardless of region.

**EU regions with Claude:**
`eu-central-1` (Frankfurt), `eu-west-1` (Ireland), `eu-west-3` (Paris), `eu-north-1` (Stockholm), `eu-central-2` (Zurich), `eu-south-1` (Milan)

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
Mistral, Scaleway, and Nebius are EU-based companies (or EU-hosted infrastructure). Unlike AWS Bedrock, they are not subject to the US CLOUD Act. For regulated industries (healthcare, legal, finance), this can be a decisive compliance advantage.
:::

:::caution
EU cloud providers host open-source models (Mistral, Llama, Qwen, DeepSeek). These are capable but not on the same level as Claude for complex reasoning and tool calling. Test with your specific use case before committing.
:::

## Hosting lynox + LLM Together

For maximum data control, run lynox on a server close to your LLM provider — all data stays in one region.

| Setup | LLM | lynox | Data Residency |
|-------|-----|-------|---------------|
| **Hetzner + Bedrock** | Bedrock `eu-central-1` | Hetzner VPS (Falkenstein/Helsinki) | Everything in EU |
| **Hetzner + Mistral** | Mistral API (Paris) | Hetzner VPS (Falkenstein) | Everything in EU, no CLOUD Act |
| **Fully local** | Ollama on your server | Docker on your server | Nothing leaves your network |

lynox runs as a single Docker container — any platform that runs containers can host it. See [Docker Deployment](/setup/docker/) for container configuration.

## Changing Providers

You can switch providers anytime in **Settings → Config**. The change takes effect on the next message — no restart needed.

All your data (memory, contacts, knowledge graph, threads) stays local regardless of which provider you choose. Only the LLM inference is affected.
