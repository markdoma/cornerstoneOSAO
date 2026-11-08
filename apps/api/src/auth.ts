import { deploymentMode } from './bridge-client.js';
import { firstPartyContext, firstPartySession } from './first-party.js';
import type { FastifyRequest } from 'fastify';
import type { WidgetSession } from '@prisma/client';
import { db } from './db.js';
import { hash } from './crypto.js';
import { config } from './config.js';
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status });
}
export async function owner(req: FastifyRequest, ownerOnly = false) {
  const raw = req.cookies.session;
  if (!raw) fail(401, 'Sign in to continue');
  const s = await db.dashboardSession.findUnique({ where: { tokenHash: hash(raw) } });
  if (!s || s.expiresAt <= new Date()) fail(401, 'Session expired');
  const member = await db.membership.findUnique({
    where: { userId_orgId: { userId: s.userId, orgId: s.orgId } },
  });
  if (!member || (ownerOnly && member.role !== 'OWNER')) fail(403, 'Organization access denied');
  if (
    (req.headers.origin && req.headers.origin !== config.WEB_ORIGIN) ||
    (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.WEB_ORIGIN)
  )
    fail(403, 'Invalid dashboard origin');
  return { userId: s.userId, orgId: s.orgId, role: member.role };
}
export async function activeSession(id: string): Promise<WidgetSession> {
  if (id.startsWith('firstparty:')) return firstPartySession(id);
  const s = await db.widgetSession.findUnique({ where: { id } });
  if (!s || s.revokedAt || s.expiresAt <= new Date() || (!s.credential && !s.credentialHandle))
    fail(401, 'Assistant session expired; sign in again');
  const deployment = await db.deployment.findFirst({
    where: { id: s.deploymentId, orgId: s.orgId, active: true },
  });
  if (
    !deployment ||
    (!deployment.origins.includes(s.origin) &&
      !(s.origin === config.WEB_ORIGIN && s.userId.startsWith('preview:'))) ||
    deployment.versionId !== s.versionId
  )
    fail(401, 'Assistant deployment is unavailable');
  const mode = await deploymentMode(deployment);
  if (mode === 'hris-jwt') fail(401, 'Direct HRIS JWT required');
  if (
    mode === 'bridge-session' &&
    (!config.MCP_BRIDGE_ENABLED || !s.credentialHandle || !s.tenantId)
  )
    fail(401, 'Bridge session unavailable');
  const version = await db.agentVersion.findFirst({ where: { id: s.versionId, orgId: s.orgId } });
  if (
    !version ||
    !(await db.agent.findFirst({ where: { id: version.agentId, orgId: s.orgId, archived: false } }))
  )
    fail(401, 'Assistant is unavailable');
  return s;
}
export async function widget(req: FastifyRequest) {
  const context = firstPartyContext();
  if (context) return firstPartySession(context.session.id);
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) fail(401, 'Assistant authentication required');
  const candidate = await db.widgetSession.findUnique({
    where: { tokenHash: hash(auth.slice(7)) },
  });
  if (!candidate) fail(401, 'Invalid assistant session');
  const s = await activeSession(candidate.id);
  if (
    (req.headers['x-deployment-id'] !== undefined &&
      req.headers['x-deployment-id'] !== s.deploymentId) ||
    req.headers['x-host-origin'] !== s.origin ||
    (req.headers.origin && ![s.origin, config.WIDGET_ORIGIN].includes(req.headers.origin))
  )
    fail(403, 'Invalid embedding origin');
  return s;
}
export async function conversationAccess(id: string, s: WidgetSession) {
  const c = await db.conversation.findFirst({
    where: {
      id,
      orgId: s.orgId,
      deploymentId: s.deploymentId,
      versionId: s.versionId,
      userId: s.userId,
    },
  });
  if (!c) fail(404, 'Conversation not found');
  return c;
}
