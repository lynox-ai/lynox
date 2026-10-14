/**
 * What a write to an account connected through a built-in provider changes there, read from
 * that account before the person is asked: the document, the recipient by name, the amount.
 * The body alone names a recipient by number and carries no total, and a state change (cancel,
 * payment) has no body worth the name, so the question would otherwise show nothing a person
 * can judge.
 *
 * Fail-closed: when a write needs a reading and the reading fails (an answer that is not 2xx,
 * a missing field, an amount that cannot be summed), the write is refused, never asked
 * without it. A write this table has nothing to say about is asked as before, body only.
 *
 * Every path read comes from a fixed template here, with an id that is digits only and taken
 * from the write being asked (its path or its parsed body) or from a document read for it;
 * the caller reads on the write's own origin and follows no redirect.
 */

/** Reads one path on the write's origin; resolves the JSON object, or throws `WriteContextRefused`. */
export type PresetRead = (path: string) => Promise<Record<string, unknown>>;

/** A write this table cannot describe; the message says why and what to do instead. */
export class WriteContextRefused extends Error {}

export interface PresetWriteContext {
  /** The lines to show above the body, or `null` when this write needs none. */
  describe(method: string, url: URL, body: string | undefined, read: PresetRead): Promise<string | null>;
}

const READ_ID = /^[0-9]{1,12}$/;

/** A path from a fixed template, with an id that is digits only. */
export function readPath(template: '/2.0/contact/' | '/2.0/kb_invoice/' | '/2.0/kb_offer/' | '/3.0/currencies/', id: unknown): string {
  const text = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (typeof text !== 'string' || !READ_ID.test(text)) {
    throw new WriteContextRefused(`an id to read (${JSON.stringify(id) ?? String(id)}) is not a plain number`);
  }
  return `${template}${text}`;
}

/** The sentence a refused document with discount or sub-positions carries, word for word. */
export const UNSUMMABLE_WAY_OUT =
  'Create the document without discount or sub-positions first, then add each of those positions in its own call.';

/** The sentence a refused article position without a price carries. */
export const ARTICLE_PRICE_WAY_OUT = 'Name a unit_price on each article position, so the question can show the sum.';

const DECIMAL = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;
const SCALE = 1_000_000n;

