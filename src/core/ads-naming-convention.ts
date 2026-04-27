/**
 * Naming-Convention Enforcer.
 *
 * Validates Google Ads entity names against a customer-defined token
 * template like `{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}`. Templates are
 * stored on `customer_profiles.naming_convention_pattern` (free-text
 * column). The enforcer parses the template, splits the candidate name
 * by the separators, and validates each token against either a
 * built-in vocabulary (LANG/CHANNEL/MATCHTYPE/REGION) or against the
 * customer profile (BRAND, languages override).
 *
 * Free-form tokens (THEME and any custom token) are accepted as long
 * as they are non-empty and contain only allowed characters.
 *
 * Pure utility — no DB / I/O. Output structure is meant to be
 * embedded in `ads_blueprint_entities.naming_errors_json` so emit can
 * fail fast.
 */

const STANDARD_TOKENS = ['LANG', 'CHANNEL', 'MATCHTYPE', 'BRAND', 'REGION', 'THEME'] as const;
type StandardToken = typeof STANDARD_TOKENS[number];

const CHANNEL_VOCAB = new Set(['Search', 'Display', 'Shopping', 'PMAX', 'Video', 'Demand', 'App']);
const MATCHTYPE_VOCAB = new Set(['Exact', 'Phrase', 'Broad']);

export interface NamingValidationContext {
  /** Allowed lowercase 2-letter ISO codes for the customer (e.g. ['de', 'fr']). */
  languages?: readonly string[] | undefined;
  /** Customer's own brands; if set, BRAND token must match (case-insensitive). */
  ownBrands?: readonly string[] | undefined;
  /** Allowed REGION tokens (free-form, customer-defined). */
  regions?: readonly string[] | undefined;
}

export interface ParsedTemplate {
  /** Token names in declaration order, e.g. ['LANG', 'CHANNEL', 'THEME']. */
  tokens: string[];
  /** Literal separators between tokens, length = tokens.length - 1. */
  separators: string[];
  /** True if the template parsed without structural errors. */
  valid: boolean;
  /** Structural errors (template-level, not name-level). */
  errors: string[];
}

export interface NamingValidationResult {
  valid: boolean;
  errors: string[];
  /** Resolved token values when valid; undefined otherwise. */
  parts?: Record<string, string> | undefined;
}

/**
 * Parse a token template like `{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}` into
 * tokens + separators. Reports structural problems but does not validate
 * that every token is a known one — unknown tokens are accepted as
 * free-form by validateName().
 */
export function parseTemplate(template: string): ParsedTemplate {
  const tokens: string[] = [];
  const separators: string[] = [];
  const errors: string[] = [];
  if (!template || typeof template !== 'string') {
    return { tokens, separators, valid: false, errors: ['template is empty'] };
  }
  const re = /\{([A-Z][A-Z0-9_]*)\}/gu;
  const matches = [...template.matchAll(re)];
  if (matches.length === 0) {
    errors.push('template has no {TOKEN} placeholders');
    return { tokens, separators, valid: false, errors };
  }
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const literal = template.slice(cursor, m.index);
    if (i === 0) {
      if (literal.length > 0) errors.push(`leading literal "${literal}" not allowed before first token`);
    } else {
      if (literal.length === 0) {
        errors.push(`empty separator between tokens ${matches[i - 1]![1]!} and ${m[1]!}`);
      }
      separators.push(literal);
    }
    tokens.push(m[1]!);
    cursor = m.index + m[0].length;
  }
  const trailing = template.slice(cursor);
  if (trailing.length > 0) errors.push(`trailing literal "${trailing}" not allowed after last token`);
  return { tokens, separators, valid: errors.length === 0, errors };
}

/**
 * Validate `name` against a parsed template + customer context.
 */
