/**
 * Ads Optimizer briefing — injected into the agent's system prompt
 * whenever the `ads-optimizer` feature flag is on. Tells the agent the
 * canonical cycle order, the role of each of the 10 tools, and the
 * Beta-only safety rules from the sprint plan.
 *
 * The briefing is intentionally short and operational. Tool-level
 * details live in each tool's `description` field; this is the
 * top-level orchestration map.
 */

const BRIEFING = `<ads_optimizer_cycle>
You have the Ads Optimizer toolset available. It runs a closed-loop
optimisation cycle on a single Google Ads account, defaulting to
monthly cadence (Smart-Bidding learning window).

Canonical cycle order:

  1. ads_customer_profile_set
     — First cycle ever for a customer: research the customer (web_search +
       http to read their site, memory_recall for prior context) and DERIVE
       every required field from data. Do NOT ask_user for these; the
       account already encodes them.
         * target_roas: read campaign.target_roas.target_roas or
           campaign.maximize_conversion_value.target_roas from campaigns.csv;
           if all campaigns use target_cpa, set primary_goal=cpa and use
           campaign.target_cpa.target_cpa_micros instead.
         * monthly_budget_chf (informational only): sum of
           campaign_budget.amount_micros / 1e6 across active campaigns × 30.4.
           Skip if the schema doesn't have a budget field; not load-bearing.
         * naming_convention_pattern: tokenize existing campaign_name values
           (split on '|', '-', '_'; ignore brand/language stopwords),
           identify the dominant ordered token-template, encode as e.g.
           "{LANG}-{CHANNEL}-{THEME}". If patterns conflict, pick the
           majority and flag others as RENAME candidates in P3.
         * pmax_owned_head_terms: take the top 30 by impression frequency
           from pmax_search_terms.csv, drop competitor and adjacent
           brand mentions, retain category/brand-owned terms. Cross-check
           against the customer site's nav categories (http on root URL).
         * competitors: web_search "<own_brand> alternative" plus the
           customer-site crawl's competitor mentions; recall from KG if
           prior cycles ran.
       Only ask_user if a load-bearing inference is genuinely ambiguous
       (e.g. two equally-likely naming patterns, or no PMAX search-terms
       data at all). Never ask for values the data already contains.
     — Subsequent cycles: skip unless a profile field needs updating.

  2. ads_data_pull
     — Reads the 22-CSV pack from the customer's Google Drive (written by
       the customer-deployed Apps Scripts). Validates the LASTRUN
       freshness; refuses if older than 14 days unless force=true.
     — Cycle 1: pass customer_id, ads_account_id (Google "123-456-7890"
       form), and drive_folder_id. This links the ads account to the
       customer profile.
     — Cycle 2+: only customer_id is required — ads_account_id and
       drive_folder_id auto-resolve from the previous run's link. Do not
       ask the user for these on subsequent cycles unless the auto-resolve
       fails (multiple linked accounts or missing drive_folder_id, both
       reported in the error).

  3. ads_audit_run
     — Deterministic phase. Computes KPIs, detects mode (BOOTSTRAP vs
       OPTIMIZE), summarises manual changes since the previous run, runs
       Wilson-score performance verification (cycle 2+), and writes
       deterministic findings to ads_findings.

  4. Qualitative research (interleaved with ads_finding_add)
     — Read the audit report, prioritise by HIGH-severity findings.
       For campaign_target_underperformance_roas / _cpa: those are the
       campaigns to focus on first.
     — For each priority: run DataForSEO via http_request (if a
       DataForSEO API profile is configured) for keyword research, crawl
       top landing pages via http to assess relevance, probe GA4-Ads
       conversion delta for tracking trust, etc.
     — Record each qualitative insight via ads_finding_add with a
       descriptive area, severity, and evidence-JSON.

  5. ads_blueprint_run
     — Deterministic phase. Reads the audit + findings + customer profile,
       generates KEEP/RENAME/PAUSE/NEW classifications per entity type,
       three-fold negative proposals, and naming-convention validation.

  6. ads_blueprint_entity_propose (per qualitative finding)
     — Use this to translate qualitative findings into concrete
       Editor-import-able entities: new RSAs, asset proposals for
       low-strength PMAX asset-groups, audience signals, sitelinks,
       callouts, validated PMAX SPLIT/MERGE.
     — Payload requirements per entity_type are listed in the tool
       description. campaign_name is auto-derived for asset and
       audience_signal proposals when only asset_group_name is given
       (the snapshot has the link). For callout/sitelink it auto-fills
       only when the account has a single campaign — otherwise pass it
       explicitly. On validation failure the tool returns the list of
       known campaign names from the run so you can choose.
     — PMAX SPLIT/MERGE require confidence ≥ 0.9, rationale ≥ 30 chars,
       and source asset-groups < 30 conv/30d (or matching high
       confidence + rationale). The tool runs the safeguards.

  7. ads_emit_csv
     — Idempotent: when nothing has changed since the last cycle's emit,
       reports "no changes" and writes nothing.
     — Pre-emit validators block hard errors (broken cross-references,
       overlong headlines, competitor trademarks in copy, non-HTTPS
       final URLs, RSAs below 5/2 minimum). Fix and re-call.
     — Output: per-campaign Editor CSV pack + account-negatives.csv,
       UTF-16 LE with BOM, in the workspace directory.

  8. Customer review + Editor import (manual step, off-tool)
     — Customer opens Google Ads Editor, "Account → Import → From file",
       reviews the proposed changes, posts the ones they accept.

  9. ads_mark_imported
     — Stamp the import timestamp so the next cycle's Smart-Bidding-Guard
       (14-day learning-window protection on PMAX restructure proposals)
       is anchored correctly.

Safety constraints (Beta-gated to brandfusion's own customers):
  - NEW entities default to Status=Paused. Nothing goes live until the
    customer reviews + posts in Editor.
  - PMAX restructure (SPLIT/MERGE) is only auto-promoted when the
    safeguards in evaluateRestructureSafeguards all pass.
  - When a HARD validator error blocks emit, do not work around it —
    fix the underlying entity payload (via revising agent proposals or
    customer profile) and re-run.

When the user asks for "an Ads Optimizer cycle", default to running
steps 1-7 in order. ask_user pauses are reserved for:
  - HIGH-severity findings the agent intends to act on,
  - the final blueprint summary before emit,
  - genuinely ambiguous profile fields (rare — most are derivable from
    the account data; see step 1).
Do NOT pause to ask for ROAS targets, budgets, naming patterns, head
terms, or competitor lists — derive these from the data per step 1.
</ads_optimizer_cycle>`;

export function getAdsOptimizerBriefing(): string {
  return BRIEFING;
}
