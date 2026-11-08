import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseTool, validateValue, type ToolDefinition, type Schema } from '@orchestrator/core';
export const bindingInput = z.object({
  location: z.enum(['path', 'query', 'body', 'header']),
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/),
  source: z.enum(['tenantId', 'userId', 'employeeId']),
});
export const operationInput = z.object({
  id: z.string().min(1).max(100),
  definition: z.unknown(),
  bindings: z.array(bindingInput).max(20).default([]),
  enabled: z.boolean().default(false),
});
export type Operation = {
  id: string;
  definition: ToolDefinition;
  bindings: z.infer<typeof bindingInput>[];
  enabled: boolean;
};
// A host-relative path keeps cookie-authenticated session requests on the embedding origin.
export const sessionEndpointInput = z
  .string()
  .trim()
  .min(2)
  .max(500)
  .refine((path) => {
    if (!/^\/[A-Za-z0-9/_~.\-]+$/.test(path) || path.startsWith('//')) return false;
    return new URL(path, 'https://host.invalid').pathname === path;
  }, 'Use a same-origin endpoint path, such as /api/assistant/session, without a URL, query or fragment');
export type BridgeConfig = {
  name: string;
  baseUrl: string;
  origins: string[];
  tenantId: string;
  sessionEndpoint: string;
  operations: Operation[];
};
export const draftInput = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url().max(1000),
  origins: z.array(z.string().url()).min(1).max(20),
  tenantId: z.string().min(1).max(200),
  sessionEndpoint: sessionEndpointInput.default('/assistant/session'),
  operations: z.array(operationInput).max(40).default([]),
});
export function parseDraft(value: unknown): BridgeConfig {
  const draft = draftInput.parse(value);
  for (const origin of draft.origins) {
    const u = new URL(origin);
    if (
      u.origin !== origin ||
      (u.protocol !== 'https:' &&
        !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(u.hostname)))
    )
      throw new Error('Use exact HTTPS embedding origins');
  }
  const operations = draft.operations.map((o) => {
    const definition = parseTool(o.definition);
    const seen = new Set<string>();
    for (const b of o.bindings) {
      if (['__proto__', 'constructor', 'prototype'].includes(b.name))
        throw new Error('Unsafe binding name');
      const key = b.location + ':' + b.name;
      if (seen.has(key)) throw new Error('Duplicate identity binding');
      seen.add(key);
      if (b.location === 'header') {
        if (
          /^(authorization|cookie|host|content-type|content-length|transfer-encoding|connection|proxy-authorization|x-forwarded.*)$/i.test(
            b.name,
          )
        )
          throw new Error('Reserved authentication or transport header');
      } else if (!definition.schema.properties?.[b.location]?.properties?.[b.name])
        throw new Error(`Binding field ${key} is not declared in the schema`);
    }
    return { ...o, definition };
  });
  if (
    new Set(operations.map((o) => o.id)).size !== operations.length ||
    new Set(operations.map((o) => o.definition.name)).size !== operations.length
  )
    throw new Error('Operation IDs and names must be unique');
  return { ...draft, baseUrl: draft.baseUrl.replace(/\/$/, ''), operations };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as any)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export function modelSchema(op: Operation): Schema {
  const schema = structuredClone(op.definition.schema);
  for (const b of op.bindings) {
    if (b.location === 'header') continue;
    const group = schema.properties?.[b.location];
    if (group?.properties) {
      delete group.properties[b.name];
      group.required = group.required?.filter((k) => k !== b.name);
      if (!Object.keys(group.properties).length) {
        delete schema.properties![b.location];
        schema.required = schema.required?.filter((k) => k !== b.location);
      }
    }
  }
  return schema;
}
export function bindArguments(
  op: Operation,
  input: unknown,
  identity: { tenantId: string; userId: string; employeeId?: string },
) {
  validateValue(modelSchema(op), input);
  const args = structuredClone(input) as any;
  const headers: Record<string, string> = {};
  for (const b of op.bindings) {
    const value = identity[b.source];
    if (!value || /[\r\n]/.test(value)) throw new Error(`Verified ${b.source} is required`);
    if (b.location === 'header') headers[b.name] = value;
    else {
      args[b.location] ??= {};
      args[b.location][b.name] = value;
    }
  }
  validateValue(op.definition.schema, args);
  return { args, headers };
}
export type BridgeGrant = {
  purpose: 'mcp' | 'bind' | 'revoke' | 'health';
  orgId: string;
  tenantId: string;
  userId: string;
  deploymentId: string;
  versionId: string;
  sessionId: string;
  toolIds: string[];
  revisionIds: string[];
  bindingId?: string;
  operationId?: string;
  executionId?: string;
  digest?: string;
  conversationId?: string;
  approved?: boolean;
};
export const grantInput = z.object({
  purpose: z.enum(['mcp', 'bind', 'revoke', 'health']),
  orgId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  deploymentId: z.string(),
  versionId: z.string(),
  sessionId: z.string(),
  toolIds: z.array(z.string()).max(40),
  revisionIds: z.array(z.string()).max(40),
  bindingId: z.string().optional(),
  operationId: z.string().optional(),
  executionId: z.string().optional(),
  digest: z.string().optional(),
  conversationId: z.string().optional(),
  approved: z.boolean().optional(),
});
export const serviceError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
