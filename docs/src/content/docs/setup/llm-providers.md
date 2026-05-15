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

| | **Claude (Anthropic)** | **OpenAI-Compatible Direct** | **Custom Proxy via LiteLLM** |
|---|---|---|---|
| **Setup** | API key | API key + base URL | Proxy URL |
| **AI quality** | Claude | Model-dependent | Model-dependent |
| **Recommended for** | Default choice | Mistral / Ollama / LM Studio / OpenAI / Groq / vLLM | Multi-provider routing |
| | | | |
| **Features** | | | |
| Chat + Streaming | ✅ | ✅ | ✅ |
| Tool Calling | ✅ | ✅ Native | ✅ via LiteLLM |
| Extended Thinking | ✅ | ❌ Auto-disabled | ❌ Auto-disabled |
| Prompt Caching | ✅ 1h TTL | ❌ | ❌ |
| Web Search (built-in) | ✅ | ❌ | ❌ |
| Web Search (SearXNG / Tavily) | ✅ | ✅ | ✅ |
| MCP Server-Side | ✅ | ❌ | ❌ |
| | | | |
| **Privacy** | | | |
| Data residency | US | Provider-dependent (Mistral = EU) | 🏠 Your server |
| Training on data | ❌ Never | Provider-dependent | ❌ Never |
| | | | |
| **Cost** | | | |
| API pricing | $3/$15 (Sonnet), $15/$75 (Opus), $0.80/$4 (Haiku) per MTok | From $0.50/$1.50 (Mistral); free (local Ollama / LM Studio / vLLM) | Free (your hardware) |
| Typical monthly | $30–150 | $0–50 (Mistral) or $0 (local) | $150 fixed (GPU) |

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

## OpenAI-Compatible Direct — Recommended for Non-Claude

`provider: 'openai'` is the path for everything that speaks the OpenAI Chat Completions API. No proxy needed — lynox translates natively. This covers hosted clouds (Mistral, OpenAI, Groq, Gemini) AND local model servers (Ollama, LM Studio, vLLM) under the same code path. Pick the snippet that matches your endpoint.

The config shape is always the same:

```json
{
  "provider": "openai",
  "api_base_url": "<endpoint-url>",
  "openai_model_id": "<model-id>"
}
```

The wizard (npx installer or in-product **Settings → Provider**) prefills the right values when you pick Mistral or Custom; the manual snippets below are for `~/.lynox/config.json` editors or environment-driven deploys.

### Mistral (France, EU)

lynox's official Claude fallback. ~6× cheaper than Claude on cached workloads; near-Claude tool-calling quality; French company (no US CLOUD Act exposure).

```json
{
  "provider": "openai",
  "api_base_url": "https://api.mistral.ai/v1",
  "openai_model_id": "mistral-large-latest"
}
```

```bash
LYNOX_LLM_PROVIDER=openai
ANTHROPIC_BASE_URL=https://api.mistral.ai/v1
ANTHROPIC_API_KEY=<your-mistral-key>          # var name is intentionally generic
OPENAI_MODEL_ID=mistral-large-latest
```

- **Key**: console.mistral.ai → API Keys
- **Models**: `mistral-large-latest` (flagship), `mistral-medium-latest`, `codestral-latest` (code-focused)
- **Pricing**: $0.50 / $1.50 per MTok input/output (Large)
- **Tool calling**: tested near-Claude quality on the lynox agent-loop bench (internal); the most polished non-Claude option today

### Ollama (local, no auth)

The default local-model server. lynox's installer presets Ollama as the **Custom** option, so a fresh laptop with Ollama already running gets a working setup in two `<enter>` presses.

```json
{
  "provider": "openai",
  "api_base_url": "http://localhost:11434/v1",
  "openai_model_id": "llama3.2"
}
```

```bash
# 1. Install Ollama (https://ollama.com) and pull a tool-calling model
ollama pull llama3.2          # 3B — minimum, decent
ollama pull qwen2.5:14b       # 14B — good balance for 12GB+ VRAM
ollama pull qwen2.5:72b       # 72B — best local quality, needs 48GB VRAM

# 2. Configure lynox (api_key blank — Ollama doesn't auth by default)
LYNOX_LLM_PROVIDER=openai
ANTHROPIC_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL_ID=llama3.2
```

Tested with Ollama 0.4+; tool-calling quality varies sharply by model size — Qwen 2.5 14B is the practical minimum for the lynox agent loop.

### LM Studio (local, no auth)

Same shape as Ollama; LM Studio's local server speaks the OpenAI API. Useful if you prefer LM Studio's GUI for model management.

```json
{
  "provider": "openai",
  "api_base_url": "http://localhost:1234/v1",
  "openai_model_id": "<id-shown-in-lm-studio>"
}
```

The model ID is whatever's loaded in the LM Studio Server tab (e.g. `qwen2.5-7b-instruct`). Start the LM Studio server before pointing lynox at it.

### OpenAI (api.openai.com)

```json
{
  "provider": "openai",
  "api_base_url": "https://api.openai.com/v1",
  "openai_model_id": "gpt-4o"
}
```

- **Key**: platform.openai.com → API keys
- **Models tested**: `gpt-4o`, `gpt-4o-mini`. Current reasoning models (`o1`, `o3`) support function calling but add latency — `gpt-4o` is the simpler default for tool-using agents.

### Groq (hosted, fast inference)

Hosts open-source models with very low latency (LPU-backed).

