/**
 * Tool: ads_mark_imported
 *
 * Records that the customer has run the Editor import for a given
 * ads_account_id. Stamps `ads_accounts.last_major_import_at` with the
 * current timestamp (or a caller-provided ISO when re-recording an
 * earlier import after the fact).
 *
 * Drives the 14d Smart-Bidding-Guard on the next cycle's PMAX
 * restructure proposals — without this stamp, the guard cannot tell
 * whether smart-bidding is still in its post-import learning window
 * and will conservatively block all major restructure suggestions.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { AdsDataStore } from '../../core/ads-data-store.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsMarkImportedInput {
  ads_account_id: string;
  /** Optional ISO timestamp to backdate the import. Defaults to now. */
  imported_at?: string | undefined;
}

const DESCRIPTION = [
  'Stamp the customer\'s Google Ads Editor import timestamp on the account.',
  '',
  'Workflow position — call AFTER the customer has confirmed they ran the',
  '`ads_emit_csv` output through Editor and posted the changes. The stamp',
  'anchors the 14d Smart-Bidding-Guard on subsequent PMAX restructure',
  'proposals — without it, the next cycle\'s blueprint cannot tell whether',
  'smart-bidding is still in its post-import learning window and will',
  'conservatively block all major restructure suggestions.',
  '',
  'Pass `imported_at` only if you need to backdate (e.g. customer ran the',
  'import yesterday and forgot to call this then). Otherwise omit it and',
  'the tool stamps the current time.',
].join('\n');

export function createAdsMarkImportedTool(store: AdsDataStore): ToolEntry<AdsMarkImportedInput> {
  return {
    definition: {
      name: 'ads_mark_imported',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: { type: 'string', description: 'Google Ads Customer ID, e.g. "123-456-7890".' },
          imported_at: {
            type: 'string',
            description: 'Optional ISO 8601 timestamp to backdate the import. Defaults to now.',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsMarkImportedInput, _agent: IAgent): Promise<string> => {
      try {
        const account = store.getAdsAccount(input.ads_account_id);
        if (!account) {
          return `ads_mark_imported failed: unknown ads_account_id "${input.ads_account_id}".`;
        }
        const iso = parseIsoOrNow(input.imported_at);
        if (iso === null) {
          return `ads_mark_imported failed: imported_at "${input.imported_at}" is not a valid ISO 8601 timestamp.`;
        }
        store.setLastMajorImportAt(input.ads_account_id, iso);
        return `Editor-Import vermerkt: ${input.ads_account_id} → ${iso}. ` +
          `14-Tage-Smart-Bidding-Guard ist ab jetzt aktiv.`;
      } catch (err) {
        return `ads_mark_imported failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

function parseIsoOrNow(input: string | undefined): string | null {
  if (input === undefined) return new Date().toISOString();
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
