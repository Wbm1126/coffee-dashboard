import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import { createCollectionService } from '../../src/collectors/service.js';
import { SafeUrlFetchError } from '../../src/collectors/url-policy.js';
import { sha256 } from '../../src/lib/sha256.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'collect-token' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-collectors-')); tempDirs.push(directory);
  const productHtml = await readFile(new URL('../fixtures/collectors/product-jsonld.html', import.meta.url), 'utf8');
  const searchHtml = await readFile(new URL('../fixtures/collectors/duckduckgo-results.html', import.meta.url), 'utf8');
  const service = createCollectionService({
    fetchHtml: async (url) => url.includes('duckduckgo')
      ? { html: searchHtml, finalUrl: url }
      : { html: productHtml, finalUrl: url },
  });
  const repository = new JsonRepository(directory);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token', collectionService: service });
  return { app, repository };
}

describe('collection API', () => {
  it('searches from fixture data, parses a product, previews it, and saves only after explicit confirmation', async () => {
    const { app, repository } = await setup();
    const searched = await app.inject({ method: 'POST', url: '/api/collect/search', headers, payload: { query: '山谷咖啡 日晒拼配' } });
    expect(searched.statusCode).toBe(200);
    expect(searched.json().candidates).toHaveLength(2);

    const parsed = await app.inject({ method: 'POST', url: '/api/collect/parse', headers, payload: { url: 'https://shop.example.com/bean-a' } });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json()).toMatchObject({ candidate: { fields: { brandName: '山谷咖啡', beanName: '日晒拼配', process: '日晒' } } });
    expect((await repository.read()).beans).toHaveLength(0);

    const cancelled = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: { expectedRevision: 0, action: 'cancel', candidate: parsed.json().candidate, acceptedFields: {} } });
    expect(cancelled.statusCode).toBe(200);
    expect((await repository.read()).beans).toHaveLength(0);

    const saved = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: { expectedRevision: 0, operationKey: '00000000-0000-4000-8000-000000000101', action: 'create', candidate: parsed.json().candidate,
      acceptedFields: { brandName: '山谷咖啡', beanName: '日晒拼配', roastLevel: '中深烘焙', process: '日晒', flavorNotes: ['黑巧克力', '焦糖'] } } });
    expect(saved.statusCode).toBe(201);
    const data = await repository.read();
    expect(data.beans).toHaveLength(1);
    expect(data.beans[0]).toMatchObject({ followedAt: expect.any(String), flavorNotes: ['黑巧克力', '焦糖'] });
    expect(data.productSources).toHaveLength(1);
    await app.close();
  });

  it('never mutates reviews or manually-confirmed fields when a parsed candidate is merged with an existing bean', async () => {
    const { app, repository } = await setup();
    await repository.mutate(0, (data) => {
      const now = '2026-08-15T08:00:00.000Z'; const brandId = '00000000-0000-4000-8000-000000000001'; const beanId = '00000000-0000-4000-8000-000000000002';
      data.brands.push({ id: brandId, name: '山谷咖啡', aliases: [], archivedAt: null, createdAt: now, updatedAt: now });
      data.beans.push({ id: beanId, brandId, name: '日晒拼配', normalizedKey: '山谷咖啡::日晒拼配', roastLevel: '中烘焙', process: null, flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: { roastLevel: [{ sourceKind: 'user', sourceId: 'manual', capturedAt: now, displayedText: '中烘焙' }] }, createdAt: now, updatedAt: now });
      data.assessments.push({ id: '00000000-0000-4000-8000-000000000003', beanId, grade: 'A', repurchase: 'yes', summary: '保留', basedOnDrinkingIds: [], updatedAt: now });
    });
    const parsed = await app.inject({ method: 'POST', url: '/api/collect/parse', headers, payload: { url: 'https://shop.example.com/bean-a' } });
    const merged = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: { expectedRevision: 1, operationKey: '00000000-0000-4000-8000-000000000102', action: 'merge', beanId: '00000000-0000-4000-8000-000000000002', candidate: parsed.json().candidate,
      acceptedFields: { flavorNotes: ['黑巧克力'] } } });
    expect(merged.statusCode).toBe(200);
    const data = await repository.read();
    expect(data.beans[0].roastLevel).toBe('中烘焙');
    expect(data.assessments[0]).toMatchObject({ grade: 'A', repurchase: 'yes', summary: '保留' });
    await app.close();
  });

  it('keeps failed searches and unparseable pages in the manual fallback path without changing data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coffee-collectors-failure-')); tempDirs.push(directory);
    const repository = new JsonRepository(directory);
    const unavailable = createCollectionService({ fetchHtml: async () => { throw new SafeUrlFetchError('http_status', '公开搜索暂时限流。', 429); } });
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token', collectionService: unavailable });
    const search = await app.inject({ method: 'POST', url: '/api/collect/search', headers, payload: { query: '山谷咖啡' } });
    expect(search.statusCode).toBe(429);
    expect(search.json().message).toContain('手工填写');
    expect((await repository.read()).dataRevision).toBe(0);

    const noFields = createCollectionService({ fetchHtml: async (url) => ({ html: '<div id="dynamic-root"></div>', finalUrl: url }) });
    const noFieldsApp = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token', collectionService: noFields });
    const parsed = await noFieldsApp.inject({ method: 'POST', url: '/api/collect/parse', headers, payload: { url: 'https://shop.example.com/dynamic' } });
    expect(parsed.statusCode).toBe(422);
    expect(parsed.json().message).toContain('手工填写');
    expect((await repository.read()).beans).toHaveLength(0);
    await app.close(); await noFieldsApp.close();
  });

  it('allows an offline manual fallback to create a followed bean without fabricating a product source', async () => {
    const { app, repository } = await setup();
    const saved = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: {
      expectedRevision: 0, operationKey: '00000000-0000-4000-8000-000000000103', action: 'create',
      candidate: { title: '手工 · 暮光拼配', capturedAt: '2026-08-15T08:00:00.000Z', sourceKind: 'user', fields: { brandName: '手冲实验室', beanName: '暮光拼配' } },
      acceptedFields: { brandName: '手冲实验室', beanName: '暮光拼配' },
    } });
    expect(saved.statusCode).toBe(201);
    const data = await repository.read();
    expect(data.beans).toHaveLength(1);
    expect(data.productSources).toHaveLength(0);
    expect(data.beans[0].provenance.brandName?.[0]).toMatchObject({ sourceKind: 'user', sourceId: 'collection:manual' });
    await app.close();
  });

  it('keeps a rejected private URL as inert user provenance without fetching it', async () => {
    const { app, repository } = await setup();
    const saved = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: {
      expectedRevision: 0, operationKey: '00000000-0000-4000-8000-000000000105', action: 'create',
      candidate: { sourceUrl: 'http://127.0.0.1/private', title: '手工 · 本地来源', capturedAt: '2026-08-15T08:00:00.000Z', sourceKind: 'user', fields: { brandName: '手工烘焙社', beanName: '本地来源豆' } },
      acceptedFields: { brandName: '手工烘焙社', beanName: '本地来源豆' },
    } });
    expect(saved.statusCode).toBe(201);
    expect((await repository.read()).productSources).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1/private' }),
    ]);
    await app.close();
  });

  it('records the actual committed revision when the high-water file is ahead', async () => {
    const { app, repository } = await setup();
    const highWater = 4;
    await writeFile(repository.revisionFile, `${JSON.stringify({
      revision: highWater,
      checksum: sha256(Buffer.from(`coffee-data-revision:${highWater}`, 'utf8')),
    })}\n`, 'utf8');
    const operationKey = '00000000-0000-4000-8000-000000000106';
    const saved = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: {
      expectedRevision: 0, operationKey, action: 'create',
      candidate: { title: '手工 · 高水位豆', capturedAt: '2026-08-15T08:00:00.000Z', sourceKind: 'user', fields: { brandName: '高水位烘焙社', beanName: '高水位豆' } },
      acceptedFields: { brandName: '高水位烘焙社', beanName: '高水位豆' },
    } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ dataRevision: 5 });
    expect((await repository.read()).collectionOperations).toEqual([
      expect.objectContaining({ key: operationKey, dataRevision: 5 }),
    ]);
    await app.close();
  });

  it('replays a completed confirmation after its response is lost without creating a duplicate bean', async () => {
    const { app, repository } = await setup();
    const operationKey = '00000000-0000-4000-8000-000000000104';
    const payload = {
      expectedRevision: 0,
      operationKey,
      action: 'create',
      candidate: { title: '手工 · 响应丢失豆', capturedAt: '2026-08-15T08:00:00.000Z', sourceKind: 'user', fields: { brandName: '幂等烘焙社', beanName: '响应丢失豆' } },
      acceptedFields: { brandName: '幂等烘焙社', beanName: '响应丢失豆' },
    } as const;

    const first = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload });
    expect(first.statusCode).toBe(201);
    const original = first.json() as { beanId: string; dataRevision: number };

    await repository.mutate(1, (data) => { data.preferenceProfile.updatedAt = '2026-08-15T08:01:00.000Z'; });
    const replay = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: { ...payload, expectedRevision: 2 } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ beanId: original.beanId, dataRevision: original.dataRevision, action: 'create', replayed: true });

    const data = await repository.read();
    expect(data.beans.filter((bean) => bean.name === '响应丢失豆')).toHaveLength(1);
    expect(data.collectionOperations?.filter((operation) => operation.key === operationKey)).toHaveLength(1);

    const reused = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: {
      ...payload,
      expectedRevision: data.dataRevision,
      acceptedFields: { brandName: '幂等烘焙社', beanName: '不同内容' },
    } });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: 'operation_key_reused' });
    expect((await repository.read()).beans).toHaveLength(1);
    await app.close();
  });
});
