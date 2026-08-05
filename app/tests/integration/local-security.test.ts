import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installLocalSecurity } from '../../src/server/local-security.js';

function securityFixture() {
  const app = Fastify();
  const token = installLocalSecurity(app, { csrfToken: 'test-token' });
  app.post('/write', async () => ({ ok: true }));
  return { app, token };
}

describe('local API security', () => {
  it('accepts a same-origin JSON write with a valid token', async () => {
    const { app, token } = securityFixture();
    const response = await app.inject({
      method: 'POST',
      url: '/write',
      headers: {
        host: '127.0.0.1:4173',
        origin: 'http://127.0.0.1:4173',
        'content-type': 'application/json',
        'x-csrf-token': token,
      },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    ['hostile host', { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json', 'x-csrf-token': 'test-token' }],
    ['hostile origin', { host: '127.0.0.1:4173', origin: 'https://evil.example', 'content-type': 'application/json', 'x-csrf-token': 'test-token' }],
    ['missing csrf', { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }],
    ['non json', { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'text/plain', 'x-csrf-token': 'test-token' }],
  ])('rejects %s', async (_label, headers) => {
    const { app } = securityFixture();
    const response = await app.inject({ method: 'POST', url: '/write', headers, payload: '{}' });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });
});

