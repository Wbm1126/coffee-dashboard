import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'auth-token' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(adminAuth?: { username: string; password: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-auth-'));
  tempDirs.push(dir);
  const repository = new JsonRepository(dir);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'auth-token', adminAuth, allowedHosts: ['coffee.hsrplan.com'] });
  return { app, repository };
}

describe('U9 Web 鉴权', () => {
  it('本地模式（未设密码）：写操作开放', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(res.json()).toMatchObject({ mode: 'local', authenticated: true });
    await app.close();
  });

  it('强制模式：未登录写操作 401', async () => {
    const { app } = await setup({ username: 'admin', password: 'secret' });
    const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(session.json()).toMatchObject({ mode: 'enforced', authenticated: false });
    const write = await app.inject({ method: 'POST', url: '/api/beans/test/follow', headers, payload: {} });
    expect(write.statusCode).toBe(401);
    expect(write.json().error).toBe('admin_required');
    await app.close();
  });

  it('强制模式：登录后写操作通过', async () => {
    const { app } = await setup({ username: 'admin', password: 'secret' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'admin', password: 'secret' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies;
    expect(cookie.some((c) => c.name === 'coffee_session')).toBe(true);
    const write = await app.inject({ method: 'POST', url: '/api/beans/test/follow', headers, cookies: Object.fromEntries(cookie.map((c) => [c.name, c.value])), payload: {} });
    expect(write.statusCode).not.toBe(401);
    await app.close();
  });

  it('强制模式：错误密码 401', async () => {
    const { app } = await setup({ username: 'admin', password: 'secret' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'admin', password: 'wrong' } });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toBe('invalid_credentials');
    await app.close();
  });

  it('强制模式：logout 撤销会话', async () => {
    const { app } = await setup({ username: 'admin', password: 'secret' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'admin', password: 'secret' } });
    const cookie = login.cookies;
    const logoutHeaders = { ...headers, cookie: cookie.map((c) => `${c.name}=${c.value}`).join('; ') };
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: logoutHeaders });
    const write = await app.inject({ method: 'POST', url: '/api/beans/test/follow', headers, cookies: Object.fromEntries(cookie.map((c) => [c.name, c.value])), payload: {} });
    expect(write.statusCode).toBe(401);
    await app.close();
  });
});
