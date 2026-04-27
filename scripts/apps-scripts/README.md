# Apps Scripts for the lynox Ads Optimizer

This folder contains three customer-deployed Google Apps Scripts that produce
the data snapshot the lynox Ads Optimizer reads each cycle. The scripts run
**inside the customer's own Google account** and write CSV files to the
customer's own Google Drive. The lynox engine never calls Google Ads, GA4,
or Search Console APIs directly — it only reads the resulting Drive folder
through the customer's BYOK Google Workspace integration.

> **Beta notice.** The Ads Optimizer is gated by the `ads-optimizer` feature
> flag (default off) and is in closed beta. These scripts are provided as
> the customer-facing onboarding surface; the rest of the pipeline is
> under active development.

## What the scripts produce

```
<drive-root>/<account-label>/
├── ads/
│   ├── LASTRUN.txt              ISO-8601 timestamp of the most recent run
│   ├── campaigns.csv
│   ├── campaign_performance.csv
│   ├── ad_groups.csv
│   ├── keywords.csv
│   ├── ads_rsa.csv
│   ├── asset_groups.csv
│   ├── asset_group_assets.csv
│   ├── assets.csv
│   ├── listing_groups.csv
│   ├── shopping_products.csv
│   ├── conversions.csv
│   ├── campaign_targeting.csv
│   ├── search_terms.csv
│   ├── pmax_search_terms.csv
│   ├── pmax_placements.csv
│   ├── landing_pages.csv
│   ├── ad_asset_ratings.csv
│   ├── audience_signals.csv
│   ├── device_performance.csv
│   ├── geo_performance.csv
│   └── change_history.csv
├── ga4/
│   ├── ga4_2026-03.csv          one file per month, accumulating
│   └── ga4_2026-04.csv
└── gsc/
    ├── gsc_2026-03.csv
    └── gsc_2026-04.csv
```

All files use UTF-8 encoding, comma-separated values, snake_case headers,
costs in micros (1_000_000 = 1 unit of account currency), and CTR / share
metrics as decimals (`0.05` = 5%).

## Common conventions

| Field           | Value                                                |
|-----------------|------------------------------------------------------|
| `cost_micros`   | Integer micros. 12_500_000 = 12.5 CHF/EUR/USD       |
| `budget_micros` | Integer micros                                       |
| `avg_cpc`       | Integer micros                                       |
| `ctr`           | Decimal. `0.0125` = 1.25%                            |
| `search_is`     | Decimal. `0.85` = 85% impression share               |
| Empty cell      | Apps Scripts may emit `""`, `undefined`, or `null` — |
|                 | the lynox reader treats all three as absent (not 0)  |

## One-time setup

You'll need:

- A Google Drive folder you control (this is the **drive-root**)
- The Drive folder's ID (visible in the URL: `drive.google.com/drive/folders/<ID>`)
- A short label for the customer (snake_case, used as the subfolder name)
- For GA4: the property ID (`properties/<ID>` — just the number)
- For GSC: the verified property URL or `sc-domain:` identifier
- For Google Ads: nothing extra — the script runs inside the Google Ads UI

The label is also what you'll pass as the `account_label` when configuring
the lynox-side integration. Keep it stable; changing it later means lynox
can no longer cross-reference prior runs.

## 1. Google Ads — `google-ads-export.js`

This is the largest of the three scripts. It produces all 21 ads-related
CSVs in `<drive-root>/<account>/ads/` plus a `LASTRUN.txt` heartbeat.

1. Open Google Ads → **Tools → Bulk actions → Scripts → New script**
2. Paste the entire contents of `google-ads-export.js`
3. At the top of the file, set:
   ```js
   var DRIVE_ROOT_FOLDER_ID = 'paste-the-folder-id-here';
   var ACCOUNT_LABEL = 'acme-shop';   // your customer label
   ```
4. Click **Authorize** and grant Drive write permission to the script
5. Click **Run** once manually. First run can take several minutes for
   accounts with many campaigns; check the **Logs** panel for `OK <file>`
   lines and any `FAIL <file>` entries
6. Schedule a monthly trigger:
   - In the Scripts list, click the clock icon next to your script
   - Frequency: monthly, day of your choice (1st is fine; PMax data is
     stable enough to not require the 5th-of-month buffer that GSC needs)

### When a row fails inside an export

The script wraps every export in `safeExport_()`. If one CSV's GAQL query
fails (Google sometimes deprecates fields in newer versions), the script
**skips writing that file entirely** rather than producing a malformed
CSV. lynox treats the missing file as `status: missing` and continues —
no run-blocking error. Inspect the **Logs** to see which one and why.

### What happens on each run

The script overwrites the 21 ads CSVs in place every time. Drive trash
will hold the prior versions for 30 days if you need to recover one.
`LASTRUN.txt` is written **after all CSVs succeed**; a partial run leaves
LASTRUN.txt unchanged, so the lynox freshness check (≤14 days) correctly
flags partial / failed runs as stale.

