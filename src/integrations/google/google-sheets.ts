import type { ToolEntry, IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { SCOPES } from './google-auth.js';
import { getErrorMessage } from '../../core/utils.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';

// === Types ===

interface SheetsInput {
  action: 'read' | 'write' | 'append' | 'create' | 'list' | 'format';
  spreadsheet_id?: string | undefined;
  range?: string | undefined;
  values?: unknown[][] | undefined;
  title?: string | undefined;
  sheet_names?: string[] | undefined;
  format_requests?: unknown[] | undefined;
}

interface SheetValuesResponse {
  range: string;
  majorDimension: string;
  values?: string[][];
}

interface SpreadsheetResponse {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties: { title: string };
  sheets?: Array<{ properties: { title: string; sheetId: number } }>;
}

interface DriveFileListResponse {
  files?: Array<{ id: string; name: string; modifiedTime: string; webViewLink: string }>;
}

// === Constants ===

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES_BASE = 'https://www.googleapis.com/drive/v3/files';

const CONFIRM_ACTIONS = new Set(['write', 'append']);
const WRITE_ACTIONS = new Set(['write', 'append', 'create', 'format']);

// === Helpers ===

async function sheetsFetch(auth: GoogleAuth, url: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(30_000),
  });
  return response;
}

function valuesToMarkdownTable(values: string[][]): string {
  if (values.length === 0) return '(Empty range)';

  // First row as header
  const header = values[0]!;
  const rows = values.slice(1);

  // Calculate column widths
  const widths = header.map((h, i) => {
    const colValues = [h, ...rows.map(r => r[i] ?? '')];
    return Math.max(...colValues.map(v => v.length), 3);
  });

  const headerLine = '| ' + header.map((h, i) => h.padEnd(widths[i]!)).join(' | ') + ' |';
  const separatorLine = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const dataLines = rows.map(row =>
    '| ' + header.map((_, i) => (row[i] ?? '').padEnd(widths[i]!)).join(' | ') + ' |'
  );

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

// === Tool Creation ===

export function createSheetsTool(auth: GoogleAuth): ToolEntry<SheetsInput> {
  return {
    definition: {
      name: 'google_sheets',
      description: 'Interact with Google Sheets: read data as markdown table, write/overwrite ranges (requires confirmation), append rows, create new spreadsheets, list spreadsheets, apply formatting. Use action "read" with spreadsheet_id and range (A1 notation), "write" to overwrite a range with values, "append" to add rows after existing data, "create" with title and optional sheet_names, "list" to find spreadsheets, "format" with batchUpdate requests.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'append', 'create', 'list', 'format'],
            description: 'Sheets action to perform',
          },
          spreadsheet_id: {
            type: 'string',
            description: 'Spreadsheet ID (from URL). Required for: read, write, append, format',
          },
          range: {
            type: 'string',
            description: 'Cell range in A1 notation, e.g. "Sheet1!A1:D10" or "A1:Z". Required for: read, write, append',
          },
          values: {
            type: 'array',
            items: { type: 'array', items: {} },
            description: 'Array of row arrays. Required for: write, append. Example: [["Name","Age"],["Alice",30]]',
          },
          title: {
            type: 'string',
            description: 'Spreadsheet title (for action: create)',
          },
          sheet_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sheet tab names (for action: create). Default: ["Sheet1"]',
          },
          format_requests: {
            type: 'array',
            items: { type: 'object' },
            description: 'BatchUpdate requests for formatting (action: format). See Google Sheets API batchUpdate docs.',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: SheetsInput, agent: IAgent): Promise<string> => {
      try {
        // Check write scope
        if (WRITE_ACTIONS.has(input.action) && !auth.hasScope(SCOPES.SHEETS)) {
          return `Error: This action requires write permissions (${SCOPES.SHEETS}). Run /google auth to grant access.`;
        }

        // Confirmation for destructive actions — fail-safe: block if no prompt available
        if (CONFIRM_ACTIONS.has(input.action) && !agent.promptUser) {
          return `Error: "${input.action}" requires user confirmation but no interactive prompt is available (autonomous/background mode). Use assistant mode for this action.`;
        }
        if (CONFIRM_ACTIONS.has(input.action) && agent.promptUser) {
          const confirmMsg = `Overwrite range "${input.range ?? '(unspecified)'}" in spreadsheet ${input.spreadsheet_id ?? '(unknown)'}? This will replace existing data.`;
          const answer = await agent.promptUser(confirmMsg, ['Yes', 'No']);
          if (answer.toLowerCase() !== 'yes' && answer !== '1') {
            return 'Action cancelled by user.';
          }
        }

        switch (input.action) {
          case 'read': return await handleRead(auth, input);
          case 'write': return await handleWrite(auth, input);
          case 'append': return await handleAppend(auth, input);
          case 'create': return await handleCreate(auth, input);
          case 'list': return await handleList(auth);
          case 'format': return await handleFormat(auth, input);
          default: return `Error: Unknown action "${input.action}". Valid: read, write, append, create, list, format.`;
        }
      } catch (err: unknown) {
        return `Sheets error: ${getErrorMessage(err)}`;
      }
    },
  };
}

