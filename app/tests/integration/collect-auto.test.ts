import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import { createCollectionService } from '../../src/collectors/service.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'collect-token' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(options: { searchFails?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-collect-auto-'));
  tempDirs.push(directory);
  const { readFile } = await import('node:fs/promises');
  const productHtml = await readFile(new URL('../fixtures/collectors/product-jsonld.html', import.meta.url), 'utf8');
  const searchHtml = await readFile(new URL('../fixtures/collectors/duckduckgo-results.html', import.meta.url), 'utf8');
  const service = createCollectionService({
    fetchHtml: async (url) => {
      if (options.searchFails) throw new Error('network unreachable');
      if (url.includes('duckduckgo')) return { html: searchHtml, finalUrl: url };
      return { html: productHtml, finalUrl: url };
    },
  });
  const repository = new JsonRepository(directory);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token', collectionService: service });
  return { app, repository };
}

describe('统一添加入口 /api/collect/auto', () => {
  it('粘贴链接：直接解析为候选，不写入任何数据', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: 'https://shop.example.com/bean-a' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate', candidate: { fields: { brandName: '山谷咖啡', beanName: '日晒拼配' } } });
    await app.close();
  });

  it('输入品牌+豆名：服务端自动搜索并解析首选候选', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '山谷咖啡 日晒拼配' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate', searchMatched: expect.any(String), candidate: { fields: { brandName: '山谷咖啡', beanName: '日晒拼配' } } });
    await app.close();
  });

  it('搜索失败时返回 200 与手工预填，绝不阻塞创建', async () => {
    const { app, repository } = await setup({ searchFails: true });
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '乔治队长 黑猫拼配' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kind).toBe('manual');
    expect(body.fields).toMatchObject({ brandName: '乔治队长', beanName: '黑猫拼配' });
    expect(body.reason).toContain('预填');
    expect((await repository.read()).beans).toHaveLength(0);
    await app.close();
  });

  it('多行粘贴文本按第一行预填身份，其余留给人工作为描述参考', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '归吾兮 关雎\n中深烘焙，焦糖烤坚果\n限时 ¥68/227g' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'manual', fields: { brandName: '归吾兮', beanName: '关雎' } });
    await app.close();
  });

  it('品牌+豆名即可离线保存（confirm 走手工候选），无需任何联网步骤', async () => {
    const { app, repository } = await setup({ searchFails: true });
    const saved = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: {
      expectedRevision: 0,
      operationKey: '00000000-0000-4000-8000-000000000201',
      action: 'create',
      candidate: { title: '手工 · 黑猫', capturedAt: '2026-09-22T00:00:00.000Z', sourceKind: 'user', fields: { brandName: '乔治队长', beanName: '黑猫拼配' } },
      acceptedFields: { brandName: '乔治队长', beanName: '黑猫拼配' },
    } });
    expect(saved.statusCode).toBe(201);
    const data = await repository.read();
    expect(data.beans).toHaveLength(1);
    expect(data.beans[0]).toMatchObject({ name: '黑猫拼配', followedAt: expect.any(String) });
    expect(data.productSources).toHaveLength(0);
    await app.close();
  });
});
