# Changelog

## 1.3.7 — 2026-04-28

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.6 (delete this block before saving):

Core:
- ci: build canary docker image on feat/fix/canary branch push (#203)
- chore(spawn): rename OUTPUT_FILL_RATIO + align max_turns schema type (#202)
- chore(spawn): trim incident JSDocs, tighten test bounds, finish security trio (#201)
- fix(spawn): bound caller-supplied input + clamp negative estimate (#198)
- fix(spawn): realistic cost estimate so legitimate fan-outs aren't blocked (#197)
- ci(release): record GitHub Deployment object after pro-dispatch (#196)
- fix(agent): keep recoverable tool errors inline; no global toast (#195)
- fix(kg): unify stopwords + reject common nouns at v2 extraction (#193)
- tests: add GreenMail adversarial mailbox fixtures (#192)
- mail: harden address-list parser + document flag-semantics (#191)
- http: ensure auth secret is always set (#190)
- mail: extend charset support in OAuth Gmail body decoder (#189)
- mail: add per-tool rate limits and per-recipient dedup (#188)
- fix(mail): preserve persisted default when its provider fails to load (#187)
- perf(mail): batch Gmail envelope metadata fetches (#186)
- fix(mail): tighten OAuth Gmail watcher cursor and provider lifecycle (#185)
- perf(google-auth): cache service-account tokens (#184)
- perf(google-auth): coalesce concurrent token refreshes (#182)
- chore: ignore local bench-models results (#183)

Pro:
- feat(managed): canary pinning + rollout skip (#87)
- chore(deps): bump pnpm/action-setup from 4 to 6 (#17)
- chore(release): v1.3.6 (#85)
-->
## 1.3.6 — 2026-04-27

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.4 (delete this block before saving):

Core:
- chore(mail): remove google_gmail tool + security hardening (PR4/4 reopen) (#180)
- fix(mail): persist default mailbox + UI toggle (PR3/4 reopen) (#179)
- feat(mail): OAuth-Gmail as first-class provider + boot migration (PR2/4 reopen) (#178)
- feat(mail): add auth_type foundation for multi-provider mailboxes (#174)
- docs(google-workspace): clarify project permission + Internal vs External (#172)
- fix(google-oauth): callback works under engine API CSP, idempotent on reload (#173)
- feat(mistral): startup health check surfaces 401/402/429 to stderr + Bugsink (#171)
- fix(ui): replace disabled-Modell-dropdown with info card on Managed EU (#170)
- fix(voice): diagnostic TTS error toasts (replace generic "Vorlesen fehlgeschlagen") (#169)
- fix(voice): mark non-Paul voices experimental + add non-EN hint (#168)
- fix(prompts,config): stop answered-prompt stack + spurious 403 on save (#167)
- fix(prompts): permission timeout overflow + KEY_NAME placeholder (#166)
- fix(markdown): heading edge-cases + visible mermaid render errors (#165)
- fix(ui): v1.3.5 moderate polish bundle (#164)
- fix(ui): v1.3.5 trivial polish bundle (#162)

Pro:
- chore: update google_gmail references to unified mail tools (#84)
- chore(release): v1.3.4 (#83)
-->
## 1.3.4 — 2026-04-24

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.3 (delete this block before saving):

Core:
- feat(web-search): explicit query formulation guidance for the agent (#159)
- feat(observability): engine-level attribution for web search (#158)
- feat(kg): default to v2 extractor + admin cleanup endpoint (#150)
- feat(tasks): flexible schedule + run_at, kill title duplication (#149)
- fix(web-ui): expose voice controls on mobile/touch (#148)
- fix(web-ui): clamp wide markdown content + iOS safe-area in StatusBar (#147)
- fix(web-search): stop mapping topic "it" to SearXNG categories=it (#152)
- feat(agent): strict JSON Schema validation at tool dispatch (#153)
- feat(web-search): Haiku-based post-provider reranker (opt-in) (#157)
- fix(task): guard against escaped JSON params inside description (#151)
- fix(searxng): widen general engine pool for query reliability (#154)
- chore(ci): collapse stale approval-gate comment block on dispatch-pro-release (#143)
- chore(ci): drop production environment gate on dispatch-pro-release (#142)

Pro:

-->
## 1.3.3 — 2026-04-23

### Added

- **API Store: declarative response shaping + OpenAPI bootstrap** (#140). Profiles can now carry a `response_shape` that deterministically projects, reduces, and caps verbose JSON responses before they enter the LLM history — path-based whitelisting, reducers (`avg`/`peak`/`avg+peak`/`count`/`first_n`/`last_n`), and array/string/body caps. `api_setup` gains `bootstrap` (OpenAPI 3.x URL → draft profile) and `refine` (additive patch for guidelines/avoid/notes/endpoints/shape/rate_limit). Fully opt-in: hostnames without a profile or without `response_shape` behave identically to prior releases.
- **Markdown artifact download + print-to-PDF** (#138). `.md` artifacts now carry a download button and a browser-side print-to-PDF action.
- **Mobile/PWA polish** (#96). Settings page gets a version + legal footer, mobile-only items are hidden when the app is running as a PWA or on narrow viewports, and the stale-bundle toast gets a one-click "reload now" action.

### Fixed

- **Empty user bubbles on thread resume** (#129). Agent-synthesized user turns (e.g. tool_result carriers for `ask_user`) no longer render as blank grey bubbles when a thread is reloaded.
- **409 queue instead of failed bubble** (#130). When iOS Safari backgrounds the PWA, SSE drops, and the next send hits the server's in-progress run, the bubble now shows as queued ("Agent arbeitet noch am vorherigen Schritt — deine Nachricht wartet…") and polls `/run` every 3s for up to 6 min before giving up. Stop and thread-switch cleanly cancel the poll loop via a shared `AbortController`.
- **Orphan tool_use / tool_result sanitization on history load** (#135). Unpaired tool blocks are dropped so the model doesn't stall on malformed history.
- **Abbreviation splitting in markdown** (#136). Strings like "z.B." no longer trigger a paragraph break.
- **Session-expired copy on 401** (#137). 401 on `/run` now shows "session expired, please log in again" and bounces to `/login`, instead of the misleading "API key invalid".
- **Entity detail panel closes on Escape** (#139). KG side panel now follows the same dismiss pattern as other overlays.

## 1.3.2 — 2026-04-22

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.1 (delete this block before saving):

Core:
- fix: chat resume preserves user turns; artifact chip static; md export (#127)

Pro:
- feat(managed): per-instance update endpoint for canary rollouts (#79)
- chore(release): v1.3.1 (#78)
-->
## 1.3.1 — 2026-04-22

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.0 (delete this block before saving):

Core:
- feat(agent): annotate non-retryable tool errors so the model stops grinding (#125)
- feat: markdown artifact template + researcher-role Sonnet default (#124)
- feat(web-ui): show live sub-agent delegation in Context sidebar (#123)
- fix: voice TTS reads CHF, numbers-with-x, times, and #refs as noise (#122)
- fix(spawn): advertise only the roles that actually exist (#121)
- fix(voice): expand "N/mo" price patterns to natural phrasing (#120)
- fix(voice): don't mangle English arrows with German "dann" (#119)
- feat(spawn): stream sub-agent progress to the parent UI (#118)
- fix(voice): handle slashes, <N, arrow prosody, and DE Die pronunciation (#117)
- fix: voice TTS reads tables and arrow symbols as noise (#116)
- fix: voice TTS playback accelerates and garbles on longer replies (#115)
- fix: prevent agent context-drift on short followups (#114)
- feat(kg): add v2 entity extractor behind LYNOX_KG_EXTRACTOR flag (#113)

Pro:
- fix(managed): refuse sync-env when secret preserve would leak sentinel (#77)
- chore(ci): add one-shot admin-credit-grant workflow (#76)
- feat(managed): add POST /admin/customers/:id/credit endpoint (#75)
- feat(managed): add POST /admin/instances/:id/sync-env endpoint (#74)
- feat(managed): enable KG extractor v2 by default on managed instances (#73)
- chore(release): v1.3.0 (#72)
-->
## 1.3.0 — 2026-04-21

Two themes ship together: a user-facing **Usage Dashboard** that
answers "how much of my budget is left, and what burned it?" and
a **Compliance & Privacy settings overhaul** that consolidates
data-processing controls (LLM mode, voice providers, error
reporting, data residency) into one tab and swaps tier-based
visibility for capability-based visibility.

### Added

- **Usage Dashboard** in Settings → Budget & Usage. Tier badge,
  period selector (this month / last month / 7 d / 30 d),
  progress bar with 80 % amber / 95 % red thresholds, per-model
  cost breakdown, and a daily-trend sparkline rendered as pure
  inline SVG (no chart library).
- **`GET /api/usage/summary?period=current|prev|7d|30d`** aggregates
  RunHistory into a Dashboard-friendly shape: `used_cents`,
  `by_model`, `by_kind`, `daily` (zero-filled). Instance-scoped
  30 s TTL cache. Integer cents over the wire so JSON transport
  has no float-rounding surprises.
- **Managed-tier control-plane proxy**: `GET /api/usage/summary`
  on managed tiers now calls the control plane's new
  `/internal/usage/:instanceId/summary` endpoint and returns the
  included-credit meter (e.g. "$X of $30 included") with the
  Stripe billing period. Self-host + Hosted paths unchanged.
- **Compliance & Privacy settings tab** consolidates LLM mode,
  voice pickers, data residency read-out, and error reporting
  in one place. Visible on every tier; individual sub-sections
  gate on capability rather than tier.
- **`capabilities.mistral_available`** on `GET /api/config`
  reflects whether a Mistral key is present in env or vault.
  The LLM-mode toggle (Standard / EU Sovereign) gates on this
  instead of the managed-tier flag, so Self-Host and Hosted
  users with a Mistral key can finally access EU Sovereign
  from the UI.
- **Voice provider pickers** for STT + TTS in Settings →
  Compliance. Provider list + live voice catalog fetched from
  Mistral's `/v1/audio/voices` endpoint (paginated, 30+ voices
  today). `tts_voice` added to `LynoxUserConfig` so the picker
  choice persists across restarts. Env-var overrides
  (`LYNOX_TRANSCRIBE_PROVIDER` / `LYNOX_TTS_PROVIDER`) render
  the selector disabled with a hint.
- **`RunRecord.kind`** column splits `llm` / `voice_stt` /
  `voice_tts` so the Dashboard can attribute voice cost
  separately from chat cost. `units` column holds characters
  for TTS, seconds for STT, tokens for LLM. Schema v28, nullable
  / default-0 so pre-v28 rows read as `llm` without a backfill.
- **`/api/speak`** + **`/api/transcribe`** now write RunRecord
  rows with the right `kind`. STT uses `ffprobe` on the uploaded
  clip to fill `units` with actual seconds of audio; runs in
  parallel with transcription so it doesn't block user-facing
  latency.
- **Budget threshold toasts** fire in the Web UI at 80 % (info)
  and 95 % (error) of the monthly budget. Deduped per Stripe
  period via `localStorage`, rate-limited to one check per 30 s,
  silent-skip when no budget is configured. Hooks off the chat
  store's `done` event via dynamic import to keep alert code
  out of the initial bundle.

### Changed

- **Bugsink toggle moves from Settings → System to Settings →
  Compliance → Error Reporting.** On Managed it's info-only
  ("always active per DPIA"); on Self-Host it stays the opt-in
  toggle.
- **Settings tab "Budget" renamed to "Budget & Nutzung" /
  "Budget & Usage"** and is now visible on every tier. Limit
  inputs inside the tab remain gated on `!managed`.
- **Vault → env sync for `MISTRAL_API_KEY`** at engine init.
  BYOK users who stored the key via the Settings UI were
  previously silently broken — the secret was in vault but the
  voice facades and `llm_mode=eu-sovereign` override read from
  `process.env` directly. Now synced on init, env still wins
  if set.
- **Mistral voice-catalog parser** matches the live API response
  shape: `items` container, `slug` as the voice selector (the
  `id` field is a UUID unusable for synthesis), `languages[]`
  array, `name` as the human label. Replaces the earlier
  OpenAI-style assumption that returned the 5-voice fallback
  every call.
- **Mistral voice-catalog pagination**: Mistral caps `page_size`
  at 10 regardless of query param. The parser now loops pages
  1..N so the full 30-voice catalog reaches the UI.
- **Managed-hosting compose file** bind-mounts SSH keys from
  `/opt/lynox-managed/ssh-keys` on the host instead of a named
  Docker volume. A named volume could come up empty after
  `up --build`, sending the control plane into a crash loop
  (2026-04-21 incident). Aligns with what
  `docker-compose.staging.yml` was already doing.

### Migration notes

- **Schema v28** (RunHistory): `ALTER TABLE runs ADD COLUMN kind
  TEXT; ALTER TABLE runs ADD COLUMN units INTEGER NOT NULL
  DEFAULT 0`. Idempotent, back-compat — pre-v28 rows read as
  `kind=null` which aggregates as `llm`.
- **Managed control-plane compose**: the first rebuild after
  this version bumps the SSH-keys mount to a bind-mount. Operators
  must confirm `/opt/lynox-managed/ssh-keys/` on the host has
  `id_ed25519` (0600, uid 1000) + `id_ed25519.pub` (0644, uid
  1000) before the first `docker compose up -d --build managed`.
  The old named volume `lynox-managed_ssh-keys` becomes orphaned
  and can be removed with `docker volume rm` at leisure.
- **Capability probe**: callers of `GET /api/config` will see a
  new `capabilities` object in the response. Existing consumers
  that iterate fields are unaffected; only new fields added.

## 1.2.2 — 2026-04-20

### Fixed

- `ask_user` no longer hangs or crashes when asking multiple questions in one
  call. The old protocol looped N sequential `prompt` events over SSE and
  relied on the client replying with fixed timing, which raced on slow mobile
  connections and silently dropped answers. Replies now use a single
  `prompt_tabs` SSE event + one-shot `/reply-tabs` POST.
- `POST /api/sessions/:id/reply` is now idempotent — retrying after a network
  blip returns 200 with `idempotent: true` instead of 404.
- Passkey setup prompt on the Web UI no longer renders with a transparent
  background (Tailwind class `bg-bg-raised` didn't exist in the theme) and no
  longer overlaps the chat input on mobile.
- Timeout/abort on a pending prompt now surfaces a `prompt_error` SSE event to
  the client instead of silently defaulting the answer to `'n'`.

### Added

- `POST /api/sessions/:id/reply-tabs` for one-shot multi-question replies.
- `POST /api/sessions/:id/tab-progress` for optional mid-batch partial-answer
  persistence, so a reconnect mid-batch restores answered questions.
- `GET /api/sessions/:id/pending-prompt` now returns `kind`, `questions`, and
  `partialAnswers` when the pending prompt is a tabs prompt.
- Engine `Agent.promptTabs` is now wired over the HTTP API when the client
  advertises `protocol: 2` on `/run`. MCP and older clients fall back to the
  previous sequential path.
- Schema migration v27: `questions_json`, `partial_answers_json`, and a
  UNIQUE index enforcing one pending prompt per session.

### Changed

- `PromptStore.waitForAnswer` is now event-driven (Node `EventEmitter`)
  instead of polling every 2s. Sub-millisecond resolution after an answer
  arrives, same SQLite durability.
- `ask_user` tool caps the `questions` array at 20 entries.

## 1.2.1 — 2026-04-17

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.2.0 (delete this block before saving):

Core:
- feat(speak,web-ui): per-block auto-speak + monochrome voice prefix + tool icon refactor (#88)
- fix: ask_secret on managed + Migration race in Settings (#87)
- feat(web-ui): toast on stale client bundle after deploy (#86)
- docs: voice hotkey, model breakdown, WhatsApp beta note for v1.2.0 (#85)

Pro:
- feat(web): add Voice entry to Communication integrations (#62)
-->
## 1.2.0 — 2026-04-17

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.1.0 (delete this block before saving):

Core:
- fix(whatsapp): bypass auth for webhook + status endpoints (#82)
- feat(whatsapp): inbox integration Phase 0 behind feature flag (#80)
- feat(speak): MSE progressive playback + auto-speak toggle + voice hotkey (#79)
- feat(web-ui): model breakdown panel in history dashboard (#78)
- feat(web-ui): multi-provider API status in footer (#77)
- fix(ask_user): guard malformed options + surface tool errors to UI (#81)
- fix(scripts): handle multiline CHANGELOG draft + merge commit title (#51)
- fix(pricing): correct Opus 4.6 and Haiku 4.5 rates, add Opus 4.7 (#75)
- fix(speak): Phase 1.1 production-hardening (#76)
- fix(web-ui): allow blob: media for TTS audio playback (#74)
- feat(web-ui): speak button on assistant replies + voice-output docs (#71)
- feat(speak): HTTP API — POST /api/speak + GET /api/voice/info (#70)
- feat(speak): Voxtral TTS facade + text-prep sanitizer (#69)
- chore(scripts): add Phase 0 Voxtral TTS spike (#68)
- feat(web-ui): extend voice privacy hint with quota note
- feat(web-ui): render voice privacy hint under the recording UI
- chore(scripts): add Phase 0 Voxtral spike + recorder (dev tooling)
- feat(transcribe): thread session context into HTTP API + Telegram
- feat(transcribe): Voxtral provider + two-layer glossary
- docs: add mail integration page + update onboarding references

Pro:
- fix(ci): update staging engine instance ID after 2026-04-16 reprovision (#58)
- docs(prd): voice TTS Phase 0 results + auto-speak toggle (#57)
- feat(managed): document + pin MISTRAL_API_KEY flow for Voxtral voice
- fix(scripts): use rollout endpoint instead of per-instance redeploy
- feat: add mail integration to website + welcome email
-->
## 1.0.5 — Release Workflow & CI Hardening (2026-04-16)

### Added

- **Local smoke test** — `smoke-local.sh` runs Docker Compose + Playwright before every release cut, catching runtime regressions that unit tests miss.
- **One-command release cut** — `cut-release.sh` automates lockstep version bumps, cross-repo PRs, merge polling, and tag creation across core + pro.
- **Production gate** — Release pipeline pauses for manual approval before deploying to production; email notification on gate readiness.
- **Docs auto-deploy** — Documentation site deploys automatically on release via Cloudflare Pages.
- **Cross-repo dispatch** — Core release triggers pro release workflows (website + control plane) automatically after gate approval.

### Changed

- **CI scanner** — Replaced `pnpm audit` / `audit-ci` with `osv-scanner` for more reliable vulnerability detection.
- **NPM publish** — Added `NPM_TOKEN` pre-release gate to catch auth issues before they break the publish step.

### Fixed

- **Migration crypto test** — Deterministic tamper in signature test eliminates rare false failures on CI.

---

## 1.0.4 — Multi-Provider Support (2026-04-15)

### Added

- **Native OpenAI-compatible provider adapter** — Use Mistral, Gemini, and any OpenAI-compatible API directly via a dedicated adapter, no proxy layer required.
- **Google Vertex AI (Claude)** — Connect Claude models via Google Vertex AI using OAuth, enabling regional deployment (EU, US) without BYOK API keys.
- **`llm_mode` toggle** — New configuration switch for EU-sovereign operation: when set to `eu-sovereign`, the engine runs Mistral-only without contacting Anthropic endpoints.
- **Postinstall hint** — `npm i -g @lynox-ai/core` now prints a one-liner steering users toward the recommended `npx @lynox-ai/core` or Docker Compose workflow for zero-config startup.

### Changed

- **Provider stack clarified** — Core now ships with Anthropic direct, Mistral direct (via OpenAI-compat adapter), Vertex AI (for Claude), and AWS Bedrock as BYOK. Managed hosting uses Anthropic + Mistral as native; Bedrock is BYOK-only.
- **CI coverage threshold** — Aligned global threshold with `vitest.config.ts` (65% lines, was 70%).
- **npm publish** — Removed OIDC provenance from the release workflow (operational fix for auth reliability).

### Fixed

- Bedrock 400 error when provider-incompatible `beta` flags were passed through (already in 1.0.3, noted here for completeness).

---

## 1.0.1 – 1.0.3

Incremental patches released without changelog entries. See `git log v1.0.0..v1.0.3` for the full history. Highlights:

- **1.0.3** — Prompt cache TTL fix (`ephemeral_1h` for Anthropic, `ephemeral` for Bedrock)
- **1.0.2** — Prompt caching uses correct extended TTL syntax
- **1.0.1** — npm publish auth fix (NPM_TOKEN with provenance, later removed in 1.0.4)

## 1.0.0 — Initial Release

One system that learns your business — replaces your CRM, workflows, outreach, and monitoring. Self-hosted, open, yours.

### Core

- **Agentic loop** — Streaming tool dispatch with adaptive thinking, automatic retry with exponential backoff, parallel tool execution via `Promise.allSettled`
- **Roles** — 4 built-in roles (Researcher, Creator, Operator, Collector) with tool scoping and isolated budgets
- **Engine/Session** — Engine (shared singleton) + Session (per-conversation) architecture enabling REPL + Telegram + MCP in one process
- **Persistent AI Worker** — WorkerLoop for background task execution with cron scheduling, watch-URL polling, and multi-turn conversations
- **Cost tracking** — Per-model pricing with cache token accounting (write 1.25x, read 0.1x) and budget enforcement via CostGuard

### Knowledge

- **Unified Agent Memory** — SQLite-based (crash-safe, WAL mode) with 9 tables: semantic memories, entity graph, episodic log, pattern detection, KPI metrics. Confidence evolution, memory consolidation, retrieval feedback loop
- **Knowledge Graph Retrieval** — HyDE query expansion, multi-signal search (vector 55% + graph 15% + episodic 10%), confidence multiplier with unconfirmed decay, MMR re-ranking, pattern + episode context injection
- **Persistent business knowledge** — Context-scoped flat-file storage with auto-extraction and selective extraction prompts
- **Knowledge levels** — Three tiers: organization, project, personal — with configurable relevance weights
- **Embeddings** — Local ONNX (multilingual-e5-small, 384d, 100 languages), fully offline
- **Auto role selection** — Simple tasks auto-downgrade to Haiku for cost optimization

### Tools (13 built-in)

- `bash` — Shell execution with dangerous command detection and environment sanitization
- `read_file` / `write_file` — File operations with path traversal protection and symlink validation
- `memory` — Store, recall, delete, update, list, promote across knowledge levels
- `spawn_agent` — Parallel sub-agents with per-agent budget limits and role-based scoping
- `ask_user` — Interactive user input with select, confirm, and freeform modes
- `batch_files` — Multi-file rename, move, and transform operations
- `http` — External API calls with SSRF protection, redirect handling, and network policy enforcement
- `run_pipeline` — Multi-step workflow execution with dependency graphs and parallel steps
- `task` — Task management with priority, due dates, scheduling, and watch-URL monitoring
- `plan_task` — Structured planning with automatic workflow conversion
- `data_store` — Structured SQLite storage with typed columns, filters, and aggregation
- `capture_process` / `promote_process` — Turn ad-hoc work into reusable workflows

### Automation

- **Workflow engine** — Declarative manifests with dependency graphs, parallel execution, conditions, and template syntax
- **Process capture** — Record what you did, save it as a reusable workflow with parameters
- **File trigger** — File system watcher with glob matching and debounce (CLI `--watch`)
- **Advisor** — Analyzes run history for patterns, suggests optimizations

### Integration

- **Telegram bot** — Primary mobile/async interface with rich status messages, inline keyboards, and follow-up suggestions
- **MCP server** — stdio + HTTP SSE transport with sync and async lifecycle, Bearer token auth, and per-IP rate limiting
- **Plugin system** — Validated plugin loading from `~/.lynox/plugins/`

### Security

- **Secret vault** — AES-256-GCM encrypted SQLite storage with PBKDF2 (600K iterations, SHA-512)
- **Multi-source secrets** — Environment variables, vault, and config with `secret:KEY` reference pattern
- **Pre-approval system** — Glob-based auto-approval with critical tool blocking, TTL, max-uses, and audit trail
- **Permission guard** — Critical/dangerous command detection with business-friendly block messages
- **Input guard** — Content policy scanning before LLM processing
- **Output guard** — Write content validation and injection detection

### Data

- **DataStore** — SQLite-based structured storage with agent-defined collections, typed columns, filter-to-SQL translation, aggregation, and upsert
- **DataStore ↔ Knowledge Graph bridge** — Automatic entity linking between structured data and the knowledge graph
- **Run history** — SQLite with WAL mode, 19 migrations, tracking runs, tool calls, spawns, workflows, and security events

### Infrastructure

- **Docker** — Single-stage `node:22-slim` image, non-root user, read-only root filesystem, tmpfs, no-new-privileges
- **Config system** — 3-tier merge (env > project > user) with project-safe allowlist
- **Setup wizard** — First-run guided configuration with API key validation and accuracy level selection
- **CLI** — 40+ slash commands for conversation, model control, project management, tools, knowledge, automation, tasks, history, and identity
