import type { ToolEntry, IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { SCOPES } from './google-auth.js';
import type { DocsDocument } from './google-docs-format.js';
import { docsToMarkdown, markdownToHtml } from './google-docs-format.js';
import { getErrorMessage } from '../../core/utils.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';

// === Types ===

interface DocsInput {
  action: 'read' | 'create' | 'append' | 'replace';
  document_id?: string | undefined;
  title?: string | undefined;
  content?: string | undefined;
  find?: string | undefined;
  replace_with?: string | undefined;
  replace_all?: boolean | undefined;
}

interface BatchUpdateResponse {
  documentId: string;
  replies: unknown[];
}

// === Constants ===

const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const CONFIRM_ACTIONS = new Set(['create', 'replace']);
const WRITE_ACTIONS = new Set(['create', 'append', 'replace']);

// === Helpers ===

async function docsFetch(auth: GoogleAuth, url: string, options?: RequestInit): Promise<Response> {
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

// === Tool Creation ===

export function createDocsTool(auth: GoogleAuth): ToolEntry<DocsInput> {
  return {
    definition: {
      name: 'google_docs',
      description: 'Interact with Google Docs: read documents as markdown, create new documents from markdown, append text to existing documents, find and replace text. Use action "read" with document_id, "create" with title and content (markdown), "append" with document_id and content, "replace" with document_id, find, and replace_with.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'create', 'append', 'replace'],
            description: 'Docs action to perform',
          },
          document_id: {
            type: 'string',
            description: 'Document ID (required for: read, append, replace)',
          },
          title: {
            type: 'string',
            description: 'Document title (for: create)',
          },
          content: {
            type: 'string',
            description: 'Markdown content (for: create, append)',
          },
          find: {
            type: 'string',
            description: 'Text to find (for: replace)',
          },
          replace_with: {
            type: 'string',
            description: 'Replacement text (for: replace)',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: true)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: DocsInput, agent: IAgent): Promise<string> => {
      try {
        // Check write scope
        if (WRITE_ACTIONS.has(input.action) && !auth.hasScope(SCOPES.DOCS)) {
          return `Error: This action requires document write permissions. Run /google auth to grant access.`;
        }

        // Confirmation — fail-safe: block if no prompt available
        if (CONFIRM_ACTIONS.has(input.action) && !agent.promptUser) {
          return `Error: "${input.action}" requires user confirmation but no interactive prompt is available (autonomous/background mode). Use assistant mode for this action.`;
        }
        if (CONFIRM_ACTIONS.has(input.action) && agent.promptUser) {
          let confirmMsg = '';
          if (input.action === 'create') {
            confirmMsg = `Create Google Doc "${input.title ?? 'Untitled'}"?`;
          } else if (input.action === 'replace') {
            confirmMsg = `Replace "${input.find ?? ''}" with "${input.replace_with ?? ''}" in document ${input.document_id ?? '(unknown)'}?`;
          }
          const answer = await agent.promptUser(confirmMsg, ['Yes', 'No']);
          if (answer.toLowerCase() !== 'yes' && answer !== '1') {
            return 'Action cancelled by user.';
          }
        }

        switch (input.action) {
          case 'read': return await handleRead(auth, input);
          case 'create': return await handleCreate(auth, input);
          case 'append': return await handleAppend(auth, input);
          case 'replace': return await handleReplace(auth, input);
          default: return `Error: Unknown action "${input.action}".`;
        }
      } catch (err: unknown) {
        return `Docs error: ${getErrorMessage(err)}`;
      }
    },
  };
}

// === Action Handlers ===

async function handleRead(auth: GoogleAuth, input: DocsInput): Promise<string> {
  if (!input.document_id) return 'Error: "document_id" is required for action "read".';

  const response = await docsFetch(auth, `${DOCS_BASE}/${input.document_id}`);
  if (!response.ok) {
    return `Error: Failed to read document (${response.status}).`;
  }

  const doc = await response.json() as DocsDocument;
  const markdown = docsToMarkdown(doc);

  // Wrap as untrusted — document content is attacker-controlled if shared
  return `**${doc.title}**\nDocument ID: ${doc.documentId}\n\n${wrapUntrustedData(markdown, `google_docs:${doc.title}`)}`;
}

async function handleCreate(auth: GoogleAuth, input: DocsInput): Promise<string> {
  if (!input.content) return 'Error: "content" is required for action "create".';

  // Convert markdown to HTML, then upload via Drive API with conversion to Google Docs.
  // This is far more reliable than Docs batchUpdate for tables, lists, code blocks, etc.
  const html = markdownToHtml(input.content);
  const title = input.title ?? 'Untitled Document';

  const boundary = '---lynox-doc-boundary---';
  const metadata = JSON.stringify({
    name: title,
    mimeType: 'application/vnd.google-apps.document',
  });

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    `--${boundary}--`,
  ].join('\r\n');

  const token = await auth.getAccessToken();
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to create document (${response.status}): ${text}`;
  }

  const result = await response.json() as { id: string; name: string };
  return `Document created.\nTitle: ${result.name}\nID: ${result.id}\nURL: https://docs.google.com/document/d/${result.id}/edit`;
}

async function handleAppend(auth: GoogleAuth, input: DocsInput): Promise<string> {
  if (!input.document_id) return 'Error: "document_id" is required for action "append".';
  if (!input.content) return 'Error: "content" is required for action "append".';

  // First, get the document to find the end index
  const docResponse = await docsFetch(auth, `${DOCS_BASE}/${input.document_id}`);
  if (!docResponse.ok) return `Error: Failed to read document (${docResponse.status}).`;

  const doc = await docResponse.json() as DocsDocument;
  const bodyContent = doc.body.content;
  const lastElement = bodyContent[bodyContent.length - 1];
  const endIndex = lastElement ? lastElement.endIndex - 1 : 1;

  // Insert text at the end
  const requests: Array<Record<string, unknown>> = [{
    insertText: {
      text: '\n' + input.content,
      location: { index: endIndex },
    },
  }];

  const response = await docsFetch(auth, `${DOCS_BASE}/${input.document_id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to append content (${response.status}): ${text}`;
  }

  return `Content appended to document "${doc.title}" (${input.document_id}).`;
}

async function handleReplace(auth: GoogleAuth, input: DocsInput): Promise<string> {
  if (!input.document_id) return 'Error: "document_id" is required for action "replace".';
  if (!input.find) return 'Error: "find" is required for action "replace".';
  if (input.replace_with === undefined) return 'Error: "replace_with" is required for action "replace".';

  const requests = [{
    replaceAllText: {
      containsText: {
        text: input.find,
        matchCase: true,
      },
      replaceText: input.replace_with,
    },
  }];

  const response = await docsFetch(auth, `${DOCS_BASE}/${input.document_id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to replace text (${response.status}): ${text}`;
  }

  const result = await response.json() as BatchUpdateResponse;
  return `Text replaced in document ${input.document_id}. ${result.replies.length} operation(s) completed.`;
}
