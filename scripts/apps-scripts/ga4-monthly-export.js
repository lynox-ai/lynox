/**
 * lynox Ads Optimizer — GA4 monthly export
 * ========================================
 * Customer-deployed Google Apps Script that writes one GA4 monthly snapshot
 * (previous calendar month) to Google Drive. Files accumulate in the
 * <root>/<account>/ga4/ subfolder; lynox reads all months that exist there
 * and ingests them into ga4_observations.
 *
 * Setup:
 *   1. Create a new Apps Script project at script.google.com
 *   2. Services → Add a service → Google Analytics Data API (enable)
 *   3. Paste this file
 *   4. Set DRIVE_ROOT_FOLDER_ID, ACCOUNT_LABEL and GA4_PROPERTY_ID below
 *   5. "Deploy" → "Test deployments" → "Run main" once to authorize
 *   6. Triggers → Add → main → Time-driven → Month timer (e.g. 5th day of
 *      each month so the previous month's data is fully attributed)
 *
 * Output: <root>/<account>/ga4/ga4_YYYY-MM.csv (one file per month;
 *         re-running for the same month replaces the existing file).
 *
 * Format: snake_case headers, decimal CTR/bounce_rate, integer counts.
 * License: ELv2.
 */

// ─── Configuration ───────────────────────────────────────────
var DRIVE_ROOT_FOLDER_ID = 'YOUR_DRIVE_ROOT_FOLDER_ID';
var ACCOUNT_LABEL = 'YOUR_ACCOUNT_LABEL';
var GA4_PROPERTY_ID = 'YOUR_GA4_PROPERTY_ID';   // e.g. '123456789'

function main() {
  var rootFolder = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);
  var accountFolder = ensureSubfolder(rootFolder, ACCOUNT_LABEL);
  var ga4Folder = ensureSubfolder(accountFolder, 'ga4');

  // Previous calendar month.
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();             // 0-indexed
  var exportMonth = month === 0 ? 12 : month;
  var exportYear = month === 0 ? year - 1 : year;
  var startDate = exportYear + '-' + pad2_(exportMonth) + '-01';
  var lastDay = new Date(exportYear, exportMonth, 0).getDate();
  var endDate = exportYear + '-' + pad2_(exportMonth) + '-' + pad2_(lastDay);

  var request = AnalyticsData.newRunReportRequest();
  request.dateRanges = [AnalyticsData.newDateRange()];
  request.dateRanges[0].startDate = startDate;
  request.dateRanges[0].endDate = endDate;

  var dimNames = ['date', 'sessionSource', 'sessionMedium'];
  request.dimensions = dimNames.map(function (n) {
    var d = AnalyticsData.newDimension();
    d.name = n;
    return d;
  });

  // GA4 metric names. We expose them in snake_case to match the lynox schema.
  var metricNames = [
    { ga: 'sessions',                csv: 'sessions' },
    { ga: 'totalUsers',              csv: 'total_users' },
    { ga: 'newUsers',                csv: 'new_users' },
    { ga: 'bounceRate',              csv: 'bounce_rate' },
    { ga: 'averageSessionDuration',  csv: 'avg_session_duration' },
    { ga: 'conversions',             csv: 'conversions' },
    { ga: 'eventCount',              csv: 'event_count' },
  ];
  request.metrics = metricNames.map(function (m) {
    var met = AnalyticsData.newMetric();
    met.name = m.ga;
    return met;
  });
  request.limit = 100000;

  var response = AnalyticsData.Properties.runReport(request, 'properties/' + GA4_PROPERTY_ID);

  var headers = ['date', 'session_source', 'session_medium']
    .concat(metricNames.map(function (m) { return m.csv; }));
  var lines = [headers.join(',')];
  if (response.rows) {
    response.rows.forEach(function (row) {
      var dimValues = row.dimensionValues.map(function (v) { return csvStr_(v.value); });
      var metValues = row.metricValues.map(function (v) { return v.value; });
      lines.push(dimValues.concat(metValues).join(','));
    });
  }
  var csv = lines.join('\n') + '\n';

  var filename = 'ga4_' + exportYear + '-' + pad2_(exportMonth) + '.csv';
  writeFile_(ga4Folder, filename, csv);
  Logger.log('Exported ' + filename + ' (' + (response.rows ? response.rows.length : 0) + ' rows)');
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
