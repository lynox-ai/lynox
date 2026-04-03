---
title: LLM Providers
description: Choose where AI requests are processed — direct, cloud-hosted, or fully local.
sidebar:
  order: 3
---

:::note[Experimental]
Alternative LLM providers (Bedrock, Vertex, Custom) are experimental. The default Anthropic provider is stable and recommended. If you encounter issues with alternative providers, please [report them](https://github.com/lynox-ai/lynox/issues).
:::

lynox stores all your data locally. Only the AI inference (the LLM request) leaves your machine. You choose where it goes.

## At a Glance

| | **Anthropic** | **AWS Bedrock** | **Google Vertex** | **Custom / Local** |
|---|---|---|---|---|
| **Status** | Stable | Experimental | Experimental | Experimental |
| **Setup** | API key | AWS account + IAM | GCP project + auth | Proxy URL |
| **AI quality** | Claude (best) | Claude (same) | Claude (same) | Model-dependent |
| | | | | |
| **Features** | | | | |
| Chat + Streaming | ✅ | ✅ | ✅ | ✅ |
| Tool Calling | ✅ | ✅ | ✅ | ✅ via LiteLLM |
| Extended Thinking | ✅ | ✅ | ✅ | ❌ Auto-disabled |
| Prompt Caching | ✅ | ✅ | ✅ | ❌ |
| Web Search (built-in) | ✅ | ❌ | ❌ | ❌ |
| MCP Server-Side | ✅ | ❌ | ❌ | ❌ |
| | | | | |
| **Privacy** | | | | |
| Data residency | US | 🇪🇺 EU (6 regions) | 🇪🇺 EU (Belgium) | 🏠 Your server |
| DPA available | ✅ Auto | ✅ AWS | ✅ GCP | N/A |
| Training on data | ❌ Never | ❌ Never | ❌ Never | ❌ Never |
| CLOUD Act exposure | ⚠️ Yes | ⚠️ AWS US parent | ⚠️ Google US parent | ❌ None |
| GDPR compliant | ✅ With DPA | ✅ | ✅ | ✅ |
| Art. 321 StGB (CH) | ⚠️ Counsel | ⚠️ Better | ⚠️ Better | ✅ Safe |
| | | | | |
| **Cost** | | | | |
| API pricing | $3/$15 per MTok | Same | Same | Free (your hardware) |
| EU surcharge | — | +10% (EU CRIS) | — | — |
| Infrastructure | — | — | — | GPU server ~€150/mo |
| Typical monthly | €30–150 | €33–165 | €30–150 | €150 fixed |

## Anthropic (Default)

Direct connection to the Anthropic API. Simplest setup.

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

## AWS Bedrock

Claude hosted in AWS EU regions. Your data never leaves the EU.

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
4. Install the SDK: `pnpm add @anthropic-ai/bedrock-sdk`

**Environment:**
```bash
LYNOX_LLM_PROVIDER=bedrock
AWS_REGION=eu-central-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

**EU Data Residency:**

With `bedrock_eu_only: true`, lynox uses EU Cross-Region Inference profiles (`eu.anthropic.claude-*`). This guarantees requests are routed exclusively to EU data centers (Frankfurt, Paris, Dublin, Stockholm, Zurich, Milan). 10% cost surcharge applies.

When `aws_region` starts with `eu-`, lynox auto-selects EU model IDs — you don't need `bedrock_eu_only` explicitly. The flag exists for cases where you want to force EU routing regardless of region.

**EU regions with Claude:**
`eu-central-1` (Frankfurt), `eu-west-1` (Ireland), `eu-west-3` (Paris), `eu-north-1` (Stockholm), `eu-central-2` (Zurich), `eu-south-1` (Milan)

## Google Vertex AI

Claude hosted on Google Cloud. EU region available.

```json
{
  "provider": "vertex",
  "gcp_region": "europe-west1",
  "gcp_project_id": "my-project-123"
}
```

**Setup:**
1. Create a [GCP project](https://console.cloud.google.com)
2. Enable **Vertex AI API** → activate Claude models in the Model Garden
3. Authenticate: `gcloud auth application-default login`
4. Install the SDK: `pnpm add @anthropic-ai/vertex-sdk`

**Environment:**
```bash
LYNOX_LLM_PROVIDER=vertex
GCP_REGION=europe-west1
GCP_PROJECT_ID=my-project-123
```

**EU region:** `europe-west1` (Belgium) — the only confirmed EU endpoint for Claude on Vertex.

## Custom / LiteLLM

Route requests through your own proxy to any model — including local ones via Ollama.

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

## Hosting lynox + LLM Together

For maximum data control, run lynox on the same cloud as your LLM provider — all data stays in one region.

| Setup | LLM | lynox | Data Residency |
|-------|-----|-------|---------------|
| **AWS all-in-one** | Bedrock `eu-central-1` | ECS/Fargate `eu-central-1` | Everything in Frankfurt |
| **GCP all-in-one** | Vertex `europe-west1` | Cloud Run `europe-west1` | Everything in Belgium |
| **Fully local** | Ollama on your server | Docker on your server | Nothing leaves your network |

lynox runs as a single Docker container — any platform that runs containers can host it. See [Docker Deployment](/daily-use/docker/) for container configuration.

:::caution
Cloud deployment guides for AWS ECS and GCP Cloud Run are planned but not yet available. The Docker image works on any container platform — use your standard deployment process.
:::

## Changing Providers

You can switch providers anytime in **Settings → Config**. The change takes effect on the next message — no restart needed.

All your data (memory, contacts, knowledge graph, threads) stays local regardless of which provider you choose. Only the LLM inference is affected.
