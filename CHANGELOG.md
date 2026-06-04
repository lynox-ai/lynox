# Changelog

## Unreleased

## 1.9.0 — 2026-06-04

Trust-and-recovery release: chat turns and artifacts never silently vanish, cost tracking shows one consistent number everywhere, artifacts gain a real version history, and `ask_user` can offer multiple answers.

### Features
- **Artifact version history** — every save snapshots the version it replaces (up to 10), with new `artifact_history` / `artifact_restore` tools so an accidental overwrite is recoverable. Gallery cards now show the updated time + a version badge. (#677)
- **ask_user multi-select** — opt-in `multiSelect` lets you toggle several answer pills and Send, instead of one-click-and-done. Single-select is unchanged. (#676)

### Fixes
- **Durable chat turns** — a user message is now persisted at run start, so an abort / reload / queued send mid-stream can't lose it (continued-session prompts no longer disappear). Queued messages survive a reload; the scroll stays pinned on send. (#673)
- **Cost tracking, one source of truth** — the footer, the dashboard "today" tile, and the 14-day chart now agree (local-timezone day buckets); the histogram ends on today instead of stale dates; per-thread cost reflects the full thread; headline run counts are your chat turns (voice + sub-runs counted separately). (#674)

## 1.8.3 — 2026-06-04

Feature release: artifacts become first-class editable files, a calmer and more trustworthy context-compaction flow, and a round of agent-tool security hardening.

### Added

- **Artifacts are real, editable source files.** The agent can now treat an artifact as a file it reads and edits in place (`edit_file`) with grounding discipline, instead of regenerating the whole thing — edits update the existing artifact, no orphans or duplicates.
- **Inline artifacts render as a collapsed pill.** Artifacts in the chat stream show as a compact pill that lazy-expands on click (and is keyboard-operable), instead of dumping a large inline blob.
- **A visible "context compacted" marker.** When a conversation is summarized, a calm marker now persists in the thread so it's clear what happened — artifacts, decisions and the through-line are kept.
- **Prepare-and-compact flow.** Compaction is now offered later and more calmly (a quiet, user-triggered bar near the threshold) rather than an alarming early banner.

### Fixed

- **Compaction summaries are reliable.** The summary now runs with tools disabled and authoritative framing, so it can't wander into tool calls or disown its own summary — the open task survives the compaction.
- **100vh deck artifacts render at 16:9** instead of collapsing to a ~200px sliver.
- **Changeset review is tidier.** Friendly artifact labels + viewer-meta spacing, and the diff `+++`/`---` headers no longer surface the internal artifact path.
- **The artifact pill is keyboard-operable** (focusable, Enter/Space toggles).
- **`ask_user` accepts a questions-only batch** (the hard "must include a question" requirement is dropped).
- **Docker build flake killed** — the Whisper base model is mirrored and the tiny model dropped, ending the intermittent Hugging-Face build failure.

### Security

- **Watch + migration-export fetches go through the pinned network guard.** Outbound requests from the watch loop and the migration/export path now resolve-once + pin the socket + refuse redirects, closing an SSRF surface (no hand-rolled denylist, no localhost carve-out).
- **Watch tasks are cost-bounded.** The watch interval is floored at 5 minutes and the analysis session carries a hard budget cap.
- **Malicious-write guard wired into `write_file`/`edit_file`** — write content is scanned and rejected if it matches known malicious patterns.

### Internal

- Public-repo leak-guard + removal of internal staging/ops tooling from the public repo; drift-guard + positioning-guard added as required CI checks.
- Staging image builds amd64-only; gitleaks + pattern-scan moved from pre-push to pre-commit.

## 1.8.2 — 2026-06-03

Bug-fix patch: a chat-resume regression on legacy model tiers, a spurious managed run-block, and an inbox decode + context-pane redesign.

### Fixed

- **Chat is visible immediately on thread resume again.** Managed threads carrying a legacy `model_tier` (`sonnet`/`opus`/`haiku`, pre-rename) returned a 500 on resume, so the conversation only appeared after a manual page refresh. The legacy tier is now normalized (`normalizeTier`) on the resume path.
- **No more spurious "Managed control plane unreachable" run-blocks.** A managed tenant could fail-closed and block a run even when the control plane was up; a proactive credit heartbeat keeps the status fresh and the message was softened.
- **Mail bodies decode correctly in the reader.** Body parts are now decoded by their Content-Transfer-Encoding (base64 / quoted-printable) and the declared charset is honored, so encoded or non-UTF-8 mail no longer leaks raw `=20`/base64 text into the inbox (also fixes the single-part snippet path).
- **Inbox reader can't collapse to one-character-per-line.** The reading pane now has a floored minimum width.

### Changed

- **Inbox context moved below the mail body.** The mail-context (recent threads, follow-ups, outbound, reminders) is now a stacked single-column section that scrolls beneath the message instead of a right-hand sidebar — a cleaner read on both desktop and mobile.

### Internal

- Published the 2026-05-30 fairness-fixed Set-Bench run. (#652)

## 1.8.1 — 2026-06-03

Stabilization patch from the first `/release-harden` run (3-tier canary-verified). 7 commits, all fixes.

### Fixed

- **Env-pinned managed instances no longer persist a stray provider/endpoint change.** A `PUT /api/config` of `provider`/`api_base_url`/`openai_model_id` was stored (masked at runtime by the env-pin) and surfaced the *wrong* provider + data-residency in LLM Settings and `/api/export` — e.g. an EU-Mistral tenant showing "Anthropic / US". Those env-controlled fields are now stripped from the persisted update when `LYNOX_LLM_PROVIDER` is set. (#650, H-001)
- **OpenAI-compatible provider save now surfaces the server's validation error** (e.g. "provider:'openai' requires openai_model_id") instead of failing silently and looking like a no-op. (#650, H-007)
- **Workspace access-token reveal fixed** — it called a non-existent route (`/api/access-token` → 404); now uses `GET /api/auth/token?reveal=true` (mirrors the vault-key reveal). (#650, H-012)
- **Tier-rename copy cleanup**: dropped the stale "magistral" tier-claim from provider help-copy + first-run pickers, made the keyless empty-state key-hint provider-agnostic, and canonicalized the `/api/config` `managed` field (`starter`→`hosted`). (#648)

## 1.8.0 — 2026-06-03

Provider-agnostic tier model + canonical billing-tier consolidation. 16 commits since v1.7.9.

### Breaking

- **Provider-agnostic model-tier names** (#639). `opus`/`sonnet`/`haiku` → `deep`/`balanced`/`fast` across the `ModelTier` type and config. Legacy Anthropic-brand names are still accepted and normalized via `normalizeTier`, so existing `config.json` and `LYNOX_DEFAULT_TIER`/`LYNOX_MAX_TIER` env vars keep working unchanged.
- **Billing-tier rename `starter` → `hosted` + `eu` tier retired** (#647). A canonical billing-tier module is now the single source of truth across web-ui, engine, and the control plane; `starter`/`eu` are accepted as legacy aliases. Managed deployments apply migration `0029_rename_tier_hosted` (renames existing rows; `eu` rows preserved).

### Added

- **Opt-in chat diagnostics panel** (#643) — per-message metrics surfaced in the chat view.
- **JSON export** option in the thread kebab menu (#636).
- **`/api/config` surfaces the effective active provider** when a provider is env-pinned (#646).

### Changed

- **Mistral tier refresh** (#644): `deep` = `mistral-large-2512`, `balanced` = `ministral-14b-2512`; `magistral` dropped from the tier set (retires 2026-07-31). Set-Bench got a fairness pass (judge-panel + open-ended axes).
- **Provider tiles are read-only with a tailored banner when the provider is env-pinned** (#645).
- **Provider-switch hardening** (#641, #642): footer reactivity, API-error keeps the turn, env-copy, display/API history split, silent-turn render, demo cost-gate.
- **Tightened `read_file`/`http` context caps** + `api_setup` source-domain filter (#637).
- **Grounding prompt** now splits knowledge by verification source (#638).

### Removed

- Retired the `pipelineStatusV2` knob (#635).

## 1.7.9 — 2026-05-27

### Added

- Propagate provider/credential switch to long-lived Sessions; `engine.configVersion` increments on credential/provider swap (#42).
- Mistral SSRF whitelist + ENV-override banner + Hosted-BYOK back-button (F9/F7).

### Fixed

- Reconcile chat thread from server on ChatView re-mount (F13).
- Self-host `/login` form 403 via `ORIGIN` env.

### Changed

- Overnight i18n + copy hygiene batch — mail modal, Google grammar, push card (#634); HN-doc-sweep (#633).

## 1.7.8 — 2026-05-27

### Fixed

- Billing-page subtitle + Upgrade-CTA for the Hosted-BYOK tier (G4).

## 1.7.7 — 2026-05-27

### Added

- Link the Privacy & Data page from the Settings hub.

### Fixed

- Engine boot crash on BYOK tenants with `provider=openai` and no key.
- Restore Mistral / Custom-OpenAI provider config in the SetupBanner (G5).

## 1.7.6 — 2026-05-27 night

Patch — three managed-tier UX gaps caught during the v1.7.5 staging walk on a Hosted-BYOK (`starter`) tenant. All three traced to managed-mode code paths assuming `LYNOX_MANAGED_MODE=*` always means the CP supplies the LLM key — wrong for Hosted-BYOK where the customer brings it. G2 additionally affected self-host with non-Anthropic providers.

### Fixed

- **LLM Settings now shows the API-key input on Hosted-BYOK** (#632 G1). New `cpSuppliesLLMKey()` helper returns true only for `managed`/`managed_pro`/`eu`; previously `isManaged()` returned true for `starter` BYOK too, hiding the key-input field and stranding the customer.
- **ChatView inline empty-state is provider-aware** (#632 G2). Was hardcoded `sk-ant-...` placeholder + `console.anthropic.com` link regardless of selected provider — Mistral-via-Custom or Hosted-BYOK-with-Mistral users got the Anthropic prompt anyway. Affects self-host too. Now derives `variant` (anthropic / mistral / openai-custom) from `/api/config.api_base_url` and shows matching label/placeholder/console URL + saves to the correct vault slot.
- **Status bar truthful on managed-BYOK** (#632 G3). PR #630's not-configured check bypassed every managed tier including BYOK; customer saw green "API OK" while SetupBanner demanded the key. Now gates on `cpSuppliesKey` (managed/managed_pro/eu) only.

## 1.7.5 — 2026-05-26 night

Pre-HN-launch eve self-host hardening + UX polish. 10 PRs since v1.7.4.

### Breaking

- **Tavily web-search backend retired.** The `TAVILY_API_KEY` env var, `search_provider: 'tavily'` config value, and the `TavilyProvider` class are gone. The UI hadn't surfaced Tavily for months; keeping a dead env-var path was misleading. SearXNG (sidecar via `docker compose up`, or any `SEARXNG_URL` you host) is the supported full-quality backend.
- Legacy `search_provider: 'tavily'` values in `config.json` are silently coerced to `undefined` on load — existing configs still validate without manual cleanup. Vault entries named `TAVILY_API_KEY` or `SEARCH_API_KEY` are left in place (untouched) but no longer resolved as a search credential.

### Added

- **SetupBanner pre-flight API-key validation** (#629). Typo'd keys are now rejected with the engine's actual reason before the vault write, instead of silently landing and 401-ing on the user's first chat. Reuses the same 3-state validators the CLI installer uses (`anthropic | mistral | openai-compat`).
- **Status bar `Setup needed` indicator** (#630). The bar used to show "API OK" on fresh self-host because it only checked `status.anthropic.com` endpoint health, not whether the user had wired a key. New `not-configured` state colours amber and labels "Setup needed".
- **Honesty-fallback when `web_research` is not configured.** Previously the agent silently fabricated search results (made-up arXiv IDs, prices, "recent X") when no search backend was wired up. Now the agent gets explicit "no search available — DO NOT fabricate" instructions in its system prompt.
- **Embedded DuckDuckGo HTML-scrape fallback** for `web_research` when SearXNG isn't configured. Best-effort, with a "fallback quality" prompt suffix so the agent caveats findings.

### Fixed

- **Gmail-OAuth From-name** dropped — recipients saw the local-part only as sender (#623). Parity with IMAP/SMTP via the existing `formatAddr` helper.
- **Entrypoint `${VAR:0:8}` bash-only on BusyBox sh** (#625). Fresh users never saw the 8-char token preview; retrieval command hardcoded `docker exec lynox` (wrong container name under docker-compose). POSIX `printf | head -c 8` + host-side `cat ~/.lynox/.access-token`.
- **PasskeyPrompt no longer renders on self-host** (#626). Click used to dead-end at `/auth/passkey/register` (WebAuthn lives on the managed CP, not the engine). Bail on `supported === false`.
- **SetupBanner Mistral/Custom-OpenAI-compat first-save 500** (#627). `PUT /api/config` validated eagerly and 500-ed if vault was empty. Reorder: secret-PUT then config-PUT.
- **ONNX embedding cache write** (#628 + the installer compose-file parity in #631). `read_only: true` blocked the subdir mkdir; tmpfs at `/home/lynox/.cache` + entrypoint pre-creates expected subdirs.
- **ChatView polish** (#622): inline KI-badge, thread-actions hamburger menu, scroll-during-generation race fix.
- **Mistral fallback no longer overrides healthy Anthropic primary** in the status bar (#616).
- **Login logo `l` letter top cropped at h-20** (#631). SVG viewBox extended.
- **Login "Lost it?" hint** (#631) replaced hardcoded `docker logs lynox` with host-side `cat ~/.lynox/.access-token`.

### Internal

- **Installer Compose-version display** (#624). Was printing `Compose ersion` because the regex matched the `v` in literal "version". Anchored regex + Vertex env-vars removed from `--help`.
- **Installer compose-file generator** picks up #628's huggingface tmpfs + pids_limit + json-file logging rotation (#631). Every `npx @lynox-ai/core` user used to re-trip the ONNX-cache ENOENT.
- **`.dockerignore` patterns are recursive** (`**/node_modules` etc.) (#631). Host-side `node_modules` was leaking into the docker context on Apple Silicon contributor builds and dangling the symlinks pnpm install produced. CI on Ubuntu happened to not hit it; pinning explicitly removes the platform-dependence.
- **Stale-name sweep** across 32 files (#631). Dead Telegram / Slack / MCP / Tavily references removed from JSDoc comments + retired-integration test fixtures. `ContextSource` narrowed from `'cli' | 'slack' | 'mcp' | 'pwa'` to `'cli' | 'pwa'` (actual call sites).
- **LLM-provider claim cleanup** (#631). Docs, `.env.example`, `--help`, installer hints, SetupBanner i18n (DE+EN), `llm/catalog.ts` all mark Anthropic + Mistral as tested-on-every-release and every other openai-compat target as experimental.
- **`POST /api/secrets/validate-key` engine endpoint** (#629) backs the SetupBanner pre-flight; same shape as the CLI's validators (`KeyValidation` 3-state).
- **Pre-flight security + honesty + UWG sweep** (#617).
- **Docs drift cleanup + ROADMAP v2 publish** (#621).
- **Public-repo stale-ref + PII-fixture cleanup** (#620).
- **Deps bump 16 minor/patch** (#619).

## 1.7.4 — 2026-05-25

Patch — pre-HN-launch cleanup. Two Bugsink-noise fixes against `v1.7.1` and a CLI-side legal addition.

### Added

- **`Terms of Service` acceptance gate in the CLI setup wizard.** First `npx @lynox-ai/core` / `lynox init` shows the ELv2 / no-warranty terms with a confirm prompt, persists acceptance in `~/.lynox/.tos-accepted-1`. Bumping `TOS_VERSION` re-prompts (versioned consent). Closes Item 17 of the 2026-05-25 pre-HN legal audit (#613).

### Fixed

- **WorkerLoop benign workflow-not-found races no longer surface to Bugsink.** When a saved workflow is deleted between cron-scheduling and the executor tick, `executePipeline` records the skip via `recordAndNotify` ("no longer exists (skipped)") instead of rethrowing the typed error. Closes Bugsink `ENGINE-8` (#614).
- **Session-run returns a friendly 400 when no LLM key is configured** instead of letting the Anthropic SDK deep-throw from `validateHeaders()`. Adds a pre-flight check on `POST /api/sessions/:id/run` that mirrors the `configured.api_key` logic in `GET /api/secrets/status`. Closes Bugsink `STAGING-ENGINE-6` + `STAGING-ENGINE-7` (#615).

### Internal

- User-facing string casing `LYNOX` → `lynox` in 4 boundary surfaces (http-api startup log, Google-auth HTML pages, content-extractor User-Agent header). Closes pre-HN legal audit trademark item P1-19 (#612).

## 1.7.3 — 2026-05-25

Patch — **HN-launch hardening sprint** (33 PRs, +155 tests). Re-cut after `v1.7.2` stalled in the docker pipeline; the matrix builder unblocks a 6.5× faster multi-arch publish. Focuses on EU-residency leak closure, BYOK disclosure, multi-arch images, and security-audit follow-ups.

### Added

- **BYOK allowlist + disclosure for custom LLM endpoints** — the custom-provider wizard surfaces a vetted allowlist with provider-specific privacy posture before the key prompt; user must accept the data-flow disclosure (#607).
- **AI-generated marker on assistant messages** (chat UI) + **`X-lynox-AI-Generated` SSE header** — Art. 50 transparency (#591, #590).
- **ToolCallTracker wired in shadow mode** for anomaly observability — H-024 (#595).
- **Sensitive-paths list expanded** to cover lynox DBs, shell histories, and macOS Keychain — H-003 (#593).

### Fixed

- **Chat cost-footer no longer accumulates across multi-turn** — was showing 3-6× actual cost on long threads (#608).
- **Inbox classifier honours provider-switch** — H-012 / EU-residency leak (Anthropic was being called after switch to Mistral) (#606).
- **`plan_task` + `run_workflow` plumb fresh provider config** — H-011 (#605).
- **`read_file` + `spawn_agent` returns wrapped in untrusted-data envelope** — H-001 + H-002 (#592).
- **`bash` env no longer inherits `SSH_AUTH_SOCK` / `GIT_ASKPASS` / `GIT_SSH_COMMAND`** — H-004 (#594).
- **`npx` symlink shim resolves realpath in `isMainModule`** — fixes the silent no-op on some PNPM installs (#584).

### Changed

- **Multi-arch docker images (amd64 + arm64) via native arm64 runners + matrix manifest stitch** — fixes BI-003; 14.6 min total build (was QEMU-stalled in `v1.7.2`) (#585, #610).
- **`uuid` override bumped to >=11.1.1** — H-007 / CVE (#603).
- **`protobufjs` override bumped to >=8.2.0** — B-018 / CVE (#589).
- **`mistral-large-2512` pinned** in catalog + docs (B-004 + B-005) (#586).
- **`api-cost-display` flag defaults true** — B-011 (#588).
- **Docs honesty pass**: Tavily references struck from `CLAUDE.md` + api-store (H-014, #602); Telegram infra attribution corrected (H-017, #596); SameSite cookie attr corrected to Lax in security docs (H-013, #598); docker image tag example bumped to 1.7.1 (H-015, #597); Activity Hub link route fixed after IA-V2 (H-016, #599); Automation Hub vs Activity Hub disambiguated (H-018, #600); Verify-Setup step 3 refreshed to match v1.5.1 StatusBar (#601); MCP server claim struck from `CLAUDE.md` + `ROADMAP.md` (B-006, #587).
- **libvips LGPL-3.0 dependency documented** in licenses (H-005, #604).

### Internal

- **v1.7.2 cancelled** — docker-publish pipeline stalled on QEMU during the multi-arch build; re-cut as v1.7.3 with the new matrix manifest-stitch flow.

## 1.7.2 — Cancelled

Tag was cut and released but the docker-publish pipeline stalled on QEMU during the multi-arch build. Re-cut as `v1.7.3` with a matrix manifest-stitch flow (#610). Use `v1.7.3` or later — there is no production `v1.7.2` image.

## 1.7.1 — 2026-05-25

Patch — **Mistral first-class + EU-residency leak closure + Settings polish** (19 PRs, morning sprint).

### Added

- **Mistral Large 3 as Sonnet-tier replacement** + retire stale model names (`small/large/magistral` text refresh post-Ministral-gen3 swap) (#566, #567).
- **Mistral native prompt cache** surfaced in adapter + bench harness (#565).
- **Set-Bench v4 harness** — 8 lynox-real-world axes + cache-aware costs (#559).
- **API-store: curated bootstrap-suggestion catalog** injected into agent context (#558).
- **Honesty-fallback when `web_research` is not configured** — agent gets explicit "DO NOT fabricate" instructions instead of inventing arXiv IDs / prices (#564).
- **Web-UI demo-mode**: auto-session + locale lock + onboarding chips + cost hide (#481).
- **Provider-aware Denkstil UI** + remove duplicate Standard options (#578).

### Fixed

- **EU-residency leaks**: sub-agent inherits Mistral provider config from parent (#568); `llm-helper.callForStructuredJson` honours user provider/model (#570); `process-capture` plumbs provider/model so Mistral users can save workflows (#571); structured EU residency provider-switch propagation test (#574); bench-driven product tweaks (#569).
- **Adapter delta.content** no longer leaks `[object Object]` for non-string content (#572).
- **`/api/secrets/status`** recognises non-Anthropic provider keys (#546).
- **OpenAI path hardened**: `finish_reason`, `tool_choice`, config-validate (#532).
- **Web-UI**: SSE error events surfaced + status bar bound to active provider (#560); KG view toggle wires Graph mode (#561); auto-save LLM provider tile click for curated presets (#557); stop leaking `[ONBOARDING N/3]` markers + ask for explicit `artifact_save` (#556); hover-prefetch no longer silently logs users out (#554).
- **Nav**: chat-history fills sidebar without flicker via `mt-auto` (#582); flex spacer pinning (#580); settings reactivity + compound-noun preservation (#581); markdown `N.` rendering + footer label + nav pin (#579).
- **Server**: rebuild `used_cents` from daily entries (HN P0) (#562); default `ORIGIN` on source/npx boot to fix CSRF login 403 (#563).
- **Orchestrator**: thread parent memory backend to sub-agent inline steps (#553); allow `memory_*` tools in workflow inline steps (#548).
- **Network-guard**: guard against undefined address in `resolveAndValidate` (#551).
- **Auth**: consolidate `isHttpsRequest` helper — restore `Secure` cookie flag on managed deployments (#484).
- **Cron**: surface cron failure as `status='failed'`, auto-recover on next success (#544).
- **B1 memory_recall/update/delete** reverted to flat-file + 3 optimizations (#540).

### Changed

- **Self-host installer hardened** — 6 P1 fixes for HN-launch readiness (#547).
- **CLI trimmed** to launch-essential modes (wizard, http-api, init) (#537).
- **WhatsApp Inbox removed** until staging E2E coverage exists (#538).
- **README / docs**: docs honesty pass — source-available framing + internal OWASP + telegraf dep removal (#552); MCP card dropped from docs Integrations (#543); one-shot mode section removed from README (#542); login logo swapped to brand variants (#549); `mistral-large-2512` pinned in `llm-providers` + Mistral repositioned (#576).
- **Pre-launch prompt-slice optimisation**: capability surface + EU/OSS framing + KPI trigger (#577).
- **`/app/workflows` → `/app/automation` redirect** for the IA-V2 rename (#541).
- **CI**: stub gitleaks/test/docker-scan for docs-only PRs (#550).
- **Spawn**: extract provider-precedence helper + `Agent.toJSON` scrub (#573).
- **Tier-1 HN-launch compliance hardening** umbrella (#555).
- **Search-reranker Mistral-disabled state surfaced in UI** (#575).
- **Launch-readiness sweep**: `CONTRIBUTING`, `ROADMAP`, `SECURITY`, licenses (#483).
- **memory_recall chat visibility locked in** + label fallback tightened (#545).
- **`Lock in memory_recall` chat visibility + tighter label fallback** (#545).

## 1.7.0 — 2026-05-22

Minor — **Workflow-UX unification + chat-streaming polish + agent-efficiency**. The agent's workflow tool surface is consolidated 8 → 6 with one consistent "workflow" vocabulary across tools, HTTP API and UI, plus a new **Saved Workflows** library tab. The chat stream gains an animated presence indicator, a live activity ticker, interleaved thinking, and an inline compaction marker. Agent-efficiency work lands orchestrated sub-agent routing and non-lossy compaction (a tool-result recall blob store). **Breaking:** the tool renames and the `/api/pipelines*` → `/api/workflows*` endpoint move are a hard cut with no alias — external MCP clients / API scripts must update.

### Breaking

- **Agent tool surface 8 → 6 (#510, #512, #514)** — `run_pipeline` → `run_workflow`; `capture_process` + `promote_process` merged into one `save_workflow`; `step_complete` removed.
- **HTTP API `/api/pipelines*` → `/api/workflows*` (#511)** — hard rename, no alias.

### Added

- **Saved Workflows library (#513, #520)** — A library tab listing reusable workflows with run / rename / delete, and expandable per-step details.
- **`save_workflow` tool (#512)** — One call to capture and save a reusable workflow; merges the former `capture_process` + `promote_process`, with redaction hardening.
- **`plan_task` decoupled (#514)** — Planning never executes; it returns a reusable `workflow_id` that `run_workflow` runs.
- **Chat streaming presence (#494, #497–#499)** — Animated lynox-icon presence indicator + live activity ticker coupled to run state.
- **Interleaved thinking (#492)** — Thinking renders interleaved with text and tool calls in chronological order.
- **Compaction marker (#491)** — A persistent inline marker shows where the conversation was compacted.
- **Downloadable artifacts (#493)** — Data-file artifact types are downloadable; HTML artifacts offer a source download.
- **Orchestrated sub-agent routing (#507)** — Eligible multi-step plans dispatch one sub-agent per step.
- **Non-lossy compaction (#508)** — Large tool results are evicted to a recall blob store at compaction and fetchable on demand via `recall_tool_result`.

### Fixed

- **Main agent no longer auto-downgrades (#517)** — The main conversational agent always runs on the configured tier; the per-turn `_isSimpleTask` heuristic that silently dropped to Haiku is removed.
- **Deterministic `save_workflow` steps (#521)** — Step extraction preserves the actual action sequence; the LLM only annotates a fixed step list and can no longer merge or drop steps.
- **Per-message usage footer survives an SSE drop (#518)** — The `done` event echoes the run usage so the footer renders even if the `turn_end` frame is lost.
- **Per-message LLM usage persists across thread resume (#486)**.
- **Saved-workflow persistence (#515, #516)** — `save_workflow` and decoupled `plan_task` persist their pipelines so the library and `workflow_id` survive a restart.
- **Context budget from real API usage (#489)** — Replaces the summed estimate that drifted past 100%.
- **Truncated `max_tokens` turns continue (#490)** — A turn cut off at the token cap resumes instead of returning empty.
- **Voice (#488, #495)** — STT glossary no longer rewrites common words to proper nouns; voice messages can't double-submit.
- **Speak (#503)** — TTS-hostile special characters normalized.
- **Web UI (#485)** — Mobile nav, chat scroll, artifact deep-links.
- **`capture_process` reads session-wide tool calls (#505)**.
- **Operator-channel hallucination (#502)** — The prompt states the real operator channels, stopping Telegram hallucination after the Telegram removal.
- **Nav chat-history fills the sidebar (#519)** — The thread list grows to fill available height; other nav items pin to the bottom.

### Internal

- **Agent-efficiency measurement (#506, #509)** — Phase-0 measurement protocol + a Tier-1 static cost-regression guard.
- **perf(memory) (#487)** — A no-query `memory_recall` is bounded to a ranked, capped subset.
- **Shared `AgentPresenceIcon` (#500)** — Extracted; transcription state animated.
- **Transcription animation + compaction history block (#501)**.
- **Telegram references removed from README + bench fixtures (#504)**.
- **CI: staging-smoke pnpm setup fixed (#496)**.

## 1.6.0 — 2026-05-19

Minor — **Magic-Link OTP + Settings v3 inline-merge + Stripe-portal stopgap**. Adds passwordless email login as a third auth method alongside passkey + password. Settings v3 sprint lands the capability registry, tier audit, show-all-grayed pattern, Account pages, and inline merge of Advanced into the LLM main page. The broken `control.lynox.cloud/checkout/account` CTA in Account+Billing is replaced with a Stripe-hosted Customer Portal link + `support@` fallback (full engine→CP→Stripe SSO deferred — see `PRD-STRIPE-PORTAL-SSO.md` v3). Light-mode theme ships. Plus a session-cookie hardening pass (`SameSite=Lax` + OTP stale-session guards) and a `http_request` hang-fix that previously could lock a session.

### Added

- **Magic-link OTP auth (#472, pro #149)** — Email-driven passwordless login alongside passkey + password. HMAC token mint/verify/consume with nonce-replay protection, 15-min TTL. Staging-E2E proven on `meridian-demo` via Mailpit.
- **Light mode (#476)** — Web-UI theme switcher; persists to user prefs.
- **Settings v3 sprint (#471)** — `ModelCapability` registry as single source of truth for tier/context-window display. Tier-awareness audit across all settings pages. Show-all-grayed pattern for managed-blocked sections. Account pages (Appearance, Security, Limits, Updates) split out from monolithic `SystemSettings`. Advanced merged inline into the LLM main page.
- **Stripe-portal URL forwarding (pro #151)** — `MANAGED_STRIPE_PORTAL_LOGIN_URL` from CP env now flows to every managed instance's `.env` as `LYNOX_STRIPE_PORTAL_LOGIN_URL`. Engine `/api/config` surfaces it under `stripe_portal_login_url` for the Account+Billing CTA. Prefix-guarded to `https://billing.stripe.com/`.

### Fixed

- **Broken `control.lynox.cloud/checkout/account` CTA (#478)** — Account+Billing now opens the Stripe-hosted Customer Portal login URL when configured, falls back to `mailto:support@lynox.ai` otherwise.
- **`/auth/magic` auth-gate hole (#477)** — Magic-link callback route exempted from the session-cookie auth gate (was 401-blocking the pre-login token verification).
- **LLM defaults dropdown (#479)** — `effort_level`, `thinking_mode`, `experience` selects now show a `Default` option matching the model's actual default instead of forcing a choice between "Schnell" / "Deaktiviert".
- **Settings sub-view back-links (#479)** — `← Back to settings` added on Account Appearance, Workspace Security, Workspace Limits, Workspace Updates (were dead-ends).
- **Tool taxonomy (#479)** — `capture_process` + `promote_process` moved from System to Orchestration (the `_process` regex was incorrectly bucketing workflow tools as System).
- **OTP stale-session bypass (#469)** — Guarded OTP actions against requests with stale session cookies; `SameSite=Lax` migration tightens cross-site request scope.
- **`http_request` hang unsticks session (#470)** — Wall-clock cap + takeover + cancel for hung HTTP requests.
- **`managed_blocked` prediction (#466)** — UI predicts managed-blocked state from tier instead of waiting for runtime 403. Fixes context-window display drift on managed.
- **`ask_secret` managed-vs-cancel (#465)** — Distinguish CP-rejected secret writes (managed-blocked) from user-cancel in `ask_secret`.

### Security

- **Managed secret allowlist inverted (#468)** — Default user-writable on managed; narrow deny-list (`LYNOX_*`, `MANAGED_*`, `MAIL_ACCOUNT_*`, `WHATSAPP_*`, `GOOGLE_OAUTH_*`, `SMTP_*`, `IMAP_*`) is admin-only. Realises the core promise: customers connect any API without filing a support ticket.
- **OAuth2 fail-loud** — OAuth flow errors now surface immediately rather than silent-fail.
- **Engine-managed Bearer auth** — Stricter Bearer-token verification across managed surfaces.

### Internal

- **Mailpit on staging-CP (pro #150)** — Outbound mail sink for OTP / magic-link / dunning testing on the staging control plane.
- **Deps bump (#475)** — Minor-and-patch group, 12 updates.

## 1.5.2 — 2026-05-18

Patch — **LLM provider-switching hardening** (rafael QA across the day). After v1.5.1 shipped, switching from Anthropic to Mistral exposed five stacked bugs in the runtime + UI: the engine kept reading `ANTHROPIC_API_KEY` regardless of provider, `/api/llm/test` 400'd on saved-and-empty body keys, the model self-identified as "Claude Haiku" even though Mistral was dispatched, the UI hid the tier-set behind a single misleading "Modell" dropdown, and on managed the API-key input was a disabled red-herring. Six follow-up PRs land the wire-level fixes, the UI cleanup, and the explanatory anchors so a provider switch is robust + observable.

### Fixed

- **Robust live provider switching (#456 follow-up #458)** — Engine `_recreateClient` now resolves the API key from the active provider's vault slot (Mistral → `MISTRAL_API_KEY`, Custom → `CUSTOM_API_KEY`, OpenAI → `OPENAI_API_KEY` secondary) instead of hardcoding `ANTHROPIC_API_KEY`. Session passes the provider-resolved key to the Agent. `/api/secrets/:slot` hot-reloads on every BYOK slot, not just `ANTHROPIC_API_KEY`. New canonical helper `core/llm/provider-keys.ts` mirrors the web-ui's `VAULT_SLOTS` map. (#458)
- **`engine.reloadCredentials()` for vault-only writes (#458 round-1)** — Pre-fix the existing `reloadUserConfig` gated `_recreateClient` on config.json field deltas, so `/api/secrets/:slot` writes left `engine.client` stale (visible to KG init + batch ops). New `reloadCredentials()` forces re-init and is called by the secrets endpoint. (#458)
- **`/api/llm/test` vault-fallback** — When the user previously saved a key and the form posts an empty body key (page reload), the endpoint now resolves from env > vault instead of returning `400 "API key required"`. Pre-fix made "Verbindung testen" unusable after the first save. (#458)
- **UUID-validated test endpoint** — `POST /api/llm/test` validates `provider` against the LLMProvider union before the cast, closing a defensive gap for future `SECONDARY_SLOTS` expansion. (#458)
- **Per-secret audit row** — Every BYOK secret write emits a `secret_update` SecurityAudit row (names-only, no values) matching the `PUT /api/config` audit parity from P3-PR-B. (#458)

### Changed

- **SYSTEM_PROMPT identity anchor (#458, #460)** — A new `modelIdentityContext` helper interpolates the active provider + actual model id into the system prompt and explicitly forbids tier-alias self-identification (`opus` / `sonnet` / `haiku` are routing tiers, not model names). Sanitises the user-controllable `openai_model_id` field (strips backticks/newlines/structural chars, caps 64) to close a prompt-injection vector on managed. Pre-fix Mistral confidently answered "Ich bin Claude Haiku" because nothing pinned its identity.
- **LLM Settings → Mistral preset tier-set view (#459)** — The misleading single "Modell" dropdown (which wrote `openai_model_id` with no runtime effect on tier-aware providers) is gone for Mistral. The tier-set summary block now shows both Main + Small/fast model, with a one-line "lynox routes per turn — simple replies → small, complex → main" hint. Anthropic keeps its dropdown because there it binds to runtime-meaningful `default_tier`. (#459)
- **Mistral default-tier picker parity with Anthropic (#461)** — Unified picker for every tier-aware provider, binding `default_tier`. On Mistral the tier maps via MISTRAL_MODEL_MAP (sonnet → Large, opus → Magistral, haiku → Small). The tier-set summary follows the user's selection (no more silent "Main: Mistral Large" while picker says Magistral).
- **Per-turn model indicator in chat footer (#460)** — The SSE `turn_end.model` was already extracted for cost; now it surfaces next to "X tokens · $0.04 · `mistral-large-2512`" so users can see which model produced each reply (relevant when the auto-downgrade flipped to Small for a simple task).
- **API-key + Test-connection hidden on managed tier (#462)** — On managed the CP supplies the LLM key; a disabled-but-visible input was misleading. Replaced with a short note: "API-Schlüssel werden von deinem Managed-Hosting-Plan bereitgestellt."
- **Tier-set summary tracks `default_tier`** — Picking Magistral in the tier picker now flips "Main: Mistral Large" → "Main: Magistral Medium" in the summary block. (#461)

### Removed

- **`/app/settings/llm/keys` route** — The 3rd-party API-key CRUD (Tavily, DataForSEO, etc.) moves to `/app/hub?section=keys` (Automation Hub gains a 4th tab "API-Schlüssel" next to API Profiles). The old URL 301-redirects so bookmarks survive. The LLMSettings sub-nav loses its "API keys" link — that page now owns only Provider + Key + Model + Advanced/Memory sub-routes. (#463)

### Security

- **`PROVIDER_KEY_SLOTS` allowlist** — Centralises the BYOK secret slots (`ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_API_KEY`) so future provider additions extend one set instead of N call-sites. `MISTRAL_API_KEY` + `CUSTOM_API_KEY` are now in `BYOK_USER_WRITABLE_SECRETS` (was Anthropic + OpenAI only). (#458)
- **Prompt-injection guard on `modelIdentityContext`** — Sanitises the user-controllable `openai_model_id` before interpolating into the system prompt's markdown code-span. Strips backticks, newlines, and any non-`[a-zA-Z0-9._:-]` char; caps length at 64. Managed users can write `openai_model_id`; without sanitisation an attacker could inject prompt instructions into the system role. (#458 round-3)

### Migration Notes

- `/app/settings/llm/keys` → `/app/hub?section=keys` (301)
- Existing `/app/settings/keys` redirect chain still works (it 301'd to `/app/settings/llm/keys`, which now 301s to `/app/hub?section=keys`)
- Vault slot semantics unchanged — Mistral keys stay in `MISTRAL_API_KEY`, Custom in `CUSTOM_API_KEY`, etc.
- No env-var changes required. Self-host users with `ANTHROPIC_API_KEY` set continue to work; switching to Mistral now reads `MISTRAL_API_KEY` (vault or env) instead of falling back to the Anthropic env var.

### Acknowledged Behaviour Changes

- **Mistral Magistral as default_tier** — Users can now set Magistral Medium as their orchestration tier (it was previously unreachable via UI on Mistral). Cost is ~$2 in / $5 out per 1M tokens — similar to Mistral Large but routes through the reasoning-heavy variant.
- **Auto-downgrade still applies on Mistral** — Simple turns continue to route to `mistral-small-2603` regardless of selected default_tier; the footer indicator now makes this observable. Disabling auto-downgrade is in the deferred Settings v3 sprint.

## 1.5.1 — 2026-05-18

Patch — **IA Consolidation V2** + **chat-reliability hardening**. Three-phase shell refactor shipped as one patch: Phase 1 collapses the dual-home `ConfigView` SSoT drift (1100+ LOC deleted, 12 settings now have single canonical pages, schema switches to `.strict()`); Phase 2 moves Activity into its own `/app/activity` root and repoints the footer cost/runs pills; Phase 3 finalizes Settings into 5 tier-conditional sections, splits Channels into 6 sub-routes, formalizes LLM sub-pages (Advanced/Memory), wires CommandPalette across all sub-routes, and deletes the deprecated Cost-Limits page. Mobile gets a net-new bottom-tab (Chat · Inbox · Activity · Intelligence · More). One canonical `formatCost` replaces three drifted implementations. Alongside the IA work, this release closes a chat-history-loss bug surfaced on rafael prod (#456): the agent loop now persists at every turn boundary instead of only end-of-run, the SvelteKit chat store's 404 recovery path now passes `threadId` so server-side eviction can't lose the conversation, and the SYSTEM_PROMPT carries a fabrication guardrail when memory_recall returns partial data. All legacy URLs 301-redirect — bookmarks survive.

### Changed

- **NEW top-level `/app/activity` route** — canonical home for Cost / Runs / History. Footer cost-pill and runs-pill now land here. Replaces the old `/app/hub?section=activity` sub-tab (auto-redirected for one release). (#422, #424)
- **`/app/hub` shrinks to 3 tabs** (Workflows / Tasks / APIs) — Activity tab stripped; legacy `?section=activity*` query-strings redirect to `/app/activity?tab=*`. (#425)
- **Settings 5 tier-conditional sections** — Main / Data / Workspace (Self-Host) / Access / Account. Workspace section hidden on Managed; tier-gating via `selfHostOnly` / `managedOnly` predicates with default-null managed-probe pattern. (#434, #435, #446)
- **Channel sub-routes** — `/app/settings/integrations/*` split into `/app/settings/channels/{mail,mail/rules,whatsapp,google,notifications,search}` + a hub index. Per-channel state stored in dedicated stores (`stores/integrations/*`). Mail-Rules gets its own route per Inbox-PRD pin. (#436, #448)
- **LLM sub-pages** — `/app/settings/llm/{advanced,memory}` carved out of LLMSettings. Data-driven sub-route nav array (designed for OpenAI-native Phase 4 reuse). (#447)
- **Tool-Toggles tier-conditional** — mounted at both `/app/settings/workspace/tools` (Self-Host) AND `/app/settings/privacy/tools` (Managed). Both routes always 200 OK; `SettingsIndex.keepItem()` hides the wrong one per tier — no async-redirect race. (#446)
- **Mobile bottom-tab** — new on smaller viewports: Chat · Inbox · Activity · Intelligence · More-Drawer. `AppShell.svelte` previously only carried the desktop nav-rail. (#426)
- **CommandPalette extended** — entries for all Phase 3 sub-routes (Workspace, Channels, LLM Advanced/Memory, Privacy, Account); tier-gating mirrors SettingsIndex. (#426, #449)
- **Footer Status-Panel** — pulls from `/usage/summary?period=today` (Voice STT/TTS included) instead of `/history/cost/daily`. One-time "now includes Voice" hint dismissed via localStorage. (#424)
- **Google OAuth post-callback** — self-host meta-refresh lands on `/app/settings/channels/google` directly (was `/app/settings/integrations`). One fewer redirect hop. (#448)

### Fixed

- **Chat history-loss on backgrounded sessions** — the agent loop now persists messages to `ThreadStore` at every stable turn boundary (after each assistant message and after every tool-result batch), not just at end-of-run. A container restart, OOM kill, or session eviction mid-loop no longer loses the in-flight conversation. Verified on staging via `message_count` growth per-turn (eager-persist hook in `agent.ts` + new `eager-persist.ts` helper with 8 unit-test contracts). Surfaced by rafael prod incident 2026-05-18. (#456)
- **404 session-recovery preserves thread continuity** — when the SvelteKit chat store hits a 404 on `/api/sessions/<id>/run` (engine restart, session TTL expired), the recovery path now passes the active `threadId` to `POST /api/sessions` instead of minting an empty thread, so the model rejoins the existing conversation with `resumed: true` in the response. (#456)
- **Anti-fabrication guardrail on partial memory recall** — when `memory_recall`, `read_file`, `data_store_query`, or KG entity lookup returns only part of what the user asked for, the SYSTEM_PROMPT now instructs the agent to surface what is known and ask for the rest, instead of padding the answer with plausible-sounding details. (#456)
- **`formatCost` collapsed to a single canonical implementation** — three drifted copies (sub-cent rounding, cents-style, locale-aware) reconciled into one helper. (#420)
- **Stale `update_check` setting** accepted via `passthrough` is now explicit in the config schema. (#421)
- **`BackupsView` no longer leaks response-only fields** (`capabilities`/`locks`/`managed`) back into `~/.lynox/config.json` on save. (#421)

### Removed

- **`ConfigView.svelte` deleted** (1100+ LOC). 12 dual-homed settings now have a single SSoT in their extracted pages (LLMSettings Advanced/Memory, SecretsView, SystemSettings, CostLimits). (#421)
- **`/app/settings/{keys,apis,data}` stub routes** — replaced with SSR-301 redirects to canonical homes (`/settings/llm/keys`, Automation → APIs, Intelligence → Data). (#418)
- **`AutomationHub.svelte` Activity tab** — Activity has its own root now. (#425)
- **`CostLimits.svelte` deleted** (-227 LOC) plus `/app/hub/cost-limits` route — replaced by `/app/settings/workspace/limits` (Self-Host) + `/app/settings/llm/advanced` (context-window). Legacy URL 301-redirects. CostLimits-only i18n keys pruned; shared `cost_limits.saved/save/loading/...` keys retained for use by Workspace and LLM views. (#450)
- **`IntegrationsView.svelte` deleted** (-661 LOC) — superseded by 6 per-channel components (`MailSettings`, `WhatsAppSettings`, `GoogleSettings`, `NotificationsSettings`, `SearchSettings`, `ChannelHub`). Library barrel keeps `IntegrationsView` as an alias to `ChannelHub` for downstream compatibility. (#448)

### Security

- **`LynoxUserConfigSchema` switched from `.passthrough()` to `.strict()`** — unknown PUT-fields are now rejected (HTTP 400) instead of silently persisted. Closes the ghost-write vector documented in V2 Round-1 Security review. (#421)
- **`max_context_window_tokens` upper-bound** — `z.number().int().positive().max(1_000_000)` on the user-config schema. Blocks an attacker on a Managed instance from setting an unbounded value (the field is allowlisted in `MANAGED_USER_WRITABLE_CONFIG`); the schema is the load-bearing gate. Matches the largest UI radio option + Sonnet 4.6 frontier window. PRD-IA-V2 Security S3. (#447)
- **New invariant test:** `disabled_tools` cannot enable a tool that `excludeTools` blocked (regression-pin for V2 Round-1 S7 finding). (#419)
- **`PUT /api/config` audit-log** — every write emits a `config_update` SecurityAudit event with `fields_changed: [keys]` (keys-only, never values, so the trail cannot leak secrets or spend caps). PRD-IA-V2 Security S4. (#435)
- **All settings-route 301-redirects use hardcoded path/tab allowlists** — no user-input pathname passthrough (Round-1 S2 mandate). Applies across `/app/settings/*` stubs, `/app/hub?section=activity*` → `/app/activity` redirects, AND the new `/app/settings/integrations/*` → `/channels/*` redirect chain via `assertChannelTarget` helper + 30 contract tests covering URL-encoded, whitespace, case-sensitivity, and trailing-slash payload classes. (#418, #425, #448)
- **`POST /api/sessions` threadId is UUID-validated and case-normalised** — module-scope lowercase-only regex + `rawThreadId.toLowerCase()` before the gate. Closes a silent thread-fork via uppercased UUID (SQLite TEXT PRIMARY KEY uses BINARY collation, so `DA65E649-…` would have minted a parallel thread next to `da65e649-…`). Caught by /pr-review round-3 Security on #456. (#456)

### Migration Notes

- `/app/settings/config` → `/app/settings/llm` (+ tab-aware sub-targets, 301)
- `/app/settings/keys` → `/app/settings/llm/keys` (301)
- `/app/settings/apis` → `/app/automation?tab=apis` (301)
- `/app/settings/data` → `/app/intelligence?tab=data` (301)
- `/app/hub?section=activity*` → `/app/activity?tab=*` (301)
- `/app/hub/cost-limits` → `/app/settings/workspace/limits` (301; max_context_window_tokens moves to `/app/settings/llm/advanced`)
- `/app/settings/backups` → `/app/settings/workspace/backups` (301)
- `/app/settings/system?part=security` → `/app/settings/workspace/security` (301)
- `/app/settings/integrations/tools` → `/app/settings/workspace/tools` (301 — Self-Host nav surfaces this; Managed surfaces `/app/settings/privacy/tools` instead, both routes always render)
- `/app/settings/mobile` → `/app/settings/account/mobile` (301)
- `/app/settings/integrations` → `/app/settings/channels` (301)
- `/app/settings/integrations/{mail,mail/rules,whatsapp,google,notifications,search}` → `/app/settings/channels/<name>` (301)
- Footer cost/runs pills now land on `/app/activity` (were `/app/hub?section=activity`)
- Bookmarks survive — every old route 301-redirects.

### Acknowledged Behaviour Changes

- `ColdStartBanner` migration-estimate now renders in en-US format (`$0.42`) instead of de-CH (`0,42 $`). Consistency win across all cost displays via the unified `formatCost`; matches PRD-IA-V2 Non-Goal "no locale-aware currency rendering".
- Empty Activity-Overview state shows a zero-state CTA ("Noch keine Runs heute — starte einen Chat") instead of $0.00 placeholders.

## 1.5.0 — 2026-05-16

Minor — **HN-launch readiness release**. Settings & Usage IA Refactor (23 PRs landed 2026-05-15) consolidates the post-onboarding surface around six top-level tabs. **Telegram integration removed** as a customer-facing feature (data sovereignty + attack-surface reduction; companion still available in self-hosted core). API Setup v2 graduates with Smart Bootstrap from `docs_url`. LLM Settings page + model catalog endpoint replace the BYOK-by-env-only flow. Tool-Toggles + server-side enforcement land as a first-class security primitive. README + first-run + provider matrix polished for HN.

### Added — Settings & Usage IA Refactor (Phases 0-5 + T1-T7)

- **Six top-level tabs** with route migrations: Chat / Hub / Intelligence / Automation / Voice / System. Replaces the legacy `/app/settings/*` grab-bag. (#387, #389, #391, #393)
- **Activity Hub elevated to `/app/hub`** (route migration with redirects). Cost & Limits surface at `/app/hub/cost-limits`. (#387, #389)
- **System settings top-level page** consolidates security, residency, sessions, build version. (#393)
- **Voice + Privacy & Data top-level settings pages** — split out of the legacy compound surface. (#391)
- **LLM Settings page** with `/api/llm/test` connection probe + per-provider key entry; replaces the env-only BYOK flow. (#390)
- **Custom-Endpoint Confirm-Banner** on LLMSettings reduces foot-shotgun risk when wiring LiteLLM bookmarks. (#399)
- **Multi-Custom-Endpoint Registry** (LiteLLM-style bookmarks) — users save multiple OpenAI-compatible endpoints with per-bookmark display name + key. (#402)
- **Tool-Toggles + server-side enforcement** — per-tool enable/disable that the engine respects on dispatch, not just the UI. Security gaps from /pr-review closed in #405. (#401, #405)
- **Bugsink toggle** in web-ui (schema + engine wiring + UI) — self-hosted users can flip error reporting from settings instead of env. (#400)
- **API profile delete** UX (#375). API Profiles moved to Automation tab (#382). DataStore moved to Intelligence tab (#376).
- **Reserve `/app/settings/integrations/api-store/` sub-route** for the upcoming managed API-Profile store. (#392)

### Added — API Setup v2 + Smart Bootstrap

- **API Setup v2 default-on** — agent-driven setup graduates from feature-flag to default. (#395)
- **Smart Bootstrap from `docs_url`** (Phase B) — agents bootstrap a profile by reading the API's docs page directly when no OpenAPI spec exists. (#367)
- **Linked-section fan-out** in `docs_url` bootstrap — 1-2 follow-up reads when the landing page references nested endpoints. (#369)
- **`tool_progress` events during `docs_url` bootstrap** — the StreamingActivityBar surfaces what the bootstrap is currently reading. (#368)
- **API Profile v2 schema + loader migration** — new shape: `auth_scheme`, `limits`, `parallel_ok`, `output_volume`, `dos`, `donts`, `sub_agent_strategy`. (#365)
- **Per-call cost emission + render** from profiled APIs (Phase E). (#373)
- **`/api/llm/catalog` endpoint** — canonical LLM model catalog (replaces hard-coded UI lists). (#386)
- **`/api/usage/current` SSoT endpoint** — single source of truth for current usage; powers Cost & Limits and Status surfaces. (#388)
- **`/api/config` shape extended** with `capability` + `locks` — UI can render lock-icons for managed-policy-pinned settings. (#385)

### Added — HN-launch surface

- **README polish for HN** — multi-provider matrix, ELv2 framing, "NOT good at" honest-limits table, founder section. (#370)
- **First-run provider choices** aligned with HN-launch positioning (Anthropic + Mistral + Custom). (#371)
- **Provider matrix restructured** (Vertex dropped; Anthropic / Mistral / Custom-OpenAI-compatible primary). (#372)
- **AppShell sidebar redesign + Migration Wizard docs page**. (#362)
- **Walkthrough docs aligned** with the current provider set. (#374)
- **Chat rendering polish** — 4 findings bundled (#383).

### Added — Tests & CI

- **Staging-Smoke Playwright workflow + spec in `tests/smoke/`** — runs against `engine.lynox.cloud` after every release. (#398, #403)
- **F14 — vitest coverage for the Settings-Refactor sprint surface** (+41 new tests). (#408)

### Removed (breaking — customer-facing Telegram)

- **End-user Telegram integration killed** — `src/integrations/telegram/` channel-side surface removed (8 integration files + 553-line `telegram-bot.ts` deleted). `telegram_bot_token` + `telegram_allowed_chat_ids` removed from config schema + types. Managed plane stops provisioning bot tokens. Driven by: data-sovereignty posture for HN-launch, attack-surface reduction (Wave-4 callout), and the unified-inbox repositioning. **Migration:** existing managed customers with active Telegram are auto-migrated to email-only inbox; bot tokens revoked. **Rollback note:** v1.4.2 still references the removed config fields — downgrade after env-var removal will require operator to restore tokens manually. (#397)
- **`MANAGED_TELEGRAM_BOT_TOKEN` for ops alerting (Alerter/Gatus) is unaffected** — it lives in `pro/packages/managed` and is separate from the customer-facing channel. Ops alerts continue to flow through Telegram.

### Fixed

- **`api-setup`: steer agents to `docs_url` when OpenAPI spec is too large** — closes the bootstrap-budget false-positive that surfaced as HN-launch blocker. (#415, #379)
- **`api-setup`: support `auth.type="none"`** for public APIs (open-data + free LLM endpoints). (#414)
- **`api-setup`: wire ApiStore into ToolContext on fresh installs** (closes the "profile saved but never visible" path). (#413)
- **SetupBanner: show provider picker on BYOK starter**, not just self-host. (#412)
- **`llm-helper`: default to Sonnet engine-wide**, Haiku as override (was inverted). (#411)
- **Engine: mirror resolved Anthropic key into `process.env`** so downstream libraries that read from env see the key vault resolved. (#410)
- **`http-api`: allow managed users to set their own preference fields** (was 403 on managed-pool BYOK). (#409, #406, #396)
- **Security: close 3 Tool-Toggle enforcement gaps** surfaced by `/pr-review` on #401. (#405)
- **Auth: align engine session-cookie TTL with web-ui + roll on use** — closes the 7d/30d drift that caused random "Verbindung verloren" toasts on iOS Safari PWA. (#381)
- **Apply Sprint-Review follow-ups** (5 blockers + 9 nits in one bundle). (#407)
- **Entrypoint: warn when `~/.lynox/` has files owned by a different uid** — catches the docker-compose user-id mismatch upfront. (#380)
- **Hide CRM-overlap DataStore collections + drop stale empties at startup**. (#378)
- **Fix stale `labelKey` in Intelligence Data tab**. (#377)

### Refactored

- **Apply 4 nits from `/pr-review` on #402** (Multi-Custom-Endpoint Registry polish). (#404)
- **Consolidate hard-limit constants into `core/limits.ts`** — single source of truth for all $/req/day caps. (#384)

### Pro / Managed Hosting

- **Customer-facing Telegram killed** in managed plane — mirror of core #397. Existing customers auto-migrated. (pro #142)
- **`api_setup` helper pinned to Haiku** in public-demo container — bounds cost of demo bootstrap runs. (pro #143)
- **Tier-1 public-demo scaffold** — landing page + sandbox compose + safety ADR for `demo.lynox.cloud`. (pro #135)
- **CF Worker daily-cost kill-switch** for demo (cap #5 — auto-stop demo when daily cost exceeds threshold). (pro #136)
- **`/trust` landing page** for HN-launch posture (data-residency, ELv2, no-train commitments). (pro #134)
- **`/compare/vs-saas-stack`: honest-limits table** (where SaaS stacks are still better). (pro #139)
- **Pricing page BYOK list aligned** with launch lineup. (pro #138)
- **HN launch post drafts** — three angle variants. (pro #137)
- **`bootstrap migration-tracking` on first deploy** — fixes the bootstrap-path bug that broke v1.4.2 release-CP. (pro #131)
- **`devalue` + `postcss` bumped** — clears HIGH CVE audit findings. (pro #133)

### Docs & Internal

- **PRD: Settings & Usage IA Refactor (HN-launch)** — drove the 23 PRs. (pro #141)
- **B3 architecture blog: "Anatomy of a lynox agent run"** (EN draft). (pro #140)
- **PRD: ad-hoc sub-agent teams for business-case fan-out**. (pro #132)
- **Docs: Unified Inbox page**; archive WhatsApp Inbox doc. (#361)
- **Docs drift fix**: Bedrock → Vertex provider, version + cost-limit drift across getting-started. (#360)
- **Docs boundary**: relocate tier-routing strategy from public docs to internal PRDs; generalize WA-beta references. (#359)

### Dependencies

- **`svelte` 5.55.7 + `@sveltejs/kit` 2.60.1** (devalue 5.8.1). (#366)

## 1.4.2 — 2026-05-14

Patch — UI clarity for long-running agent turns + the root-cause fix for the "Verbindung zum Server verloren" toast that surfaced on a canary tenant + Wave 3/4 security and refactor convergence.

### Added

- **StreamingActivityBar**: sticky surface above the chat input — replaces the pulsing-dot indicator that scrolled out of view during minute-long tool calls. Shows current tool label, elapsed seconds (1s tick), and a soft "Verbindung scheint langsam" hint when the server heartbeat goes silent for >25s. Visible during any streaming activity except pending prompts. (#363)
- **24 new tool-activity labels** (DE + EN) — `web_crawl`, `web_research`, `crawl_batch`, `write_artifact`, `spawn_agent`, `knowledge_*`, `contacts_*`, `deals_*`, `datastore_*`, `api_setup`, `read_file`, `write_file`, `ask_secret`, and more. Closes the generic "Arbeitet..." fallback users saw during research-heavy turns. (#363)
- **Responsive chat width**: `max-w-3xl` (768px) on mobile/tablet → `lg:max-w-4xl` (896px) → `xl:max-w-5xl` (1024px). Reclaims the empty real estate where the right-rail context sidebar used to live. (#364)
- Server SSE protocol: `event: heartbeat` every 10s carrying `{sentAt}` replaces the silent `: keepalive` comment. Client uses it to bump `lastEventAt` and detect stalled streams without a hard disconnect. (#363)
- Staging Greenmail end-to-end smoke scaffolding (#341, #342, pro #123)

### Fixed

- **Orphan stream timer and body-size reject paths** — the root cause for the "Verbindung zum Server verloren" toast that surfaced on a canary tenant. The 30-min SSE timer was not cleared on normal stream end, killing random later sessions. (#334)
- Telegram pending input resolved when the stale-prompt timer aborts the run (#336)
- Plan finalization gates on `completedAt`, not map presence — fixes the rare case of a plan finalising at step 2 of N (#335)
- Inbox: consolidation pass + textarea autogrow + session-expired banner (#337)
- Inbox: wrap + refresh-button + accurate counter restored (#332)
- ToolContext threading — `api_setup` OpenAPI fetch (#355) and `web_research` content extractor (#357) now receive the request-scoped context that earlier Wave 4 work introduced
- Google OAuth state bound to a signed HttpOnly cookie (#351)
- **Multi-tenant security (Wave 3)**: inbox `getItem` + 6 mutations scoped to `tenant_id` (#339); admin-gating + destructive-tool gaps closed (#338); tactical bundle of 4 audit findings (#340); 3 review nits across Wave 2/3 (#344); tenant-id threading from api.ts handlers through subsequent mutations (#343)

### Refactored (Wave 4 — Session-centric + declarative-by-default convergence)

- Engine `init()` split into 7 phases (#356, addresses the god-method finding)
- Config singletons → `ToolContext` (Wave 4.1 step 1, #350)
- Session counters → `Session` (Wave 4.1 step 2, #352)
- Outbound approvals + prompt dedup → `Session` (Wave 4.1 step 3, #353)
- Orchestrator types extracted to `src/types/orchestration` (#354)
- `sessionCostUSD` → `SessionCounters.costUSD` (#358)
- Declarative destructive flag on `ToolEntry` (#347)
- Declarative scope at route registration (#346)
- Single channel-wrap helper for untrusted external data (#345)

### Pro / Managed Hosting

- **Traefik websecure `idleTimeout` pinned to 300s** — defense-in-depth for long-running SSE turns (pro #129)
- **Stripe webhook dedup persisted across CP restarts** — prevents replay-on-restart duplicate billing actions (pro #119)
- **Billing lifecycle math + customer messaging** corrections (pro #120)
- **Provisioning optimistic-lock state-machine** transitions — Hetzner double-create gate (pro #121)
- **Per-file migration tracking** via `managed_drizzle_migrations` table — re-running the apply loop is idempotent now (pro #122)
- Gatus: `GATUS_OPS_ENABLED='false'` actually disables (zod-coerce trap fix, pro #125); env-guard for the ops config writer on staging (pro #124)
- Greenmail in staging CP compose for inbox e2e smoke (pro #123)

### Security / Dependencies

- `hono` override bumped to 4.12.18 + `ip-address >=10.1.1` (closes audit findings, #349 + pro #126)
- Channel-wrap helper for untrusted-data boundaries unified into a single implementation (#345)

### Docs & Internal

- PRD: **Unified API Profile v2 + sub-agent fetching** drafted (sprint-ready for v1.5.0). Smart bootstrap via docs-URL reading, constrained `fetch_url` tool for sub-agents with spawn-time URL allowlist, advisory routing layer, per-call cost display (Phase E, v1.6.0). (pro #130)
- Positioning: managed-plan provider-routing section (pro #128)
- CHANGELOG categorisation script per conventional-commit prefix (closes `project_cut_release_categorise`, #348)

## 1.4.1 — 2026-05-14

Patch — version-sync only. v1.4.0 `release-cut` bumped `core/package.json` and `pro/packages/managed/package.json` to 1.4.0 but missed `core/packages/web-ui/package.json`. StatusBar's stale-bundle check fires when the bundle's build-time `BUILT_VERSION` (baked from web-ui/package.json) does not match the engine's runtime `/api/health.version` (= core/package.json), so users on v1.4.0 saw a permanent "Neue lynox-Version verfügbar" toast that did not clear on reload (rebuilt bundle still had BUILT_VERSION=1.3.12 baked in). v1.4.1 aligns the three packages and patches the `/release-cut` skill so future releases bump all three together.

### Fixed

- **Web UI permanent stale-bundle toast on v1.4.0** — see above. (#331)

## 1.4.0 — 2026-05-14

Major feature release: Unified Inbox (Phase 1–4) ships as the new default mail surface, plus the Wave 1 security audit fixes.

### Added

- **Unified Inbox** — single inbox for mail + WhatsApp, classifier-driven triage with confidence-aware zone rail, snooze-with-mail-anchor, schedule-send, push notifications, three-pane reading-first layout with mail-context sidebar. Built across Phase 1a/1b/2/3/4. (#266, #268, #270, #271, #272, #274, #275, #283, #285, #286, #287, #288, #290, #291, #292, #293, #309, #314, #316, #318, #319, #320, #321, #322, #323)
- **Mail-anchored reminders** — `setSnooze(item, until, unsnoozeOnReply)` re-surfaces inbox items either at a wall-clock time or when the contact replies; standalone reminders without mail anchor work the same way via the new `inbox-reminder-poller`. Erinner-mich button in Reading-Pane + Triage rail, Kopilot top-card surfacing the next reminder, slash-command from chat. (#314, #316, #318, #319)
- **Push notifications for inbox** — classifier outcome → web-push to registered devices (per-account toggle + quiet hours + throttle), opt-in from the Integrations page. (#323)
- **Send Later** — schedule-send dropdown on the draft pane, persistent SQLite-backed poller fires the actual send. (#320, #321)
- **Operator-driven cold-start** — empty-inbox state shows a "fetch existing mail" button that triggers backfill against the connected mail account; the same path auto-fires on first account connect. (#275, #287, #288)
- **Sidebar redesign** — icon-rail hub with Chat / Automation / Intelligence / Artefakte sections, sticky-prompt anchor + persistent pipeline-status bar. Checkbox + Icon design-system primitives, brand-tinted scrollbar. (#265, #310, #311)
- **`mint-staging-cookie.sh` helper + phase-4 visual smoke spec** — Playwright runs against `engine.lynox.cloud` with a pre-minted 30-day staging cookie. (#326)
- **Sidebar improvements** — kebab menu rendered at root with fixed positioning (escapes the `<li overflow-hidden>` clip), Intelligence sub-nav + chat-thread kebab + search + icon polish. (#305, #306)
- **LLM cost observability for /draft/generate** — per-tenant audit row + rate-limit visibility. (#313)
- **Playwright smoke job in CI** — every PR runs the full smoke suite against a freshly built docker-compose stack. (#298, #300, #301)
- **Greenmail integration tests in CI** — IMAPS / SMTPS round-trip against the live test container as part of every push. (#300)

### Changed

- **Sidebar flattened** — Chat / Automation / Intelligence / Artefakte at the top level; sub-nav promoted to icon rail. (#265, #310)
- **Sidebar inbox entry** swapped to `/app/inbox` (was the legacy WhatsAppInboxView). (#274)
- **Mobile UX overhaul** for the Phase 3 layout — reading-pane header, thread expand affordance, draft footer alignment, sidebar safe-area handling. (#302, #303, #304, #307, #308)
- **`bash` air-gapped isolation now actually fires in production.** The previous module-level `_isolationEnvOverride` + `setIsolationEnv()` setter pair was registered but never invoked by any production code; `spawn_agent({ isolation: { level: 'air-gapped' } })` therefore inherited the full parent env (provider keys, vault key, Telegram token). The handler now reads `agent.isolation` directly, collapses env to `PATH`/`HOME`/`TMPDIR` for air-gapped, merges `isolation.envVars` for scoped/sandboxed. **BREAKING**: `setIsolationEnv` and `clearIsolationEnv` exports removed from `tools/builtin/index.ts` — no production caller existed; if your custom wiring used them, migrate to setting `agent.isolation` directly. (#329)
- **`MigrationImporter` constructor signature** — `httpSecret` parameter removed (was unused after the handshake-token refactor); `startHandshake` now takes the per-session migration token as an explicit argument. **BREAKING** for any external consumer constructing `MigrationImporter` directly. (#328)
- **Removed bedrock references** — managed-tier docs + provider strings now consistently reference Mistral (eu-sovereign) and Vertex; the historical `managed_bedrock` path stays in the provider enum for back-compat but is deprecated. (#267)

### Fixed

- **Migration handshake signature verification** — the X25519 ECDH handshake used by the zero-knowledge migration flow signed the server's ephemeral public key with an instance-local HMAC, but the source side never called `verifyHandshake`. A network attacker between source and destination could substitute their own keypair in the handshake response and decrypt the full DB + vault stream. Source side now `verifyHandshake`s before deriving the transfer key; signing key derives from the per-session migration token (shared bootstrap secret) instead of each side's `LYNOX_HTTP_SECRET`. (#328)
- **`api_setup` bootstrap SSRF + DoS** — the tool fetched its OpenAPI URL via raw `fetch()` with no protocol filter, no private-IP check, no redirect revalidation, no body cap, no timeout. An LLM-controllable URL could reach AWS/GCP metadata or the internal Docker bridge. Now routed through `fetchWithValidatedRedirects` + `readBodyLimited` with a 5 MB cap and 15 s AbortController. (#329)
- **Integration SSRF cluster** — three call sites were fetching/connecting to caller-influenced targets without checking they were on the public internet: (1) Google service-account JWT mint trusted `token_uri` from the operator-supplied JSON (could be redirected to GCP metadata), (2) WhatsApp `fetchMedia` trusted the URL returned by the Meta API (compromised/MITM'd response could redirect internal), (3) custom mail accounts opened TCP/TLS to any user-supplied IMAP/SMTP host (authenticated user could probe the internal Docker network). New shared `core/network-guard.ts` module with `isPrivateIP` (IPv4 + IPv6 + IPv4-mapped IPv6 hex form incl. `::ffff:7f00:1`), `assertPublicHost`, `assertPublicUrl`, `fetchWithPublicRedirects`. (#330)
- **Inbox: `cc`/`bcc` forwarded to send-reply handler.** Replies sent from the draft pane were dropping CCs and BCCs because the handler signature stopped at `{to, subject, body}`. (#284)
- **Inbox: snoozed items hidden from list + counters** until the snooze expires. (#285)
- **Inbox: sensitive-content masker re-runs on refresh path** when `sensitive_mode = 'mask'` — previously the masker only fired at classification time, so a body refresh re-exposed the raw text. (#312)
- **Inbox: collapsible context sidebar** + click-outside dismisses the menu + monochrome icon scheme aligned with the rest of the rail. (#327)
- **Web UI: permission card stays visible** after click until the tool actually starts, instead of vanishing on the same render tick. (#260)
- **Web UI: 409 fast-fail when client already holds a pending prompt** — prevents a double-submission when the previous turn's `ask_user` is still open. (#261)
- **Web UI: chat input gated on pending prompt**, duplicate anchor hidden. (#259)
- **Smoke runner: session cookie propagated** to Playwright's `APIRequestContext` so API-only calls inside browser tests authenticate correctly. (#298)
- **Tool-call row state** — running / done / error visual state propagated through grouped rows. (#262)

### Security (Wave 1)

This release closes 13 Critical/High findings from the codebase-wide audit run on 2026-05-13. All five Wave 1 PRs (#328, #329, #330 in core; #117, #118 in pro) ship together. See the Changed/Fixed sections above for #328/#329/#330; pro's #117 splits the managed admin token so an admin-token leak no longer forges customer sessions or Google OAuth state, and #118 envelope-encrypts four operator-sensitive Postgres columns with AES-256-GCM keyed off the new **required** `MANAGED_SECRETS_MASTER_KEY` env var.

Production deploy of the pro changes requires:
1. Generating the prod `MANAGED_SECRETS_MASTER_KEY` (`openssl rand -hex 32`) and backing it up to the secret store BEFORE deploying — losing this key makes all tenant backups un-decryptable.
2. Optionally generating `MANAGED_CUSTOMER_SESSION_SECRET` and `MANAGED_GOOGLE_OAUTH_STATE_SECRET` (HMAC fallback works without, but dedicated secrets are recommended for production).
3. A maintenance window that tolerates a 1h forced customer re-auth (#117 invalidates currently-active customer sessions; OTP re-login resolves it).


## 1.3.12 — 2026-05-06

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.11 (delete this block before saving):

Core:
- fix(web-ui): warm silent.wav + retry iOS TTS first play() (#257)
- fix(web-ui): use <video playsinline> for TTS on iOS Safari (#256)

Pro:

-->
## 1.3.11 — 2026-05-05

### Fixed

- **iOS PWA serving stale HTML indefinitely** — root cause of the symptoms Rafael caught canarying v1.3.10: tapping the "Update verfügbar" toast didn't actually load the new bundle, voice messages reloaded the page in a flicker without sending, and the iOS-audio fix from v1.3.10 never took effect on his iPhone PWA because he was still running pre-v1.3.10 code. The HTML response was missing `Cache-Control` entirely, so iOS WKWebView picked a heuristic max-age and kept serving the same cached `index.html` — `location.reload()` and `location.replace(?_v=…)` both got satisfied from cache. Hooks now set `Cache-Control: no-store, must-revalidate` on `text/html` responses (hashed `_app/immutable/*` assets are unaffected — they remain long-cacheable since the filename changes per build). The StatusBar stale-bundle toast also switched its handler from bare `location.reload()` to `location.replace(?_v=<sha>)` matching the cold-start guard, so users with currently-cached HTML can still recover via the toast. After this lands, one final close+reopen of the iPhone PWA picks up the no-store header; from then on, all future updates apply smoothly with no manual gesture. (#255)

## 1.3.10 — 2026-05-05

### Fixed

- **iOS TTS audio playback** — the speak button (per-message + auto-speak) returned audio chunks from the server but stayed silent on iOS PWA / Safari. Root cause: `AudioContext` was constructed AFTER `await fetch('/api/speak')`, so the user-gesture flag was already consumed by the time iOS WebKit decided whether to allow audio. Now the context is created + resumed synchronously at the top of `playSpeech`, before any await, and reused across the session (instead of close-and-recreate per call). Active source nodes are tracked in a Set so `stopSpeech` can cancel without closing the context. A per-run token guards the final-source `ended` listener so a stop()-induced ended dispatch can't reset the next utterance's state mid-play, and a post-fetch state check surfaces `blocked` if iOS auto-suspended the context between plays. Caught on canary verification of v1.3.9 by Rafael — affects every iOS user. (#254)

## 1.3.9 — 2026-05-05

### Added

- **Pipeline status v2** — sticky prompt anchor + persistent pipeline-status bar in the chat composer. Two-layer design: PromptAnchor handles ask_user / ask_secret prompts surfacing above the input, PipelineProgress shows DAG step state. Default-on; library consumers can opt out via `configure({ pipelineStatusV2: false })`. (#236, #240, #245)
- **`ask_user` from pipeline sub-agents** — pipeline steps can now invoke `ask_user` and `ask_secret`; the prompt routes back through the parent session's SSE stream tagged with the originating step. Autonomous runs continue to strip these tools at the validator. (#244)
- **`task_update` schedule fields** — `run_at` and `schedule` fields are now mutable, enabling rescheduling without delete-and-recreate ("verschiebe das auf in 10 minuten"). (#243)
- **`build_sha` in `/api/health`** — runtime-visible commit hash for deploy verification, image-tag rollouts, and stale-bundle detection. (#238)

### Changed

- **STT default lands transcripts in the input box** — voice transcription now defaults to review-then-send instead of auto-send. Users can flip the toggle in the status bar; setting persists. (#237)
- **Right sidebar (ContextPanel) hidden by default** while it's being reworked. Library consumers can opt in via `configure({ contextPanelEnabled: true })`. (#249)
- **Mic button always visible** regardless of input state or auto-send toggle. Voice is a primary capability and shouldn't disappear behind state. (#249)

### Fixed

- **Per-turn time injected into every user message** — agent now sees wallclock-accurate `[Now: <iso>; user local <local> <tz>]` instead of relying on the hour-truncated cached value, fixing the 2026-05-05 incident where "in 5 min" tasks landed in the past. Cache-safe (lives in user message, not system prefix). (#242, #246, #248)
- **Scheduled times present in user's local timezone** — agent reply renders "14:00 Uhr" (CEST) instead of "12:00 Uhr" (UTC) when user is in Europe/Zurich. Tool inputs (`run_at`, `schedule`) stay UTC-encoded; the disambiguation is now spelled out in the system prompt with a worked example. (#246, #248)
- **Stale-bundle recovery for warm tabs and PWA cold-start** — StatusBar toast fires when the bundle's baked SHA differs from `/api/health.build_sha` (catches same-version different-build deploys). Inline `<script>` in `app.html` runs before any chunk loads to recover iOS PWA cold-starts whose cached chunks 404 against the new server. (#251, #252)
- **Per-turn time marker no longer leaks into rendered chat bubbles** — the `[Now: ...]` context for the LLM was visible verbatim in the user's message bubble after thread replay. Stripped at render time; voice messages also regain their mic-icon visualisation. (#250)
- **STT mic stayed hidden when text was in the input + auto-send off** — the symmetric case to PR #241 (which fixed auto-send-on with text). Drop the per-mode gate entirely. (#249)
- **Vite envPrefix widened to `PUBLIC_*`** — `import.meta.env.PUBLIC_*` was silently undefined, breaking the canary flag. (#239)
- **Generic placeholders for IMAP account id + display name** — the form previously hardcoded "rafael-gmail" / "Rafael — Gmail" for every tenant. Now reads "my-gmail" / "My Gmail". (#247)
- **Haiku no longer requested with extended thinking** — model rejects both manual and adaptive thinking modes; force-disabled regardless of caller config. (#231)
- **Image upload capped at Anthropic's 5 MB vision limit** — the base64 payload itself, not the decoded bytes. Returns a typed 413 with a friendly message instead of the raw provider 400. (#230)
- **Orchestrator phase computation guard** — protects against malformed persisted manifests that would otherwise hang in `computePhases`. (#229)
- **Agent message preserved on abort** — user message no longer lost from history when an agent run is aborted mid-stream. (PR carry-over from #228)

### Pro / Managed

- **Fleet rollout hardening** — sequential rollouts (`BATCH_SIZE=1`) by default, warmup gate refuses fleet rollouts within 60 s of CP restart, rollout health check verifies version match (not just HTTP 200), and non-semver `:staging` rollouts compare against `build_sha` instead of mismatching the version-string check. (#90, #91, #92, #94)

<!-- Reference — raw commits since v1.3.8 (delete this block before saving):

Core (in PR order):
- feat(web-ui): persistent pipeline status + sticky prompt anchor (#236)
- feat(web-ui): land STT transcript in input box, not auto-send (#237)
- feat(engine): expose build_sha in /api/health for rollout verification (#238)
- fix(web-ui): widen Vite envPrefix to include PUBLIC_* (#239)
- refactor(web-ui): drop PipelineStatusBar — two-layer design (#240)
- fix(web-ui): keep STT mic available with text in input when auto-send is on (#241)
- fix(core): inject precise current time per turn (cache-safe) (#242)
- feat(tools): task_update can reschedule via run_at + schedule (#243)
- feat(orchestrator): ask_user inside pipeline steps (#244)
- feat(web-ui): default pipeline-status-v2 on, retire canary plumbing (#245)
- fix(core): present scheduled times in user's local timezone, not UTC (#246)
- fix(web-ui): use generic placeholders for mail account id + display name (#247)
- fix(core): clarify storage=UTC vs display=local in time-aware prompts (#248)
- fix(web-ui): hide right sidebar by default + keep mic always visible (#249)
- fix(web-ui): strip per-turn [Now:…] marker from rendered chat bubbles (#250)
- fix(web-ui): toast on stale-bundle SHA mismatch, not just version (#251)
- fix(web-ui): cold-start stale-bundle guard for mobile PWA (#252)

Pro:
- fix(managed): rollout health check verifies version match, not just 200 (#90)
- fix(managed): default rollouts to sequential (BATCH_SIZE=1) (#91)
- fix(managed): refuse fleet rollouts when CP has been up <60s (warmup gate) (#92)
- fix(managed): verify build_sha for non-semver rollouts (#94)
-->

## 1.3.8 — 2026-05-01

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.7 (delete this block before saving):

Core:
- chore(deps): bump docker/build-push-action from 6 to 7 (#217)
- chore(deps): bump dependabot/fetch-metadata from 2 to 3 (#216)
- chore(deps): bump actions/github-script from 7 to 9 (#218)
- chore(deps): bump nodemailer and @types/nodemailer (#221)
- chore(deps): bump @huggingface/transformers from 3.8.1 to 4.2.0 (#220)
- chore(deps): bump email-reply-parser from 1.9.4 to 2.3.5 (#225)
- chore(deps): bump the minor-and-patch group with 6 updates (#219)
- chore(deps): bump @rolldown/binding-darwin-arm64 (#224)
- test(mail/triage): add real-world body-clean fixtures (#227)
- feat(bench): model + config benchmark suite + xhigh effort tier (#226)
- feat(web-ui): Usage Dashboard as Activity tab + status-bar link (#112)
- chore(deps): bump aquasecurity/trivy-action (#215)
- chore(deps): auto-merge non-major dependabot PRs (#214)
- chore(deps): bump marked from 17.0.5 to 18.0.2 (#33)
- chore(deps): bump docker/build-push-action from 6 to 7 (#31)
- chore(deps): bump pnpm/action-setup from 4 to 6 (#30)
- chore(deps): bump the minor-and-patch group across 1 directory with 21 updates (#161)
- chore(deps): bump aquasecurity/trivy-action from 0.35.0 to 0.36.0 (#194)
- feat(web-ui): manual compact button in context banner (#145)
- fix(web-ui): queued messages visible on mobile + per-item remove (#208)
- feat(web-ui): smart auto-scroll in ChatView (#207)
- fix(web-ui): harden markdown rendering against overflow + sloppy fences (#209)
- fix(web-ui): dynamic fence length for inline artifact chip wrap (#144)
- test: include packages/web-ui tests in root vitest run (#210)
- fix(tools/http): share one outbound-consent prompt across parallel calls (#146)
- fix(google-docs): drop redundant in-tool confirmation that hangs create (#206)
- fix(agent): preserve user message on abort to fix history loss (#205)
- fix(http-api): take over stale runs parked on pending prompts (#213)
- fix(web-ui): truncate long option labels in active prompt tab (#212)
- fix(web-ui): show question text in active prompt tab (#211)

Pro:
- chore(release): v1.3.7 (#88)
-->
## 1.3.7 — 2026-04-28

### Added

- **Spawn input validation** — `spawn_agent` now hard-caps caller-supplied values: max 10 agents per call, `max_turns` 1–50 (integer), `max_budget_usd` 0–50, `name` 1–64 chars (no control characters), `task` 1–16 K. JSON-schema mirrors the runtime checks; `additionalProperties: false` on the top level. Defensive floor in `estimateSpawnCost` so a malformed `max_turns` cannot return a negative estimate that would credit the session-budget counter (#198, #201).
- **Canary build CI** — Pushes to `feat/**`, `fix/**`, or `canary/**` publish two docker tags (`branch-<slug>` and `sha-<short>`) without ever touching a running instance. Pairs with managed-side canary pinning (lynox-pro #87) so a single instance can be held on a pre-release branch image while the fleet stays on `:latest` (#203).
- **GreenMail adversarial mailbox fixtures** — broadens mail integration coverage for malformed/edge-case messages (#192).

### Changed

- **Realistic spawn cost estimate** — `estimateSpawnCost` now models output as `OUTPUT_FILL_RATIO (0.3) × model.maxOutput` per turn (was naive worst-case ×1.0), and the default per-spawn iteration cap drops from 20 to 10. A typical 3-Sonnet-researcher fan-out estimates ≈ $2.52 instead of $15+, so legitimate patterns no longer trip the session ceiling (#197).
- **Mail tool hardening** — per-tool rate limits + per-recipient dedup in send paths (#188); persisted default mailbox is preserved when its provider fails to load (#187); Gmail OAuth watcher tightens cursor + provider lifecycle (#185); body decoder accepts more charsets (#189); address-list parser hardened with documented flag semantics (#191).
- **Google Workspace auth** — service-account token cache (#184) + coalesced concurrent refreshes (#182) — fewer round-trips on bursty access patterns.
- **Engine HTTP secret always set** — startup now ensures `LYNOX_HTTP_SECRET` is materialised before any handler comes up, eliminating the rare "secret missing" failure mode (#190).
- **Recoverable tool errors stay inline** — a tool error that the agent can retry no longer fires the global toast; it lives where it happened, in the chat thread (#195).
- **Spawn estimator + iteration cap as named constants** — `SPAWN_OUTPUT_FILL_RATIO`, `DEFAULT_SPAWN_MAX_TURNS`, single source of truth so the upfront estimator and runtime cap can never drift (#197, #202).

### Fixed

- **KG entity misclassification** — single-source-of-truth stopwords + a v2 post-filter at extraction time reject generic nouns and price expressions that the v1 regex+free-text pipeline was persisting; eval on 300 cases at 97.7 % precision / 94.6 % recall (#193).
- **Gmail envelope batching** — fewer Gmail API calls on first-page render via metadata batch fetch (#186).
- **GitHub Deployments tracking restored** — `release.yml` records a Deployment object after the pro-dispatch succeeds; the Deployments page froze at v1.3.3 after #142 dropped the production environment gate, this puts the visual record back without re-introducing a blocking reviewer step (#196).

### Internal

- Spawn JSDocs trimmed (no incident anecdotes); 3-researcher estimate test tightened to a narrow band around the documented expectation; `OUTPUT_FILL_RATIO` renamed `SPAWN_OUTPUT_FILL_RATIO` for prefix consistency (#201, #202).
- `.gitignore`: bench-models results excluded (#183).

### Managed (separate repo)

- **Per-instance canary pinning** — `pinned_tag` column on managed instances; fleet rollout (`startRollout`) skips pinned instances and records the skipped set on the rollout row for audit; new `PATCH /admin/instances/:id/pinned-tag` endpoint to set or clear the pin; `updateOne` refuses to deploy when the new tag would diverge from an existing pin, forcing the operator to update the pin first. End-to-end-validated on staging control plane.
- `pnpm/action-setup` bumped 4 → 6 to fix transient CI.

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
- **Managed-hosting compose file** bind-mounts SSH keys from a
  fixed host path instead of a named Docker volume. A named volume
  could come up empty after `up --build`, sending the control plane
  into a crash loop (2026-04-21 incident).

### Migration notes

- **Schema v28** (RunHistory): `ALTER TABLE runs ADD COLUMN kind
  TEXT; ALTER TABLE runs ADD COLUMN units INTEGER NOT NULL
  DEFAULT 0`. Idempotent, back-compat — pre-v28 rows read as
  `kind=null` which aggregates as `llm`.
- **Managed control-plane compose**: the first rebuild after
  this version bumps the SSH-keys mount to a bind-mount. Operators
  must confirm the managed host's ssh-keys directory has
  `id_ed25519` (0600, uid 1000) + `id_ed25519.pub` (0644, uid
  1000) before the first `docker compose up -d --build managed`.
  The old named SSH-keys volume becomes orphaned
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
