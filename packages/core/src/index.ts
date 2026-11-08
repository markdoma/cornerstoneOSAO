import { z } from 'zod';
import { parse } from 'yaml';

export type Schema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  enum?: unknown[];
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};
const allowed = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'title',
  'example',
  'examples',
  'default',
  'format',
  'nullable',
]);
export function checkSchema(raw: unknown, depth = 0): Schema {
  if (depth > 12 || !raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Schema must be an object with nesting at most 12');
  const s = raw as Record<string, any>;
  for (const key of Object.keys(s))
    if (!allowed.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (s.nullable) throw new Error('nullable schemas are unsupported; use optional properties');
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(s.type))
    throw new Error('Every schema must declare one supported type');
  if (
    s.enum &&
    (!Array.isArray(s.enum) ||
      s.enum.length > 100 ||
      s.enum.some((v: unknown) => v !== null && typeof v === 'object'))
  )
    throw new Error('enum must contain at most 100 scalar values');
  const result: any = { type: s.type };
  for (const key of [
    'enum',
    'description',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ]) {
    if (s[key] !== undefined) {
      if (key === 'description' && (typeof s[key] !== 'string' || s[key].length > 2000))
        throw new Error('Invalid schema description');
      if (
        !['description', 'enum'].includes(key) &&
        (!Number.isFinite(s[key]) ||
          (key !== 'minimum' && key !== 'maximum' && (!Number.isInteger(s[key]) || s[key] < 0)))
      )
        throw new Error(`Invalid ${key}`);
      result[key] = s[key];
    }
  }
  if (s.type === 'object') {
    if (s.additionalProperties !== undefined && s.additionalProperties !== false)
      throw new Error('Free-form object properties are unsupported');
    const props = s.properties ?? {};
    if (
      !props ||
      typeof props !== 'object' ||
      Array.isArray(props) ||
      Object.keys(props).length > 60
    )
      throw new Error('Invalid properties');
    result.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => {
        if (['__proto__', 'constructor', 'prototype'].includes(k))
          throw new Error('Unsafe property name');
        return [k, checkSchema(v, depth + 1)];
      }),
    );
    if (
      s.required !== undefined &&
      (!Array.isArray(s.required) ||
        s.required.some((k: unknown) => typeof k !== 'string' || !Object.hasOwn(props, k)))
    )
      throw new Error('Invalid required fields');
    result.required = s.required ?? [];
    result.additionalProperties = false;
  }
  if (s.type === 'array') result.items = checkSchema(s.items, depth + 1);
  return result;
}
export function validateValue(s: Schema, value: unknown, path = 'input'): void {
  if (s.enum && !s.enum.some((v) => v === value)) throw new Error(`${path}: invalid enum value`);
  switch (s.type) {
    case 'null':
      if (value !== null) throw new Error(`${path}: expected null`);
      break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${path}: expected object`);
      const v = value as Record<string, unknown>;
      for (const k of s.required ?? [])
        if (!Object.hasOwn(v, k)) throw new Error(`${path}.${k}: required`);
      for (const [k, item] of Object.entries(v)) {
        if (!Object.hasOwn(s.properties ?? {}, k)) throw new Error(`${path}.${k}: unknown field`);
        validateValue(s.properties![k], item, `${path}.${k}`);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
      else {
        if (value.length > (s.maxItems ?? 1000) || value.length < (s.minItems ?? 0))
          throw new Error(`${path}: invalid array length`);
        value.forEach((v, i) => validateValue(s.items!, v, `${path}[${i}]`));
      }
      break;
    case 'string':
      if (
        typeof value !== 'string' ||
        value.length < (s.minLength ?? 0) ||
        value.length > (s.maxLength ?? 20000)
      )
        throw new Error(`${path}: invalid string`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
      break;
    default:
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (s.type === 'integer' && !Number.isInteger(value)) ||
        value < (s.minimum ?? -Infinity) ||
        value > (s.maximum ?? Infinity)
      )
        throw new Error(`${path}: invalid number`);
  }
}
export const toolInput = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  description: z.string().min(1).max(2000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(1000),
  kind: z.enum(['read', 'write']),
  schema: z.unknown(),
  idempotencyHeader: z.literal('Idempotency-Key').optional(),
});
export type ToolDefinition = Omit<z.infer<typeof toolInput>, 'schema'> & { schema: Schema };
export function parseTool(raw: unknown): ToolDefinition {
  const v = toolInput.parse(raw);
  if (
    !v.path.startsWith('/') ||
    v.path.startsWith('//') ||
    /[?#\\\s]/.test(v.path) ||
    /%|\.\./.test(v.path)
  )
    throw new Error('Use a relative path without query strings, encodings, or traversal');
  if (v.method !== 'GET' && v.kind === 'read')
    throw new Error('Only GET operations can be marked read');
  const schema = checkSchema(v.schema);
  if (
    schema.type !== 'object' ||
    Object.keys(schema.properties ?? {}).some((k) => !['path', 'query', 'body'].includes(k))
  )
    throw new Error('Tool schema must be an object containing path, query, and/or body');
  for (const key of ['path', 'query']) {
    const child = schema.properties?.[key];
    if (
      child &&
      (child.type !== 'object' ||
        Object.values(child.properties ?? {}).some(
          (p) => !['string', 'number', 'integer', 'boolean'].includes(p.type),
        ))
    )
      throw new Error(`${key} parameters must be an object of scalar fields`);
  }
  const placeholders = [...v.path.matchAll(/\{([\w-]+)\}/g)].map((m) => m[1]);
  if (v.path.replace(/\{[\w-]+\}/g, '').match(/[{}]/)) throw new Error('Invalid path placeholders');
  const fields = schema.properties?.path?.properties ?? {};
  if (
    placeholders.some(
      (k) => !Object.hasOwn(fields, k) || !schema.properties?.path?.required?.includes(k),
    ) ||
    Object.keys(fields).some((k) => !placeholders.includes(k)) ||
    (placeholders.length && !schema.required?.includes('path'))
  )
    throw new Error('Path placeholders require matching required path parameters');
  if (v.method === 'GET' && schema.properties?.body)
    throw new Error('GET request bodies are unsupported');
  return { ...v, schema };
}
export const agentInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  avatar: z.string().max(200000).default(''),
  prompt: z.string().min(1).max(20000),
  welcome: z.string().max(500).default('How can I help?'),
  starters: z.array(z.string().min(1).max(200)).max(4).default([]),
  model: z.string().min(1),
  toolIds: z.array(z.string()).max(40).default([]),
});
export const themeInput = z.object({
  template: z.enum(['floating', 'inline']).default('floating'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6d5dfc'),
  mode: z.enum(['light', 'dark', 'auto']).default('light'),
  position: z.enum(['left', 'right']).default('right'),
  title: z.string().max(100).default('Assistant'),
});
export type Theme = z.infer<typeof themeInput>;
export function safeAvatar(value: string): boolean {
  return value === '' || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value);
}
export function importOpenAPI(text: string): ToolDefinition[] {
  if (text.length > 500000) throw new Error('Specification exceeds 500 KB');
  const doc = parse(text, { maxAliasCount: 20 });
  if (!doc || !/^3\.(0|1)\.\d+$/.test(doc.openapi ?? ''))
    throw new Error('Expected an OpenAPI 3.0.x or 3.1.x specification');
  if (!doc.paths || typeof doc.paths !== 'object') throw new Error('Specification requires paths');
  const resolve = (v: any, depth = 0): any => {
    if (depth > 12) throw new Error('Recursive or deeply nested schema references are unsupported');
    if (!v || typeof v !== 'object') return v;
    if (v.$ref) {
      if (
        typeof v.$ref !== 'string' ||
        !v.$ref.startsWith('#/components/schemas/') ||
        Object.keys(v).length !== 1
      )
        throw new Error('Only standalone local component schema references are supported');
      const name = v.$ref.slice('#/components/schemas/'.length);
      if (!Object.hasOwn(doc.components?.schemas ?? {}, name))
        throw new Error(`Missing schema reference: ${name}`);
      return resolve(doc.components.schemas[name], depth + 1);
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, depth + 1)]));
  };
  const tools: ToolDefinition[] = [];
  for (const [path, item] of Object.entries(doc.paths) as [string, any][]) {
    if (!item || typeof item !== 'object' || item.$ref)
      throw new Error(`Unsupported path item: ${path}`);
    for (const [method, op] of Object.entries(item) as [string, any][]) {
      if (['parameters', 'summary', 'description'].includes(method)) continue;
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method))
        throw new Error(`Unsupported path feature ${method} at ${path}`);
      if (op.callbacks || op.servers || item.servers)
        throw new Error('Callbacks and operation-specific servers are unsupported');
      const security = op.security ?? doc.security ?? [];
      for (const requirement of security)
        for (const key of Object.keys(requirement)) {
          const sec = doc.components?.securitySchemes?.[key];
          if (sec?.type !== 'http' || sec?.scheme?.toLowerCase() !== 'bearer')
            throw new Error('Only delegated HTTP bearer security is supported');
        }
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        if (
          typeof p?.name !== 'string' ||
          !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(p.name) ||
          ['__proto__', 'constructor', 'prototype'].includes(p.name)
        )
          throw new Error('Invalid or unsafe parameter name');
        if (
          p.$ref ||
          !['path', 'query'].includes(p.in) ||
          p.content ||
          (p.style && p.style !== (p.in === 'path' ? 'simple' : 'form')) ||
          (p.explode === false && p.in === 'query')
        )
          throw new Error(
            'Only scalar path/query parameters with default serialization are supported',
          );
        properties[p.in] ??= {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        };
        if (Object.hasOwn(properties[p.in].properties!, p.name))
          throw new Error(`Duplicate parameter ${p.name}`);
        properties[p.in].properties![p.name] = checkSchema(resolve(p.schema));
        if (p.required || p.in === 'path') {
          properties[p.in].required!.push(p.name);
          if (!required.includes(p.in)) required.push(p.in);
        }
      }
      if (op.requestBody) {
        if (
          op.requestBody.$ref ||
          Object.keys(op.requestBody.content ?? {}).some((k) => k !== 'application/json') ||
          !op.requestBody.content?.['application/json']?.schema
        )
          throw new Error('Only application/json request bodies are supported');
        properties.body = checkSchema(resolve(op.requestBody.content['application/json'].schema));
        if (op.requestBody.required) required.push('body');
      }
      tools.push(
        parseTool({
          name: op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
          description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          kind: method === 'get' ? 'read' : 'write',
          schema: { type: 'object', properties, required, additionalProperties: false },
        }),
      );
    }
  }
  if (!tools.length || tools.length > 40) throw new Error('Import must contain 1–40 operations');
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new Error('Operation names must be unique');
  return tools;
}
