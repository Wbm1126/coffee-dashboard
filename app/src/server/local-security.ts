import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface LocalSecurityOptions {
  allowedOrigins?: string[];
  csrfToken?: string;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function hostIsLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(normalized);
}

function expectedOrigins(request: FastifyRequest, extras: string[]): Set<string> {
  const host = request.headers.host ?? '';
  return new Set([`http://${host}`, `https://${host}`, ...extras]);
}

export function installLocalSecurity(
  app: FastifyInstance,
  options: LocalSecurityOptions = {},
): string {
  const csrfToken = options.csrfToken ?? randomBytes(32).toString('base64url');
  const additionalOrigins = options.allowedOrigins ?? [];

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!hostIsLoopback(host)) {
      return reply.code(403).send({ error: 'host_not_allowed' });
    }

    const origin = request.headers.origin;
    if (origin && !expectedOrigins(request, additionalOrigins).has(origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'cross_site_request' });
    }

    if (!WRITE_METHODS.has(request.method)) return;
    if (!origin) {
      return reply.code(403).send({ error: 'origin_required' });
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_required' });
    }
    const suppliedToken = request.headers['x-csrf-token'];
    if (typeof suppliedToken !== 'string' || !equalSecret(suppliedToken, csrfToken)) {
      return reply.code(403).send({ error: 'csrf_invalid' });
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });

  return csrfToken;
}