## 2. Google Analytics 4 — `ga4-monthly-export.js`

Produces one CSV per calendar month under `<drive-root>/<account>/ga4/`.
Each run exports the **previous** month, so a trigger on the 1st of every
month captures everything from the prior month.

1. Open <https://script.google.com> → **New project**
2. Paste the contents of `ga4-monthly-export.js`
3. **Services** (left panel) → **Add a service** → **Google Analytics
   Data API** → Add
4. Set the three constants at the top: `DRIVE_ROOT_FOLDER_ID`,
   `ACCOUNT_LABEL`, `GA4_PROPERTY_ID` (just the number, no `properties/`
   prefix)
5. Click **Run main** once to authorize. Watch the execution log; you
   should see `Exported ga4_YYYY-MM.csv (N rows)`
6. **Triggers** → **Add Trigger** → function `main` → time-driven →
   month timer → 1st of month, 02:00–03:00

### Notes

- GA4 only exposes data going back from when you turned on the property,
  so the very first export may be sparse for new properties.
- The script writes 7 metrics: `sessions`, `total_users`, `new_users`,
  `bounce_rate`, `avg_session_duration`, `conversions`, `event_count`.
- `conversions` here is GA4-side conversion events. The lynox audit
  tool cross-references this against Google Ads conversions to flag
  attribution / tracking gaps (`view_blueprint_ga4_conversion_delta`).

## 3. Search Console — `gsc-monthly-export.js`

Produces one CSV per calendar month under `<drive-root>/<account>/gsc/`.
Same accumulation pattern as GA4.

1. Open <https://script.google.com> → **New project**
2. Paste the contents of `gsc-monthly-export.js`
3. **Services** → **Add a service** → **Google Search Console API** → Add
4. Set the three constants at the top:
   - `DRIVE_ROOT_FOLDER_ID`
   - `ACCOUNT_LABEL`
   - `SITE_URL` — must match a property in the Search Console exactly:
     - URL-prefix properties: `https://example.com/` (trailing slash)
     - Domain properties: `sc-domain:example.com`
5. **Run main** once to authorize
6. **Triggers** → time-driven → month timer → **5th of month** (GSC has a
   2–3 day data delay; running on the 1st gives you ~2 incomplete days)

### Notes

- Pagination is handled automatically up to 100k rows per month (4 pages
  of 5_000 × 5 dimensions). For very high-traffic sites you may exceed
  this and want to split by country in v2.
- The lynox audit tool uses GSC data primarily for the
  `view_blueprint_organic_overlap` view — finding queries that drive
  organic traffic to the site but are not covered by paid (potential
  PMax-disjunct negatives or new search-campaign opportunities).

## Verifying the setup end-to-end

After all three scripts have run at least once, your Drive folder should
look like the tree at the top of this README. To run the lynox cycle:

```bash
# in the customer's lynox instance, with feature flag enabled:
LYNOX_FEATURE_ADS_OPTIMIZER=1 lynox

# then in the chat:
> Pull and import the ads data from drive folder <folder-id>
> for ads account 123-456-7890.
```

The `ads_data_pull` tool will:

1. Find `ads/`, `ga4/`, `gsc/` subfolders under your folder
2. Read `ads/LASTRUN.txt` and verify it is ≤14 days old
3. Open a new audit run, ingest every CSV present, mark missing ones
   as `status: missing` (non-fatal)
4. Return a per-CSV summary with row counts and any warnings

If nothing has been written yet, the tool will fail with a clear message
identifying which subfolder or `LASTRUN.txt` is missing.

## Troubleshooting

| Symptom in the lynox tool output | Likely cause |
|----------------------------------|--------------|
| `no "ads" subfolder` | Drive folder ID points to the wrong folder, or the Google Ads script hasn't run yet |
| `no LASTRUN.txt` | Google Ads script ran but ALL 21 exports failed (check the Apps Script execution log) |
| `stale: LASTRUN.txt is N days old` | Re-run the Google Ads script. Pass `force=true` in the tool call to ignore the freshness gate |
| `<file>: Missing required column "X"` | A GAQL query in the script returned a different schema (e.g. Google deprecated a field). File a lynox issue with the column dump |
| Many `Unknown column "X" — ignored` warnings | New columns added to the export — informational only, the run still completes |

## License

These scripts are part of `@lynox-ai/core` and ship under the same
**Elastic License v2 (ELv2)** as the rest of the project. You may deploy
them in your own Google account, modify them for your own customer
deployments, and read the data they produce. You may not host them as a
managed service for third parties without an agreement with lynox.

## Data flow / privacy

These scripts do NOT send data anywhere except your own Google Drive.
The lynox engine reads the Drive contents only when the customer
explicitly invokes the `ads_data_pull` tool from their own lynox
instance. No data leaves the customer's Google Workspace tenant unless
the customer-side lynox engine is configured to talk to a remote LLM
provider (in which case the LLM sees only the **aggregated** views, not
raw rows — see `view_audit_*` and `view_blueprint_*` in the lynox
schema).
