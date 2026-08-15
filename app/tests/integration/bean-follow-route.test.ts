import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('bean follow API', () => {
  it('persists a follow fact and rejects stale revisions without changing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coffee-bean-follow-')); tempDirs.push(directory);
    const repository = new JsonRepository(directory);
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'follow-token' });
    const quick = await app.inject({ method: 'POST', url: '/api/catch-up/quick', headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'follow-token',
    }, payload: { expectedRevision: 0, items: [{ brandName: '测试社', beanName: '关注豆', drankOn: '2026-08-07', brewMethod: 'other' }] } });
    const beanId = quick.json().items[0].beanId as string;

    const followed = await app.inject({ method: 'POST', url: `/api/beans/${beanId}/follow`, headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'follow-token',
    }, payload: { expectedRevision: 1 } });
    expect(followed.statusCode).toBe(200);
    expect(followed.json()).toMatchObject({ dataRevision: 2, followed: true });
    const followedAt = (await repository.read()).beans[0]!.followedAt;
    expect(followedAt).not.toBeNull();

    const stale = await app.inject({ method: 'POST', url: `/api/beans/${beanId}/follow`, headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'follow-token',
    }, payload: { expectedRevision: 1 } });
    expect(stale.statusCode).toBe(409);
    expect((await repository.read()).beans[0]!.followedAt).toBe(followedAt);
    await app.close();
  });
});
