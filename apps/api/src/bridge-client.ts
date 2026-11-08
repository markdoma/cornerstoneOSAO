import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { WidgetSession } from '@prisma/client';
import { checkSchema, validateValue } from '@orchestrator/core';
import { bridgeSigner } from '../../../packages/bridge/src/auth.js';
import {
  type BridgeGrant,
  fingerprint,
  serviceError,
} from '../../../packages/bridge/src/contracts.js';
import { config } from './config.js';
import { db } from './db.js';
let signer: ReturnType<typeof bridgeSigner> | undefined;
function enabled() {
  if (!config.MCP_BRIDGE_ENABLED) throw serviceError(503, 'MCP bridge is disabled');
  if (!config.BRIDGE_PRIVATE_KEY_PATH) throw serviceError(503, 'Configure bridge signing keys');
}
async function signed(g: BridgeGrant) {
  enabled();
  signer ??= bridgeSigner(config.BRIDGE_PRIVATE_KEY_PATH!, config.BRIDGE_SIGNING_KID);
  return (await signer)(g);
}
export async function bridgeControl(
  path: string,
  g: BridgeGrant,
  body: unknown = {},
  signal?: AbortSignal,
) {
  const response = await fetch(new URL(path, config.BRIDGE_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${await signed(g)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
  }).catch(() => {
    throw serviceError(503, 'Managed bridge is unavailable');
  });
  if (!response.ok)
    throw serviceError(
      response.status === 401 ? 401 : 503,
      'Bridge credentials or configuration are unavailable',
    );
  return response.json();
}
export function sessionGrant(
  session: WidgetSession,
  revisionIds: string[],
  purpose: BridgeGrant['purpose'] = 'mcp',
): BridgeGrant {
  if (!session.tenantId) throw serviceError(401, 'Verified application tenant required');
  return {
    purpose,
    orgId: session.orgId,
    tenantId: session.tenantId,
    userId: session.userId,
    deploymentId: session.deploymentId,
    versionId: session.versionId,
    sessionId: session.id,
    toolIds: session.toolIds,
    revisionIds,
    bindingId: session.credentialHandle ?? undefined,
  };
}
export async function revokeBridgeCredential(session: WidgetSession) {
  if (!session.credentialHandle) return;
  await bridgeControl('/control/revoke', sessionGrant(session, [], 'revoke'));
}
export type McpTool = {
  name: string;
  schema: any;
  bridgeRevisionId: string;
  bridgeOperationId: string;
  bridgeFingerprint: string;
  kind: string;
};
async function clientFor(g: BridgeGrant, signal: AbortSignal) {
  const token = await signed(g);
  const client = new Client(
    { name: 'cornerstonelabs-ao', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      jsonSchemaValidator: {
        getValidator: (raw: any) => {
          const schema = checkSchema(raw);
          return (input: unknown) => {
            try {
              validateValue(schema, input);
              return { valid: true, data: input };
            } catch (e: any) {
              return { valid: false, errorMessage: e.message };
            }
          };
        },
      } as any,
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', config.BRIDGE_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal },
    onInsufficientScope: 'throw',
  });
  try {
    await client.connect(transport);
  } catch (error: any) {
    await client.close().catch(() => {});
    throw serviceError(
      error.code === 401 || String(error.message).includes('401') ? 401 : 503,
      'Managed bridge or application credentials are unavailable',
    );
  }
  return client;
}
export async function discoverBridgeTools(
  session: WidgetSession,
  tools: McpTool[],
  signal: AbortSignal,
) {
  const revisions = [...new Set(tools.map((t) => t.bridgeRevisionId))];
  if (!revisions.length) return [];
  const client = await clientFor(sessionGrant(session, revisions), signal);
  try {
    const listed = await client.listTools();
    return tools.map((t) => {
      const match = listed.tools.find(
        (x) => x.name === t.name && x._meta?.revisionId === t.bridgeRevisionId,
      );
      if (
        !match ||
        match._meta?.fingerprint !== t.bridgeFingerprint ||
        match._meta?.operationId !== t.bridgeOperationId ||
        fingerprint(match.inputSchema) !== fingerprint(t.schema)
      )
        throw serviceError(409, 'Published MCP tool differs from the bridge revision');
      return t;
    });
  } finally {
    await client.close();
  }
}
export async function callBridgeTool(
  session: WidgetSession,
  tool: McpTool,
  args: unknown,
  executionId: string,
  signal: AbortSignal,
  conversationId: string,
) {
  const g = {
    ...sessionGrant(session, [tool.bridgeRevisionId]),
    operationId: tool.bridgeOperationId,
    executionId,
    conversationId,
    digest: fingerprint(args),
    approved: tool.kind === 'write',
  };
  const client = await clientFor(g, signal);
  try {
    const result = await client.callTool({ name: tool.name, arguments: args as any }, { signal });
    if (result.isError) throw new Error('MCP application action failed; it was not retried');
    const text = result.content?.find((x: any) => x.type === 'text') as any;
    if (!text?.text) throw new Error('MCP result did not contain JSON');
    return JSON.parse(text.text);
  } finally {
    await client.close();
  }
}
export async function deploymentMode(deployment: {
  authMode: string;
  versionId: string;
  orgId: string;
}) {
  if (deployment.authMode !== 'auto') return deployment.authMode;
  return config.FIRST_PARTY_JWKS_URL ? 'hris-jwt' : 'exchange';
}
export async function bridgeHealth() {
  return bridgeControl('/control/health', {
    purpose: 'health',
    orgId: 'platform',
    tenantId: '',
    userId: '',
    deploymentId: '',
    versionId: '',
    sessionId: '',
    toolIds: [],
    revisionIds: [],
  });
}
