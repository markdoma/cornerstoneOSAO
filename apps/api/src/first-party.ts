import { deploymentMode } from './bridge-client.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WidgetSession } from '@prisma/client';
import { remoteVerifier, type UserContext } from '../../../packages/delegation/src/index.js';
import { config } from './config.js';
import { db } from './db.js';
import { hash } from './crypto.js';
type Context = { raw: string; claims: UserContext; session: WidgetSession };
const contexts = new AsyncLocalStorage<{ value?: Context }>();
export const requestContext = (_req: any, _reply: any, done: () => void) => contexts.run({}, done);
const revoked = new Map<string, number>();
const mappings: Record<string, string> = JSON.parse(config.FIRST_PARTY_TENANT_ORGS);
const verify = config.FIRST_PARTY_JWKS_URL
  ? remoteVerifier(config.FIRST_PARTY_JWKS_URL, config.NODE_ENV !== 'production')
  : undefined;
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
export const firstPartyContext = () => contexts.getStore()?.value;
export function revokeFirstParty() {
  const current = contexts.getStore()?.value;
  if (current) revoked.set(hash(current.raw), current.claims.exp * 1000);
}
export async function firstPartySession(id: string) {
  const current = contexts.getStore()?.value;
  if (
    !current ||
    current.session.id !== id ||
    current.claims.exp * 1000 <= Date.now() ||
    revoked.has(hash(current.raw))
  )
    fail(401, 'Assistant session expired');
  const dep = await db.deployment.findFirst({
    where: {
      id: current.session.deploymentId,
      orgId: current.session.orgId,
      active: true,
      versionId: current.session.versionId,
    },
  });
  if (
    !dep ||
    (await deploymentMode(dep)) !== 'hris-jwt' ||
    !dep.origins.includes(current.session.origin)
  )
    fail(401, 'Assistant deployment is unavailable');
  const version = await db.agentVersion.findFirst({
    where: { id: dep.versionId, orgId: dep.orgId },
  });
  if (
    !version ||
    !(await db.agent.findFirst({
      where: { id: version.agentId, orgId: dep.orgId, archived: false },
    }))
  )
    fail(401, 'Assistant unavailable');
  return current.session;
}
export async function authenticateFirstParty(req: any) {
  if (!verify) return;
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) fail(401, 'User context required');
  const raw = auth.slice(7);
  const claims = await verify(raw);
  for (const [key, exp] of revoked) if (exp <= Date.now()) revoked.delete(key);
  if (revoked.has(hash(raw))) fail(401, 'Assistant session revoked');
  const orgId = Object.hasOwn(mappings, claims.tenant_id) ? mappings[claims.tenant_id] : undefined;
  if (!orgId) fail(403, 'Tenant is not connected');
  const deploymentId = req.headers['x-deployment-id'];
  const origin = req.headers['x-host-origin'];
  const dep = await db.deployment.findFirst({
    where: { id: typeof deploymentId === 'string' ? deploymentId : '', orgId, active: true },
  });
  if (
    !dep ||
    (await deploymentMode(dep)) !== 'hris-jwt' ||
    !dep.origins.includes(origin) ||
    (req.headers.origin && ![origin, config.WIDGET_ORIGIN].includes(req.headers.origin))
  )
    fail(403, 'Deployment or origin denied');
  const version = await db.agentVersion.findFirst({ where: { id: dep.versionId, orgId } });
  if (
    !version ||
    !(await db.agent.findFirst({ where: { id: version.agentId, orgId, archived: false } }))
  )
    fail(403, 'Agent unavailable');
  const tools = (version.config as any).tools as { id: string; name: string }[];
  const permitted = tools.filter((t) => claims.scopes.includes(`tool:${t.name}`));
  const enabled = await db.tool.findMany({
    where: { orgId, id: { in: permitted.map((t) => t.id) }, enabled: true },
    select: { id: true },
  });
  // Request-local synthetic session. Neither the JWT nor a token hash is persisted to AO.
  const session: WidgetSession = {
    id: `firstparty:${hash(raw)}`,
    tokenHash: '',
    credentialHandle: null,
    tenantId: claims.tenant_id,
    employeeId: null,
    orgId: orgId!,
    deploymentId: dep.id,
    versionId: version.id,
    userId: claims.sub,
    origin,
    toolIds: enabled.map((t) => t.id),
    credential: null,
    expiresAt: new Date(claims.exp * 1000),
    revokedAt: null,
    createdAt: new Date(claims.iat * 1000),
  };
  contexts.getStore()!.value = { raw, claims, session };
}
