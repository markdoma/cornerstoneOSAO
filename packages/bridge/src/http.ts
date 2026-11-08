import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { validateValue, type ToolDefinition } from '@orchestrator/core';
export function publicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
function demoAllowed(url: URL) {
  const bases = process.env.ALLOW_LOCAL_DEMO_API?.split(',').map((base) => base.trim()) ?? [];
  return (
    process.env.NODE_ENV !== 'production' &&
    bases.some((base) => base && (url.href === base || url.href.startsWith(base + '/'))) &&
    url.hostname === '127.0.0.1' &&
    url.protocol === 'http:' &&
    !url.username &&
    !url.password
  );
}
export async function verifyDestination(raw: string, resolver = lookup) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.search)
    throw new Error('API URL cannot contain credentials, fragments, or query parameters');
  if (demoAllowed(url)) return [{ address: '127.0.0.1', family: 4 }];
  if (url.protocol !== 'https:') throw new Error('Application API destinations require HTTPS');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new Error('API destination must resolve exclusively to public addresses');
  return addresses;
}
export function buildToolUrl(baseUrl: string, tool: ToolDefinition, args: any) {
  validateValue(tool.schema, args);
  const path = tool.path.replace(/\{([\w-]+)\}/g, (_, k) => {
    const v = String(args.path[k]);
    if (v === '.' || v === '..' || /[/\\%\u0000-\u001f]/.test(v))
      throw new Error('Unsafe path parameter');
    return encodeURIComponent(v);
  });
  const base = new URL(baseUrl);
  const url = new URL(base.href.replace(/\/$/, '') + path);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')
  )
    throw new Error('Tool path escapes the configured connection');
  for (const [k, v] of Object.entries(args.query ?? {})) url.searchParams.set(k, String(v));
  return url;
}
export function redact(value: unknown, secrets: string[] = []): any {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|secret|authorization|credential|access.?token|refresh.?token|api.?key/i.test(k)
          ? '[REDACTED]'
          : redact(v, secrets),
      ]),
    );
  return value;
}
export async function callJsonEndpoint(
  baseUrl: string,
  tool: ToolDefinition,
  args: unknown,
  bearer: string,
  executionId: string,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
) {
  const body = (args as any).body;
  const url = buildToolUrl(baseUrl, tool, args);
  const check = new URL(url);
  check.search = '';
  const addresses = await verifyDestination(check.href);
  const dispatcher = new Agent({
    connect: {
      lookup: ((_hostname: any, options: any, callback: any) => {
        const resolved = addresses[0];
        if (options.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      }) as any,
    },
  });
  try {
    const headers: Record<string, string> = {
      ...extraHeaders,
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (tool.idempotencyHeader) headers[tool.idempotencyHeader] = executionId;
    const response = await request(url, {
      method: tool.method,
      dispatcher,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      maxRedirections: 0,
      signal,
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump();
      throw new Error(
        response.statusCode === 401 || response.statusCode === 403
          ? 'Connected API denied access; sign in again or check your permissions'
          : `Connected API returned HTTP ${response.statusCode}; the operation was not retried`,
      );
    }
    if (response.statusCode === 204) {
      await response.body.dump();
      return { success: true };
    }
    if (!String(response.headers['content-type']).includes('application/json')) {
      await response.body.dump();
      throw new Error('Connected API must return application/json');
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 256000) {
        response.body.destroy();
        throw new Error('Connected API response exceeds 256 KB');
      }
      chunks.push(Buffer.from(chunk));
    }
    return redact(JSON.parse(Buffer.concat(chunks).toString('utf8')), [bearer]);
  } finally {
    await dispatcher.close();
  }
}