export function validateName(
  name: string,
  template: ParsedTemplate,
  context?: NamingValidationContext | undefined,
): NamingValidationResult {
  if (!template.valid) {
    return { valid: false, errors: template.errors.map(e => `template invalid: ${e}`) };
  }
  if (!name || typeof name !== 'string') {
    return { valid: false, errors: ['name is empty'] };
  }

  // Build a regex matching the template structure. Token characters =
  // anything that is not a separator character. This is a permissive
  // approach — names with separator characters inside a token are
  // rejected, which is the desired contract.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const allSeparatorChars = new Set<string>();
  for (const sep of template.separators) for (const ch of sep) allSeparatorChars.add(ch);
  const charClass = allSeparatorChars.size > 0
    ? `[^${escapeRe([...allSeparatorChars].join(''))}]+`
    : '.+';

  let pattern = '^';
  for (let i = 0; i < template.tokens.length; i++) {
    pattern += `(${charClass})`;
    if (i < template.tokens.length - 1) {
      pattern += escapeRe(template.separators[i]!);
    }
  }
  pattern += '$';

  const re = new RegExp(pattern, 'u');
  const m = name.match(re);
  if (!m) {
    return {
      valid: false,
      errors: [`name does not match template structure ` +
        `(expected ${template.tokens.length} tokens separated by ${JSON.stringify(template.separators)})`],
    };
  }

  const parts: Record<string, string> = {};
  const errors: string[] = [];
  for (let i = 0; i < template.tokens.length; i++) {
    const tokenName = template.tokens[i]!;
    const value = m[i + 1]!;
    parts[tokenName] = value;
    const tokenErrors = validateToken(tokenName, value, context);
    for (const e of tokenErrors) errors.push(e);
  }

  return errors.length === 0
    ? { valid: true, errors: [], parts }
    : { valid: false, errors, parts };
}

/**
 * Convenience: parse + validate in one call.
 */
export function checkName(
  name: string,
  template: string,
  context?: NamingValidationContext | undefined,
): NamingValidationResult {
  const parsed = parseTemplate(template);
  return validateName(name, parsed, context);
}

function validateToken(
  tokenName: string,
  value: string,
  context: NamingValidationContext | undefined,
): string[] {
  if (value.length === 0) return [`token ${tokenName} is empty`];

  if (isStandardToken(tokenName)) {
    switch (tokenName) {
      case 'LANG': {
        const lc = value.toLowerCase();
        if (!/^[a-z]{2}$/u.test(lc)) {
          return [`token LANG="${value}" must be a 2-letter ISO code`];
        }
        if (context?.languages && context.languages.length > 0
          && !context.languages.map(l => l.toLowerCase()).includes(lc)) {
          return [`token LANG="${value}" not in customer languages [${context.languages.join(', ')}]`];
        }
        return [];
      }
      case 'CHANNEL':
        return CHANNEL_VOCAB.has(value)
          ? []
          : [`token CHANNEL="${value}" not in vocabulary [${[...CHANNEL_VOCAB].join(', ')}]`];
      case 'MATCHTYPE':
        return MATCHTYPE_VOCAB.has(value)
          ? []
          : [`token MATCHTYPE="${value}" not in vocabulary [${[...MATCHTYPE_VOCAB].join(', ')}]`];
      case 'BRAND': {
        const brands = context?.ownBrands ?? [];
        if (brands.length === 0) return [];
        return brands.map(b => b.toLowerCase()).includes(value.toLowerCase())
          ? []
          : [`token BRAND="${value}" not in customer brands [${brands.join(', ')}]`];
      }
      case 'REGION': {
        const regions = context?.regions ?? [];
        if (regions.length === 0) return [];
        return regions.map(r => r.toLowerCase()).includes(value.toLowerCase())
          ? []
          : [`token REGION="${value}" not in customer regions [${regions.join(', ')}]`];
      }
      case 'THEME':
        return [];
    }
  }
  return [];
}

function isStandardToken(name: string): name is StandardToken {
  return (STANDARD_TOKENS as readonly string[]).includes(name);
}
