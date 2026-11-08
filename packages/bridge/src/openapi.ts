import { parse } from 'yaml';
import { importOpenAPI } from '@orchestrator/core';
function document(text: string) {
  if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('Specification exceeds 5 MB');
  const doc = parse(text, { maxAliasCount: 20 });
  if (
    !doc ||
    !/^3\.(0|1)\.\d+$/.test(doc.openapi ?? '') ||
    !doc.paths ||
    typeof doc.paths !== 'object'
  )
    throw new Error('Expected OpenAPI 3.x with paths');
  return doc;
}
export function inventory(text: string) {
  const doc = document(text);
  const rows = [];
  for (const [path, item] of Object.entries(doc.paths) as any)
    for (const [method, op] of Object.entries(item ?? {}) as any)
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method))
        rows.push({
          id: method.toUpperCase() + ' ' + path,
          path,
          method: method.toUpperCase(),
          name: typeof op.operationId === 'string' ? op.operationId : '',
          description:
            typeof op.summary === 'string'
              ? op.summary
              : typeof op.description === 'string'
                ? op.description
                : '',
          tags: Array.isArray(op.tags) ? op.tags.filter((v: unknown) => typeof v === 'string') : [],
        });
  if (rows.length > 10000) throw new Error('At most 10000 operations can be reviewed');
  return rows;
}
export function importSelection(text: string, selected: string[]) {
  if (!selected.length || selected.length > 40 || new Set(selected).size !== selected.length)
    throw new Error('Select 1–40 distinct operations');
  const doc = document(text);
  return selected.map((id) => {
    try {
      const space = id.indexOf(' '),
        method = id.slice(0, space).toLowerCase(),
        path = id.slice(space + 1);
      const item = doc.paths[path],
        op = item?.[method];
      if (!op) throw new Error('Operation not found');
      const schemas: Record<string, unknown> = {};
      const visit = (v: any, depth = 0) => {
        if (depth > 30) throw new Error('Schema reference limit exceeded');
        if (!v || typeof v !== 'object') return;
        if (v.$ref?.startsWith('#/components/schemas/')) {
          const name = v.$ref.slice(21);
          if (!Object.hasOwn(schemas, name)) {
            if (Object.keys(schemas).length >= 100) throw new Error('Too many schema references');
            schemas[name] = doc.components?.schemas?.[name];
            visit(schemas[name], depth + 1);
          }
        } else for (const child of Object.values(v)) visit(child, depth + 1);
      };
      visit(op.requestBody);
      visit(op.parameters);
      visit(item.parameters);
      const subset = {
        openapi: doc.openapi,
        security: doc.security,
        components: { securitySchemes: doc.components?.securitySchemes, schemas },
        paths: {
          [path]: {
            ...Object.fromEntries(
              ['parameters', 'servers']
                .filter((k) => item[k] !== undefined)
                .map((k) => [k, item[k]]),
            ),
            [method]: op,
          },
        },
      };
      return {
        id,
        definition: importOpenAPI(JSON.stringify(subset))[0],
        bindings: [],
        enabled: false,
      };
    } catch (error: any) {
      throw new Error(`${id}: ${error.message}`);
    }
  });
}
