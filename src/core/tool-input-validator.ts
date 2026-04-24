/**
 * Minimal JSON-Schema validator for tool inputs at dispatch time.
 *
 * Purpose: catch the common class of agent mistakes where the model passes
 * an unknown top-level key, a wrong type, or omits a required field.
 * Without this, malformed input is silently forwarded to the tool handler
 * which typically ignores extras and then fails or behaves incorrectly.
 *
 * Deliberately narrow — we only implement the JSON Schema constructs that
 * our builtin tools use: `type`, `properties`, `required`, `enum`, and
 * `items`. If a schema uses a construct we don't recognise (e.g. `oneOf`,
 * `$ref`, `pattern`), the unknown portion is silently accepted so that
 * new tool schemas cannot accidentally break dispatch.
 *
 * Strict by default: `additionalProperties: false` is the implicit rule
 * at the object level. Set `additionalProperties: true` on the schema to
 * opt a specific tool back into loose mode.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

export interface ToolValidationError {
  path: string;
  message: string;
}

export interface ToolValidationResult {
  ok: boolean;
  errors: ToolValidationError[];
}

// BetaTool.input_schema is a JSON Schema fragment — we type-narrow as we go.
type SchemaNode = Record<string, unknown>;

export function validateToolInput(
  schema: BetaTool['input_schema'],
  input: unknown,
): ToolValidationResult {
  const errors: ToolValidationError[] = [];
  validateNode(schema as SchemaNode, input, '', errors);
  return { ok: errors.length === 0, errors };
}

function validateNode(
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: ToolValidationError[],
): void {
  const type = schema['type'];

  if (type === 'object') {
    validateObject(schema, value, path, errors);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path: path || '<root>', message: 'expected array' });
      return;
    }
    const items = schema['items'];
    if (items && typeof items === 'object') {
      value.forEach((item, i) => validateNode(items as SchemaNode, item, `${path}[${i}]`, errors));
    }
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ path: path || '<root>', message: 'expected string' });
      return;
    }
    checkEnum(schema, value, path, errors);
    return;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number') {
      errors.push({ path: path || '<root>', message: `expected ${type}` });
      return;
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      errors.push({ path: path || '<root>', message: 'expected integer' });
    }
    checkEnum(schema, value, path, errors);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({ path: path || '<root>', message: 'expected boolean' });
    }
    return;
  }
  // Unknown type or no type → silently accept (forward-compatible)
}

function validateObject(
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: ToolValidationError[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({ path: path || '<root>', message: 'expected object' });
    return;
  }
  const obj = value as Record<string, unknown>;
  const propsRaw = schema['properties'] as Record<string, SchemaNode> | undefined;
  const props = propsRaw ?? {};
  const required = (schema['required'] as string[] | undefined) ?? [];

  // Free-form object idiom: `{ type: 'object' }` with no `properties` declared
  // means "payload shape is data-driven, not enumerated" (e.g. http_request.headers,
  // data_store_insert.records[*], run_pipeline.context). Strict-by-default for
  // these would reject every real call. Caller can still force strict by setting
  // `additionalProperties: false` explicitly.
  const additional = schema['additionalProperties'];
  const additionalExplicit = additional === true || additional === false;
  const hasDeclaredProperties = propsRaw !== undefined && Object.keys(propsRaw).length > 0;
  const allowAdditional = additionalExplicit ? additional === true : !hasDeclaredProperties;

  for (const req of required) {
    if (!Object.hasOwn(obj, req)) {
      errors.push({ path: joinPath(path, req), message: 'required property missing' });
    }
  }

  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(props, key)) {
      if (!allowAdditional) {
        const known = Object.keys(props).join(', ');
        const hint = known ? ` — known properties: ${known}` : ' — this object accepts no declared properties';
        errors.push({
          path: joinPath(path, key),
          message: `unknown property${hint}`,
        });
      }
      continue;
    }
    validateNode(props[key]!, obj[key], joinPath(path, key), errors);
  }
}

function checkEnum(
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: ToolValidationError[],
): void {
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && !enumValues.includes(value)) {
    errors.push({
      path: path || '<root>',
      message: `value must be one of: ${enumValues.map(v => JSON.stringify(v)).join(', ')}`,
    });
  }
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

export function formatValidationErrors(errors: ToolValidationError[]): string {
  return errors.map(e => `  - ${e.path}: ${e.message}`).join('\n');
}