// === Action Handlers ===

async function handleRead(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "read".';
  if (!input.range) return 'Error: "range" is required for action "read".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}/values/${encodeURIComponent(input.range)}`;
  const response = await sheetsFetch(auth, url);

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to read range (${response.status}): ${text}`;
  }

  const data = await response.json() as SheetValuesResponse;
  if (!data.values || data.values.length === 0) {
    return `Range "${data.range}" is empty.`;
  }

  const table = valuesToMarkdownTable(data.values);
  const rowCount = data.values.length - 1; // Subtract header
  const result = `**${data.range}** (${rowCount} data rows)\n\n${table}`;
  // Wrap as untrusted — cell values are attacker-controlled if spreadsheet is shared
  return wrapUntrustedData(result, 'google_sheets:read');
}

async function handleWrite(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "write".';
  if (!input.range) return 'Error: "range" is required for action "write".';
  if (!input.values || input.values.length === 0) return 'Error: "values" is required for action "write".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}/values/${encodeURIComponent(input.range)}?valueInputOption=USER_ENTERED`;
  const response = await sheetsFetch(auth, url, {
    method: 'PUT',
    body: JSON.stringify({
      range: input.range,
      majorDimension: 'ROWS',
      values: input.values,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to write data (${response.status}): ${text}`;
  }

  const result = await response.json() as { updatedRange: string; updatedRows: number; updatedColumns: number; updatedCells: number };
  return `Data written successfully.\nRange: ${result.updatedRange}\nRows: ${result.updatedRows}, Columns: ${result.updatedColumns}, Cells: ${result.updatedCells}`;
}

async function handleAppend(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "append".';
  if (!input.range) return 'Error: "range" is required for action "append".';
  if (!input.values || input.values.length === 0) return 'Error: "values" is required for action "append".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}/values/${encodeURIComponent(input.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await sheetsFetch(auth, url, {
    method: 'POST',
    body: JSON.stringify({
      range: input.range,
      majorDimension: 'ROWS',
      values: input.values,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to append data (${response.status}): ${text}`;
  }

  const result = await response.json() as { updates: { updatedRange: string; updatedRows: number; updatedCells: number } };
  return `Data appended successfully.\nRange: ${result.updates.updatedRange}\nRows added: ${result.updates.updatedRows}`;
}

async function handleCreate(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  const title = input.title ?? 'New Spreadsheet';
  const sheetNames = input.sheet_names ?? ['Sheet1'];

  const response = await sheetsFetch(auth, SHEETS_BASE, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: sheetNames.map(name => ({
        properties: { title: name },
      })),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to create spreadsheet (${response.status}): ${text}`;
  }

  const result = await response.json() as SpreadsheetResponse;
  return `Spreadsheet created.\nTitle: ${result.properties.title}\nID: ${result.spreadsheetId}\nURL: ${result.spreadsheetUrl}`;
}

async function handleList(auth: GoogleAuth): Promise<string> {
  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet'",
    fields: 'files(id,name,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '20',
  });

  const response = await sheetsFetch(auth, `${DRIVE_FILES_BASE}?${params}`);
  if (!response.ok) {
    return `Error: Failed to list spreadsheets (${response.status}).`;
  }

  const data = await response.json() as DriveFileListResponse;
  if (!data.files || data.files.length === 0) {
    return 'No spreadsheets found.';
  }

  const lines = data.files.map(f =>
    `- **${f.name}**\n  ID: ${f.id}\n  Modified: ${f.modifiedTime.slice(0, 10)}\n  URL: ${f.webViewLink}`
  );

  return `Spreadsheets (${data.files.length}):\n\n${lines.join('\n\n')}`;
}

async function handleFormat(auth: GoogleAuth, input: SheetsInput): Promise<string> {
  if (!input.spreadsheet_id) return 'Error: "spreadsheet_id" is required for action "format".';
  if (!input.format_requests || input.format_requests.length === 0) return 'Error: "format_requests" is required for action "format".';

  const url = `${SHEETS_BASE}/${input.spreadsheet_id}:batchUpdate`;
  const response = await sheetsFetch(auth, url, {
    method: 'POST',
    body: JSON.stringify({ requests: input.format_requests }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to apply formatting (${response.status}): ${text}`;
  }

  const result = await response.json() as { replies: unknown[] };
  return `Formatting applied. ${result.replies.length} operations completed.`;
}
