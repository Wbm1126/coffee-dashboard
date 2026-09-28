// U9 Web 鉴权（强制模式）：
// - 设置 COFFEE_DASHBOARD_ADMIN_PASSWORD 时启用：写操作要求管理员会话，访客只读；
// - 未设置时保持本地单用户行为（写操作开放），既有测试零改动。
// 会话仅存内存（重启即失效，重新登录即可）；Cookie HttpOnly + SameSite=Lax，HTTPS 下附加 Secure。
// 凭据只从环境变量读取，不写入源码/示例/测试。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'coffee_session';
export const ADMIN_USERNAME = 'admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_FAILED_LOGINS_PER_WINDOW = 10;

export interface AdminAuthOptions {
  username: string;
  password: string;
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

interface FailedLoginEntry {
  timestamps: number[];
}

export class AdminAuth {
  readonly enabled: boolean;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly failedLoginsByIp = new Map<string, FailedLoginEntry>();

  constructor(private readonly options: AdminAuthOptions) {
    this.enabled = options.password.length > 0;
  }

  private clientKey(request: FastifyRequest): string {
    return request.ip || 'unknown';
  }

  verify(username: unknown, password: unknown): boolean {
    return (
      typeof username === 'string'
      && typeof password === 'string'
      && secretsEqual(username, this.options.username)
      && secretsEqual(password, this.options.password)
    );
  }

  isThrottled(request: FastifyRequest): boolean {
    const now = Date.now();
    const entry = this.failedLoginsByIp.get(this.clientKey(request));
    if (!entry) return false;
    entry.timestamps = entry.timestamps.filter((time) => now - time < LOGIN_WINDOW_MS);
    return entry.timestamps.length >= MAX_FAILED_LOGINS_PER_WINDOW;
  }

  private recordFailure(request: FastifyRequest): void {
    const key = this.clientKey(request);
    const entry = this.failedLoginsByIp.get(key) ?? { timestamps: [] };
    entry.timestamps.push(Date.now());
    this.failedLoginsByIp.set(key, entry);
  }

  createSession(): { token: string; maxAgeSeconds: number } {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000) };
  }

  validate(token: string | undefined): boolean {
    if (!token) return false;
    const entry = this.sessions.get(token);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  readSessionToken(request: FastifyRequest): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      if (part.slice(0, separator).trim() === SESSION_COOKIE) {
        return part.slice(separator + 1).trim();
      }
    }
    return undefined;
  }

  isAuthenticated(request: FastifyRequest): boolean {
    return this.validate(this.readSessionToken(request));
  }

  applySessionCookie(reply: FastifyReply, session: { token: string; maxAgeSeconds: number }, secure: boolean): void {
    const attributes = [
      `${SESSION_COOKIE}=${session.token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${session.maxAgeSeconds}`,
    ];
    if (secure) attributes.push('Secure');
    reply.header('set-cookie', attributes.join('; '));
  }

  clearSessionCookie(reply: FastifyReply, secure: boolean): void {
    const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) attributes.push('Secure');
    reply.header('set-cookie', attributes.join('; '));
  }

  handleLogin(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    if (this.isThrottled(request)) {
      return reply.code(429).send({ error: 'login_throttled', message: '登录失败次数过多，请 15 分钟后再试。' });
    }
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    if (!this.verify(body.username, body.password)) {
      this.recordFailure(request);
      return reply.code(401).send({ error: 'invalid_credentials', message: '账号或密码不正确。' });
    }
    const session = this.createSession();
    this.applySessionCookie(reply, session, isSecureRequest(request));
    return reply.send({ authenticated: true, username: this.options.username });
  }

  handleLogout(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    this.revoke(this.readSessionToken(request));
    this.clearSessionCookie(reply, isSecureRequest(request));
    return reply.send({ authenticated: false });
  }
}

function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_PREFIX = '/api/auth/';
// 只读例外：健康检查与本地缓存图片对访客开放。
const READ_ONLY_EXCEPTIONS = new Set(['/api/health']);

export function registerAuthRoutes(app: FastifyInstance, auth: AdminAuth): void {
  app.post('/api/auth/login', async (request, reply) => auth.handleLogin(request, reply));
  app.post('/api/auth/logout', async (request, reply) => auth.handleLogout(request, reply));
  app.get('/api/auth/session', async (request) => ({
    mode: auth.enabled ? 'enforced' : 'local',
    authenticated: auth.enabled ? auth.isAuthenticated(request) : true,
    username: auth.enabled && auth.isAuthenticated(request) ? ADMIN_USERNAME : null,
  }));
}

export function registerWriteGuard(app: FastifyInstance, auth: AdminAuth): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!auth.enabled) return;
    if (!WRITE_METHODS.has(request.method)) return;
    if (request.url.startsWith(AUTH_PREFIX) || READ_ONLY_EXCEPTIONS.has(request.url.split('?')[0] ?? '')) return;
    if (auth.isAuthenticated(request)) return;
    return reply.code(401).send({ error: 'admin_required', message: '访客只读；管理员登录后才能修改数据。' });
  });
}
