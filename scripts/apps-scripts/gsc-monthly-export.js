/**
 * lynox Ads Optimizer — Google Search Console monthly export
 * ==========================================================
 * Customer-deployed Google Apps Script that writes one GSC monthly snapshot
 * (previous calendar month) to Google Drive. Files accumulate in the
 * <root>/<account>/gsc/ subfolder; lynox reads all months that exist there
 * and ingests them into gsc_observations.
 *
 * Note: GSC has a 2-3 day data delay. Run on the 5th of each month so the
 * previous month is fully populated.
 *
 * Setup:
 *   1. Create a new Apps Script project at script.google.com
 *   2. Services → Add a service → Google Search Console API (enable)
 *   3. Paste this file
 *   4. Set DRIVE_ROOT_FOLDER_ID, ACCOUNT_LABEL, SITE_URL below
 *   5. "Deploy" → "Test deployments" → "Run main" once to authorize
 *   6. Triggers → Add → main → Time-driven → Month timer
 *
 * SITE_URL must match a verified Search Console property exactly. For
 * domain properties use "sc-domain:example.com"; for URL-prefix properties
 * use the full URL (https://example.com/).
 *
 * Output: <root>/<account>/gsc/gsc_YYYY-MM.csv
 *
 * Format: snake_case headers, decimal CTR (0.05 = 5%), float position.
 * License: ELv2.
 */

// ─── Configuration ───────────────────────────────────────────
var DRIVE_ROOT_FOLDER_ID = 'YOUR_DRIVE_ROOT_FOLDER_ID';
var ACCOUNT_LABEL = 'YOUR_ACCOUNT_LABEL';
var SITE_URL = 'https://example.com/';

var ROW_LIMIT = 5000;

function main() {
  var rootFolder = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);
  var accountFolder = ensureSubfolder(rootFolder, ACCOUNT_LABEL);
  var gscFolder = ensureSubfolder(accountFolder, 'gsc');

  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var exportMonth = month === 0 ? 12 : month;
  var exportYear = month === 0 ? year - 1 : year;
  var startDate = exportYear + '-' + pad2_(exportMonth) + '-01';
  var lastDay = new Date(exportYear, exportMonth, 0).getDate();
  var endDate = exportYear + '-' + pad2_(exportMonth) + '-' + pad2_(lastDay);
  var monthStr = exportYear + '-' + pad2_(exportMonth);

  var allRows = [];
  var startRow = 0;
  while (true) {
    var resp = SearchConsole.Searchanalytics.query({
      startDate: startDate,
      endDate: endDate,
      dimensions: ['query', 'page', 'country', 'device'],
      rowLimit: ROW_LIMIT,
      startRow: startRow,
    }, SITE_URL);
    if (!resp.rows || resp.rows.length === 0) break;
    resp.rows.forEach(function (r) {
      allRows.push({
        query: r.keys[0],
        page: r.keys[1],
        country: r.keys[2],
        device: r.keys[3],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      });
    });
    startRow += ROW_LIMIT;
    if (resp.rows.length < ROW_LIMIT) break;
  }

  var headers = ['date_month', 'query', 'page', 'country', 'device',
    'clicks', 'impressions', 'ctr', 'position'];
  var lines = [headers.join(',')];
  allRows.forEach(function (r) {
    lines.push([
      monthStr,
      csvStr_(r.query),
      csvStr_(r.page),
      r.country,
      r.device,
      r.clicks,
      r.impressions,
      r.ctr.toFixed(4),
      r.position.toFixed(2),
    ].join(','));
  });
  var csv = lines.join('\n') + '\n';

  var filename = 'gsc_' + monthStr + '.csv';
  writeFile_(gscFolder, filename, csv);
  Logger.log('Exported ' + filename + ' (' + allRows.length + ' rows)');
}

// ─── Helpers ──────────────────────────────────────────────────

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function csvStr_(s) {
  if (s === null || s === undefined) return '""';
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function ensureSubfolder(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

function writeFile_(folder, filename, content) {
  var existing = folder.getFilesByName(filename);
  while (existing.hasNext()) existing.next().setTrashed(true);
  folder.createFile(filename, content, MimeType.CSV);
}