/** A decimal as given by bexio (a string, or a plain number), scaled by 10^6. */
function decimal(value: unknown, what: string): bigint {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !DECIMAL.test(text)) {
    throw new WriteContextRefused(`${what} (${JSON.stringify(value) ?? String(value)}) is not a plain decimal`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -scaled : scaled;
}

/** Cents at scale 10^12, rounded half away from zero, as `1234.50`. */
function money(atScale12: bigint): string {
  const unit = 10_000_000_000n;
  const negative = atScale12 < 0n;
  const abs = negative ? -atScale12 : atScale12;
  const cents = (abs + unit / 2n) / unit;
  const text = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  return negative && cents !== 0n ? `-${text}` : text;
}

/** Quantity × unit price, less the position's discount, for the positions that carry a price. */
export function sumOfPositions(positions: unknown): string {
  if (positions === undefined) return money(0n);
  if (!Array.isArray(positions)) throw new WriteContextRefused('positions is not a list');
  let total = 0n;
  for (const position of positions) {
    if (typeof position !== 'object' || position === null) throw new WriteContextRefused('a position is not an object');
    const p = position as Record<string, unknown>;
    const type = p['type'];
    if (type === 'KbPositionText' || type === 'KbPositionSubtotal' || type === 'KbPositionPagebreak') continue;
    if (type === 'KbPositionDiscount' || type === 'KbPositionSubposition') {
      throw new WriteContextRefused(`the document carries a ${type}, whose effect on the sum lynox does not compute. ${UNSUMMABLE_WAY_OUT}`);
    }
    if (type !== 'KbPositionCustom' && type !== 'KbPositionArticle') {
      throw new WriteContextRefused(`a position's type (${JSON.stringify(type) ?? String(type)}) is not one lynox can sum. ${UNSUMMABLE_WAY_OUT}`);
    }
    if (type === 'KbPositionArticle' && p['unit_price'] === undefined) {
      throw new WriteContextRefused(`an article position has no unit_price, so its price is the article's in bexio. ${ARTICLE_PRICE_WAY_OUT}`);
    }
    const line = decimal(p['amount'], 'a position amount') * decimal(p['unit_price'], 'a unit_price');
    const discount = p['discount_in_percent'] === undefined || p['discount_in_percent'] === null ? 0n : decimal(p['discount_in_percent'], 'a discount_in_percent');
    if (discount < 0n || discount > 100n * SCALE) throw new WriteContextRefused('a discount_in_percent is outside 0 to 100');
    total += (line * (100n * SCALE - discount)) / (100n * SCALE);
  }
  return money(total);
}

/** An amount bexio returns (`"19.150000"`), as `19.15`. */
function amount(value: unknown, what: string): string {
  if (value === undefined || value === null) throw new WriteContextRefused(`the reading has no ${what}`);
  return money(decimal(value, `the ${what}`) * SCALE);
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new WriteContextRefused(`the reading has no ${what}`);
  return value.replace(/\s*\r?\n\s*/g, ', ').trim();
}

async function contactName(read: PresetRead, id: unknown): Promise<string> {
  const contact = await read(readPath('/2.0/contact/', id));
  const name = [contact['name_1'], contact['name_2']].filter((n): n is string => typeof n === 'string' && n.trim() !== '').join(' ');
  return text(name, 'contact name');
}

async function currencyCode(read: PresetRead, id: unknown): Promise<string> {
  return text((await read(readPath('/3.0/currencies/', id)))['name'] ?? undefined, 'currency code');
}

const DOCUMENTS = { kb_invoice: 'invoice', kb_offer: 'quote' } as const;

function parsedBody(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

const bexio: PresetWriteContext = {
  async describe(_method, url, body, read) {
    // Matched case-insensitively and with empty segments dropped, so a spelling the server may
    // read as the same path is not a way past this table.
    const segments = url.pathname.toLowerCase().split('/').filter((s) => s !== '');
    if (segments[0] !== '2.0' || segments[1] === undefined) return null;
    const resource = segments[1];
    const fields = parsedBody(body);
    if (resource === 'kb_invoice' || resource === 'kb_offer') {
      const kind = DOCUMENTS[resource];
      const target = segments[2];
      if (target === 'search') return null;
      if (target === undefined) {
        if (fields === undefined) throw new WriteContextRefused(`a new ${kind}'s body is not a JSON object`);
        for (const field of ['contact_id', 'currency_id']) {
          if (fields[field] === undefined) throw new WriteContextRefused(`a new ${kind} names no ${field}. Name it in the body, so the question can show it`);
        }
        const name = await contactName(read, fields['contact_id']);
        const sum = sumOfPositions(fields['positions']);
        const code = await currencyCode(read, fields['currency_id']);
        return `New bexio ${kind} · recipient: ${name} (contact ${String(fields['contact_id'])}) · ` +
          `sum of positions: ${code} ${sum} (quantity × unit price less each position's discount; bexio adds tax and rounds)`;
      }
      const document = await read(readPath(`/2.0/${resource}/` as '/2.0/kb_invoice/' | '/2.0/kb_offer/', target));
      const code = await currencyCode(read, document['currency_id']);
      const open = resource === 'kb_invoice' ? `, open ${code} ${amount(document['total_remaining_payments'], 'open amount')}` : '';
      return `bexio ${kind} ${text(document['document_nr'], 'document number')} · recipient: ${text(document['contact_address'], 'recipient')} · ` +
        `total ${code} ${amount(document['total'], 'total')}${open}`;
    }
    if (resource.startsWith('kb_')) {
      throw new WriteContextRefused(`lynox does not write to bexio's ${resource} documents: it cannot show them in the question`);
    }
    if (fields !== undefined && 'contact_id' in fields) {
      return `bexio contact ${String(fields['contact_id'])}: ${await contactName(read, fields['contact_id'])}`;
    }
    return null;
  },
};

/** Per preset id. A preset without an entry asks with the body only. */
export const PRESET_WRITE_CONTEXT: Readonly<Record<string, PresetWriteContext>> = Object.freeze({ bexio });
