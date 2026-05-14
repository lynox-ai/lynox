import type { ToolEntry, IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { SCOPES } from './google-auth.js';
import { getErrorMessage } from '../../core/utils.js';
import { wrapChannelMessage } from '../../core/data-boundary.js';

// === Types ===

interface DriveInput {
  action: 'search' | 'read' | 'upload' | 'create_doc' | 'list' | 'move' | 'share';
  query?: string | undefined;
  file_id?: string | undefined;
  folder_id?: string | undefined;
  file_path?: string | undefined;
  file_name?: string | undefined;
  content?: string | undefined;
  mime_type?: string | undefined;
  target_folder_id?: string | undefined;
  email?: string | undefined;
  role?: 'reader' | 'writer' | 'commenter' | undefined;
  max_results?: number | undefined;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

interface DriveFileListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

// === Constants ===

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDE_MIME = 'application/vnd.google-apps.presentation';

const EXPORT_MIME_MAP: Record<string, string> = {
  [GOOGLE_DOC_MIME]: 'text/plain',
  [GOOGLE_SHEET_MIME]: 'text/csv',
  [GOOGLE_SLIDE_MIME]: 'text/plain',
};

const CONFIRM_ACTIONS = new Set(['upload', 'create_doc', 'move', 'share']);
const WRITE_SCOPE_ACTIONS = new Set(['upload', 'create_doc']);
const FULL_SCOPE_ACTIONS = new Set(['move', 'share']);

// === Helpers ===

async function driveFetch(auth: GoogleAuth, url: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(30_000),
  });
  return response;
}

