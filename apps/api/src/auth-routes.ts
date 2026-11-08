import type { FastifyInstance, FastifyReply } from 'fastify';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { db } from './db.js';
import { token, hash } from './crypto.js';
import { config } from './config.js';
import { owner, fail } from './auth.js';
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((x) => x.toLowerCase().trim()),
  password: z.string().min(12).max(128),
});
async function session(reply: FastifyReply, userId: string, orgId: string) {
  const raw = token();
  await db.dashboardSession.create({
    data: { tokenHash: hash(raw), userId, orgId, expiresAt: new Date(Date.now() + 7 * 86400000) },
  });
  reply.setCookie('session', raw, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 86400,
  });
}
export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/v1/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (req.headers.origin !== config.WEB_ORIGIN) fail(403, 'Invalid dashboard origin');
      const data = credentials
        .extend({ name: z.string().min(1).max(100), organization: z.string().min(1).max(100) })
        .parse(req.body);
      const passwordHash = await argon2.hash(data.password, { type: argon2.argon2id });
      const result = await db.$transaction(async (tx) => {
        if (await tx.user.findUnique({ where: { email: data.email } }))
          fail(409, 'Unable to register this email');
        const user = await tx.user.create({
          data: { email: data.email, name: data.name, passwordHash },
        });
        const org = await tx.organization.create({ data: { name: data.organization } });
        await tx.membership.create({ data: { userId: user.id, orgId: org.id, role: 'OWNER' } });
        return { user, org };
      });
      await session(reply, result.user.id, result.org.id);
      return { ok: true };
    },
  );
  app.post(
    '/v1/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (req.headers.origin !== config.WEB_ORIGIN) fail(403, 'Invalid dashboard origin');
      const data = credentials.parse(req.body);
      const user = await db.user.findUnique({ where: { email: data.email } });
      if (!user || !(await argon2.verify(user.passwordHash, data.password)))
        fail(401, 'Invalid email or password');
      const member = await db.membership.findFirst({
        where: { userId: user.id },
        orderBy: { id: 'asc' },
      });
      if (!member) fail(403, 'No organization membership');
      await session(reply, user.id, member.orgId);
      return { ok: true };
    },
  );
  app.post('/v1/auth/logout', async (req, reply) => {
    await owner(req);
    await db.dashboardSession.deleteMany({ where: { tokenHash: hash(req.cookies.session!) } });
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });
  app.get('/v1/auth/me', async (req) => {
    const s = await owner(req);
    const user = await db.user.findUniqueOrThrow({
      where: { id: s.userId },
      select: { id: true, name: true, email: true },
    });
    const organization = await db.organization.findUnique({ where: { id: s.orgId } });
    return { ...s, user, organization, models: config.models };
  });
  app.post(
    '/v1/auth/forgot',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (req) => {
      if (req.headers.origin !== config.WEB_ORIGIN) fail(403, 'Invalid dashboard origin');
      if (!config.SMTP_URL) fail(503, 'Password reset email is not configured');
      const { email } = z
        .object({ email: z.email().transform((x) => x.toLowerCase()) })
        .parse(req.body);
      const user = await db.user.findUnique({ where: { email } });
      if (user) {
        const raw = token();
        await db.passwordReset.create({
          data: {
            userId: user.id,
            tokenHash: hash(raw),
            expiresAt: new Date(Date.now() + 1800000),
          },
        });
        await nodemailer.createTransport(config.SMTP_URL).sendMail({
          from: config.MAIL_FROM,
          to: user.email,
          subject: 'Reset your CornerstoneLabs AO password',
          text: `Reset your password within 30 minutes: ${config.WEB_ORIGIN}/?reset=${encodeURIComponent(raw)}`,
        });
      }
      return { message: 'If that account exists, a reset email has been sent.' };
    },
  );
  app.post(
    '/v1/auth/reset',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      if (req.headers.origin !== config.WEB_ORIGIN) fail(403, 'Invalid dashboard origin');
      const data = z
        .object({ token: z.string().min(30).max(100), password: z.string().min(12).max(128) })
        .parse(req.body);
      const passwordHash = await argon2.hash(data.password, { type: argon2.argon2id });
      await db.$transaction(async (tx) => {
        const reset = await tx.passwordReset.findUnique({ where: { tokenHash: hash(data.token) } });
        if (!reset || reset.expiresAt <= new Date()) fail(400, 'Reset link is invalid or expired');
        const claimed = await tx.passwordReset.deleteMany({ where: { id: reset.id } });
        if (claimed.count !== 1) fail(400, 'Reset link has already been used');
        await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
        await tx.passwordReset.deleteMany({ where: { userId: reset.userId } });
        await tx.dashboardSession.deleteMany({ where: { userId: reset.userId } });
      });
      return { ok: true };
    },
  );
}