```json
{
  "provider": "openai",
  "api_base_url": "https://api.groq.com/openai/v1",
  "openai_model_id": "llama-3.3-70b-versatile"
}
```

- **Key**: console.groq.com → API Keys
- **Models tested**: `llama-3.3-70b-versatile` (best tool-calling on Groq), `qwen-2.5-72b`. Function calling has been GA on Groq for the Llama 3.3 and Qwen families since late 2024; per-model support is listed in Groq's API docs.

### Gemini 2.5 Flash — Long-Context Only

```json
{
  "provider": "openai",
  "api_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
  "openai_model_id": "gemini-2.5-flash"
}
```

Use Gemini only for tasks that need its 1M-token context (deep research, large document processing, inbox triage). Gemini failed on structured-aggregation queries in our agent-loop tests — use Mistral for anything else. Google AI Studio endpoint has no regional data-residency guarantee; for strict EU sovereignty, use Mistral only.

### vLLM (self-hosted GPU)

Production-grade open-source inference server for your own GPU box. Default port is 8000.

```json
{
  "provider": "openai",
  "api_base_url": "http://your-gpu-host:8000/v1",
  "openai_model_id": "<the-model-vllm-is-serving>"
}
```

Run vLLM with `--served-model-name <id>` so the model ID matches your config. Tool calling requires a vLLM build that ships function-calling (0.6+; current releases are 0.10+, all of which support it) plus a model trained for tool use (Qwen 2.5, Llama 3.1+ Instruct, etc.).

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

## Custom Proxy via LiteLLM — Optional Routing Layer

If you already run [LiteLLM](https://github.com/BerriAI/litellm) for cost tracking / fallback chains / per-team quotas, point lynox at its proxy port. Direct OpenAI-compatible (section above) is the recommended path for new installs — LiteLLM only earns its keep when you need its policy / multi-provider routing features.

```json
{
  "provider": "custom",
  "api_base_url": "http://localhost:4000"
}
```

```bash
LYNOX_LLM_PROVIDER=custom
ANTHROPIC_BASE_URL=http://localhost:4000
```

The `custom` provider expects an **Anthropic-compatible** proxy (LiteLLM exposes one). The proxy translates between Anthropic Messages API and whatever upstream you point it at.

### Example: LiteLLM in front of Ollama (Qwen 2.5 14B)

```bash
pip install 'litellm[proxy]'
ollama pull qwen2.5:14b
litellm --model ollama/qwen2.5:14b --port 4000
```

### Example: LiteLLM in front of an EU cloud (Scaleway / Nebius / Mistral)

LiteLLM is useful when you want a single endpoint for several EU providers + automatic failover. Otherwise, a direct `provider: 'openai'` config (above) is simpler.

```bash
# Scaleway (Paris) — 18+ open-source models
OPENAI_API_KEY=your-scw-key litellm --model openai/llama-3.3-70b-versatile \
  --api_base https://api.scaleway.ai/v1 --port 4000

# Nebius (Finland / Netherlands) — 60+ open-source models
OPENAI_API_KEY=your-nebius-key litellm --model openai/Qwen3-235B-A22B-Instruct-2507 \
  --api_base https://api.studio.nebius.com/v1 --port 4000
```

### Recommended local models for self-hosted GPU

| Model | VRAM | Tool Calling | Quality |
|-------|------|-------------|---------|
| **Qwen 2.5 72B** | 48 GB | Excellent | Best local option |
| **Qwen 2.5 32B** | 24 GB | Good | Good balance |
| **Llama 3.3 70B** | 48 GB | Good | Strong reasoning |
| **Qwen 2.5 14B** | 12 GB | Decent | Minimum for tool calling |

:::caution[EU clouds host open-source models]
Mistral, Scaleway, and Nebius host open-source models (Llama, Qwen, DeepSeek). These are capable but not on the same level as Claude for complex reasoning and tool calling. Test with your specific use case before committing.
:::

## Hosting lynox + LLM Together

For maximum data control, run lynox on a server close to your LLM provider — all data stays in one region.

| Setup | LLM | lynox | Data Residency |
|-------|-----|-------|---------------|
| **Hetzner + Mistral** | Mistral API (Paris) | Hetzner VPS (Falkenstein) | Everything in EU, no US CLOUD Act exposure |
| **Fully local** | Ollama on your server | Docker on your server | Nothing leaves your network |

lynox runs as a single Docker container — any platform that runs containers can host it. See [Docker Deployment](/setup/docker/) for container configuration.

## Legacy: Vertex AI

`provider: 'vertex'` is no longer offered by the installer or the in-product wizard but is still wired in the engine for existing self-hosters with `~/.lynox/config.json` already pointing at Vertex. Anthropic's direct API + the `provider: 'openai'` paths above cover the same ground with cleaner setup; new installs should not pick Vertex.

If you still need it, the config shape is:

```json
{
  "provider": "vertex",
  "gcp_project_id": "your-gcp-project",
  "gcp_region": "europe-west4"
}
```

Requires `pnpm add @anthropic-ai/vertex-sdk` as an additional peer dependency, plus `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account JSON with `roles/aiplatform.user`. Prompt-cache TTL is 5 minutes on Vertex versus 1 hour on Anthropic direct, which makes a measurable cost difference on cache-heavy workflows.

## Changing Providers

You can switch providers anytime in **Settings → Config**. The change takes effect on the next message — no restart needed.

All your data (memory, contacts, knowledge graph, threads) stays local regardless of which provider you choose. Only the LLM inference is affected.
