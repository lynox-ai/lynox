// === Contacts tools ===
//
// A thin, typed, scope-correct surface over the CRM `contacts` collection
// (which is itself a frozen-schema wrapper over the DataStore). These two
// tools are the half the web UI already expects (the `contacts_save` /
// `contacts_search` chat-activity labels in ChatView) but the engine was
// missing. They delegate to `agent.toolContext.crm`, which writes into the
// global CRM scope + schema — unlike a raw `data_store_insert('contacts')`,
// which would land in the agent's context scope where the inbox
// contact-resolver (the reading-pane sidebar) can't see it.
//
// Identity is the email address (unique key, normalised lower-case in the
// CRM layer): saving an existing email updates that contact; a new email
// inserts a new one. NO requiresConfirmation — saving a contact is a
// reversible internal write to an address the user themselves corresponded
// with; the tool call is visible in the transcript, which is the consent
// surface (per the v1 decision-log D4).

import type { ToolEntry } from '../../types/index.js';
import type { ContactData, ContactRecord } from '../../core/crm.js';
import { getErrorMessage } from '../../core/utils.js';

// CRM accessed via agent.toolContext.crm

// === contacts_save ===

interface ContactsSaveInput {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  company?: string | undefined;
  /** lead, customer, partner, prospect, other */
  type?: string | undefined;
  notes?: string | undefined;
  /** Tags for segmentation, e.g. ["vip", "newsletter"]. */
  tags?: string[] | undefined;
}

export const contactsSaveTool: ToolEntry<ContactsSaveInput> = {
  definition: {
    name: 'contacts_save',
    description:
      'Save a person to the contacts list so they are remembered across sessions. ' +
      'Identity is the email: saving an existing email updates that contact instead of duplicating. ' +
      'Use after emailing or messaging a genuine new correspondent (a real person you would deal with again); ' +
      'skip one-offs, no-reply, and automated senders. Call contacts_search first if unsure whether they already exist.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name. Required.' },
        email: { type: 'string', description: 'Email — the identity used for dedup. Strongly recommended.' },
        phone: { type: 'string', description: 'Phone number.' },
        company: { type: 'string', description: 'Company / organisation.' },
        type: { type: 'string', description: 'lead, customer, partner, prospect, or other.' },
        notes: { type: 'string', description: 'Free-text notes.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Segmentation tags, e.g. ["vip"].' },
      },
      required: ['name'],
    },
  },
  handler: async (input: ContactsSaveInput, agent): Promise<string> => {
    const crm = agent.toolContext.crm;
    if (!crm) return 'Contacts are not available (no data store).';

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return 'contacts_save error: "name" is required.';

    try {
      const data: ContactData = { name, source: 'manual' };
      if (input.email !== undefined) data.email = input.email;
      if (input.phone !== undefined) data.phone = input.phone;
      if (input.company !== undefined) data.company = input.company;
      if (input.type !== undefined) data.type = input.type;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.tags !== undefined) data.tags = input.tags;

      crm.upsertContact(data);

      const emailNote = data.email ? ` <${data.email.trim().toLowerCase()}>` : ' (no email — not deduplicated)';
      return `Saved contact: ${name}${emailNote}.`;
    } catch (err) {
      return `contacts_save error: ${getErrorMessage(err)}`;
    }
  },
};

// === contacts_search ===

interface ContactsSearchInput {
  /** Free-text term matched (case-insensitive contains) against name, email, and company. */
  query?: string | undefined;
  /** Exact email lookup (normalised). Use to check whether a specific address is already a contact. */
  email?: string | undefined;
  limit?: number | undefined;
}

export const contactsSearchTool: ToolEntry<ContactsSearchInput> = {
  definition: {
    name: 'contacts_search',
    description:
      'Search saved contacts. Pass `email` for an exact lookup (check whether an address is already a contact before saving), ' +
      'or `query` for a free-text match across name, email, and company. No arguments returns the most recent contacts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text term matched against name, email, and company.' },
        email: { type: 'string', description: 'Exact email to look up.' },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
      required: [],
    },
  },
  handler: async (input: ContactsSearchInput, agent): Promise<string> => {
    const crm = agent.toolContext.crm;
    if (!crm) return 'Contacts are not available (no data store).';

    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 100) : 20;

    try {
      // Exact email lookup — the "do I already have this person?" path.
      if (typeof input.email === 'string' && input.email.trim().length > 0) {
        const normalized = input.email.trim().toLowerCase();
        const found = crm.findContact({ email: normalized });
        return found
          ? `Found 1 contact:\n${formatContact(found)}`
          : `No contact found for ${normalized}.`;
      }

      // Free-text search across name / email / company.
      let results: ContactRecord[];
      if (typeof input.query === 'string' && input.query.trim().length > 0) {
        const like = `%${input.query.trim()}%`;
        results = crm.listContacts(
          { $or: [{ name: { $like: like } }, { email: { $like: like } }, { company: { $like: like } }] },
          limit,
        );
      } else {
        results = crm.listContacts(undefined, limit);
      }

      if (results.length === 0) return 'No contacts found.';
      const header = `Found ${results.length} contact${results.length === 1 ? '' : 's'}:`;
      return `${header}\n${results.map(formatContact).join('\n')}`;
    } catch (err) {
      return `contacts_search error: ${getErrorMessage(err)}`;
    }
  },
};

/** One-line render of a contact for tool output. */
function formatContact(c: ContactRecord): string {
  const parts: string[] = [c.name || '(no name)'];
  if (c.email) parts.push(`<${c.email}>`);
  if (c.company) parts.push(`· ${c.company}`);
  if (c.phone) parts.push(`· ${c.phone}`);
  if (c.type) parts.push(`[${c.type}]`);
  return `- ${parts.join(' ')}`;
}