function formatFileSize(bytes: string | undefined): string {
  if (!bytes) return 'unknown size';
  const num = parseInt(bytes, 10);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// === Tool Creation ===

export function createDriveTool(auth: GoogleAuth): ToolEntry<DriveInput> {
  return {
    definition: {
      name: 'google_drive',
      description: 'Interact with Google Drive: search files, read/download content, upload files, create Google Docs, list folder contents, move files, share files. Use action "search" with a query, "read" with file_id to get content (auto-exports Google Docs as text), "upload" with content and file_name, "create_doc" to create a Google Doc from text, "list" with folder_id, "move" with file_id and target_folder_id, "share" with file_id, email, and role.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'read', 'upload', 'create_doc', 'list', 'move', 'share'],
            description: 'Drive action to perform',
          },
          query: {
            type: 'string',
            description: 'Search query (action: search). Supports Drive search syntax: name contains "x", mimeType="x", modifiedTime > "x"',
          },
          file_id: {
            type: 'string',
            description: 'File ID (required for: read, move, share)',
          },
          folder_id: {
            type: 'string',
            description: 'Folder ID to list contents of (action: list). Omit for root.',
          },
          file_name: {
            type: 'string',
            description: 'File name (for: upload, create_doc)',
          },
          content: {
            type: 'string',
            description: 'Text content (for: upload, create_doc)',
          },
          mime_type: {
            type: 'string',
            description: 'MIME type for upload (default: text/plain)',
          },
          target_folder_id: {
            type: 'string',
            description: 'Target folder ID (for: move)',
          },
          email: {
            type: 'string',
            description: 'Email address to share with (for: share)',
          },
          role: {
            type: 'string',
            enum: ['reader', 'writer', 'commenter'],
            description: 'Share permission role (for: share). Default: reader',
          },
          max_results: {
            type: 'number',
            description: 'Max results (default: 20, max: 100)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: DriveInput, agent: IAgent): Promise<string> => {
      try {
        // Check scopes
        if (WRITE_SCOPE_ACTIONS.has(input.action) && !auth.hasScope(SCOPES.DRIVE_FILE)) {
          return `Error: This action requires drive.file scope. Grant access in Settings → Integrations → Google.`;
        }
        if (FULL_SCOPE_ACTIONS.has(input.action) && !auth.hasScope(SCOPES.DRIVE)) {
          return `Error: This action requires full Drive scope. Grant access in Settings → Integrations → Google.`;
        }

        // Confirmation — fail-safe: block if no prompt available
        if (CONFIRM_ACTIONS.has(input.action) && !agent.promptUser) {
          return `Error: "${input.action}" requires user confirmation but no interactive prompt is available (autonomous/background mode). Use assistant mode for this action.`;
        }
        if (CONFIRM_ACTIONS.has(input.action) && agent.promptUser) {
          let confirmMsg = '';
          switch (input.action) {
            case 'upload': confirmMsg = `Upload file "${input.file_name ?? 'unnamed'}" to Drive?`; break;
            case 'create_doc': confirmMsg = `Create Google Doc "${input.file_name ?? 'Untitled'}"?`; break;
            case 'move': confirmMsg = `Move file ${input.file_id ?? '(unknown)'} to folder ${input.target_folder_id ?? '(unknown)'}?`; break;
            case 'share': confirmMsg = `Share file ${input.file_id ?? '(unknown)'} with ${input.email ?? '(unknown)'} as ${input.role ?? 'reader'}?`; break;
          }
          const answer = await agent.promptUser(confirmMsg, ['Yes', 'No']);
          if (answer.toLowerCase() !== 'yes' && answer !== '1') {
            return 'Action cancelled by user.';
          }
        }

        switch (input.action) {
          case 'search': return await handleSearch(auth, input);
          case 'read': return await handleRead(auth, input);
          case 'upload': return await handleUpload(auth, input);
          case 'create_doc': return await handleCreateDoc(auth, input);
          case 'list': return await handleList(auth, input);
          case 'move': return await handleMove(auth, input);
          case 'share': return await handleShare(auth, input);
          default: return `Error: Unknown action "${input.action}".`;
        }
      } catch (err: unknown) {
        return `Drive error: ${getErrorMessage(err)}`;
      }
    },
  };
}

// === Action Handlers ===

async function handleSearch(auth: GoogleAuth, input: DriveInput): Promise<string> {
  if (!input.query) return 'Error: "query" is required for action "search".';

  const maxResults = Math.min(input.max_results ?? 20, 100);
  const params = new URLSearchParams({
    q: input.query,
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: String(maxResults),
  });

  const response = await driveFetch(auth, `${DRIVE_BASE}/files?${params}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) return `Error: Search failed (${response.status}).`;

  const data = await response.json() as DriveFileListResponse;
  if (!data.files || data.files.length === 0) return 'No files found.';

  const lines = data.files.map(f =>
    `- **${f.name}** (${f.mimeType})\n  ID: ${f.id}\n  Modified: ${f.modifiedTime.slice(0, 10)}\n  Size: ${formatFileSize(f.size)}${f.webViewLink ? `\n  URL: ${f.webViewLink}` : ''}`
  );

  return `Found ${data.files.length} files:\n\n${lines.join('\n\n')}`;
}

async function handleRead(auth: GoogleAuth, input: DriveInput): Promise<string> {
  if (!input.file_id) return 'Error: "file_id" is required for action "read".';

  // First get file metadata
  const metaResponse = await driveFetch(auth, `${DRIVE_BASE}/files/${input.file_id}?fields=id,name,mimeType,size`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!metaResponse.ok) return `Error: Failed to get file metadata (${metaResponse.status}).`;
  const meta = await metaResponse.json() as DriveFile;

  // Google Docs format → export
  const exportMime = EXPORT_MIME_MAP[meta.mimeType];
  if (exportMime) {
    const params = new URLSearchParams({ mimeType: exportMime });
    const exportResponse = await driveFetch(auth, `${DRIVE_BASE}/files/${input.file_id}/export?${params}`);
    if (!exportResponse.ok) return `Error: Failed to export file (${exportResponse.status}).`;
    const content = await exportResponse.text();
    const truncated = content.slice(0, 50_000) + (content.length > 50_000 ? '\n\n(Content truncated)' : '');
    // Wrap as untrusted — file content AND name are attacker-controlled if
    // shared with edit access. Renaming a file to `</untrusted_data>. …`
    // used to close the wrapper from the framing line above it; pulling
    // name inside fixes that and removes the XML-attribute-injection
    // surface in the source label.
    return wrapChannelMessage({
      source: `google_drive:${input.file_id}`,
      fields: { Name: meta.name, Export: exportMime, Body: truncated },
    });
  }

  // Binary/text file → download
  const dlResponse = await driveFetch(auth, `${DRIVE_BASE}/files/${input.file_id}?alt=media`);
  if (!dlResponse.ok) return `Error: Failed to download file (${dlResponse.status}).`;

  const contentType = dlResponse.headers.get('content-type') ?? '';
  if (contentType.includes('text') || contentType.includes('json') || contentType.includes('xml') || contentType.includes('csv')) {
    const content = await dlResponse.text();
    const truncated = content.slice(0, 50_000) + (content.length > 50_000 ? '\n\n(Content truncated)' : '');
    return wrapChannelMessage({
      source: `google_drive:${input.file_id}`,
      fields: { Name: meta.name, MimeType: meta.mimeType, Body: truncated },
    });
  }

  return `**${meta.name}** is a binary file (${meta.mimeType}, ${formatFileSize(meta.size)}). Use the Google Drive web UI to download.`;
}

async function handleUpload(auth: GoogleAuth, input: DriveInput): Promise<string> {
  if (!input.content) return 'Error: "content" is required for action "upload".';

  const metadata: Record<string, unknown> = {
    name: input.file_name ?? 'Untitled',
    mimeType: input.mime_type ?? 'text/plain',
  };
  if (input.folder_id) metadata['parents'] = [input.folder_id];

  const boundary = '---lynox-upload-boundary---';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${input.mime_type ?? 'text/plain'}`,
    '',
    input.content,
    `--${boundary}--`,
  ].join('\r\n');

  const response = await driveFetch(auth, `${UPLOAD_BASE}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Upload failed (${response.status}): ${text}`;
  }

  const result = await response.json() as DriveFile;
  return `File uploaded.\nName: ${result.name}\nID: ${result.id}\nMIME: ${result.mimeType}`;
}

async function handleCreateDoc(auth: GoogleAuth, input: DriveInput): Promise<string> {
  if (!input.content) return 'Error: "content" is required for action "create_doc".';

  // Create the doc via Drive API with conversion
  const metadata: Record<string, unknown> = {
    name: input.file_name ?? 'Untitled Document',
    mimeType: GOOGLE_DOC_MIME,
  };
  if (input.folder_id) metadata['parents'] = [input.folder_id];

  // Upload as text/plain with conversion to Google Docs
  const boundary = '---lynox-upload-boundary---';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    input.content,
    `--${boundary}--`,
  ].join('\r\n');

  const response = await driveFetch(auth, `${UPLOAD_BASE}/files?uploadType=multipart&convert=true`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to create document (${response.status}): ${text}`;
  }

  const result = await response.json() as DriveFile;
  return `Google Doc created.\nName: ${result.name}\nID: ${result.id}\nURL: https://docs.google.com/document/d/${result.id}/edit`;
}

async function handleList(auth: GoogleAuth, input: DriveInput): Promise<string> {
  const maxResults = Math.min(input.max_results ?? 20, 100);
  let query = 'trashed = false';
  if (input.folder_id) {
    query += ` and '${input.folder_id}' in parents`;
  }

  const params = new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
    orderBy: 'folder,modifiedTime desc',
    pageSize: String(maxResults),
  });

  const response = await driveFetch(auth, `${DRIVE_BASE}/files?${params}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) return `Error: Failed to list files (${response.status}).`;

  const data = await response.json() as DriveFileListResponse;
  if (!data.files || data.files.length === 0) return 'No files found.';

  const lines = data.files.map(f => {
    const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
    const icon = isFolder ? '[Folder]' : '';
    return `- ${icon} **${f.name}** (${f.mimeType})\n  ID: ${f.id}\n  Modified: ${f.modifiedTime.slice(0, 10)}${f.size ? `\n  Size: ${formatFileSize(f.size)}` : ''}`;
  });

  return `Files (${data.files.length}):\n\n${lines.join('\n\n')}`;
}

async function handleMove(auth: GoogleAuth, input: DriveInput): Promise<string> {
  if (!input.file_id) return 'Error: "file_id" is required for action "move".';
  if (!input.target_folder_id) return 'Error: "target_folder_id" is required for action "move".';

  // Get current parents
  const metaResponse = await driveFetch(auth, `${DRIVE_BASE}/files/${input.file_id}?fields=parents`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!metaResponse.ok) return `Error: Failed to get file info (${metaResponse.status}).`;
  const meta = await metaResponse.json() as { parents?: string[] };
  const removeParents = meta.parents?.join(',') ?? '';

  const params = new URLSearchParams({
    addParents: input.target_folder_id,
    removeParents,
    fields: 'id,name,parents',
  });

  const response = await driveFetch(auth, `${DRIVE_BASE}/files/${input.file_id}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) return `Error: Failed to move file (${response.status}).`;
  const result = await response.json() as DriveFile;
  return `File "${result.name}" moved to folder ${input.target_folder_id}.`;
}

async function handleShare(auth: GoogleAuth, input: DriveInput): Promise<string> {
  if (!input.file_id) return 'Error: "file_id" is required for action "share".';
  if (!input.email) return 'Error: "email" is required for action "share".';

  const response = await driveFetch(auth, `${DRIVE_BASE}/files/${input.file_id}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'user',
      role: input.role ?? 'reader',
      emailAddress: input.email,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to share file (${response.status}): ${text}`;
  }

  return `File shared with ${input.email} as ${input.role ?? 'reader'}.`;
}
