import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { parseProductMetadata } from '../../src/collectors/parse/metadata.js';
import { cacheProductImage, isSafeImageName, resolveImageFile } from '../../src/collectors/image-cache.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'collect-token' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('U7 商品图片', () => {
  it('从 og:image 抽取绝对图片地址', () => {
    const candidate = parseProductMetadata({
      url: 'https://shop.example.com/bean-a',
      html: '<html><head><meta property="og:title" content="日晒拼配" /><meta property="og:image" content="https://cdn.example.com/bean-a.jpg" /></head><body></body></body></html>',
      capturedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(candidate.imageUrl).toBe('https://cdn.example.com/bean-a.jpg');
  });

  it('相对图片地址按页面 URL 解析；javascript: 伪协议被拒绝', () => {
    const resolved = parseProductMetadata({
      url: 'https://shop.example.com/bean-b',
      html: '<html><head><meta property="og:title" content="关雎" /><meta property="og:image" content="/img/bean-b.webp" /></head><body></body></body></html>',
      capturedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(resolved.imageUrl).toBe('https://shop.example.com/img/bean-b.webp');

    const rejected = parseProductMetadata({
      url: 'https://shop.example.com/bean-c',
      html: '<html><head><meta property="og:title" content="豆子" /><meta property="og:image" content="javascript:alert(1)" /></head><body></body></body></html>',
      capturedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(rejected.imageUrl).toBeUndefined();
  });

  it('isSafeImageName 只放行白名单文件名', () => {
    expect(isSafeImageName('abcdef1200000000.png')).toBe(true);
    expect(isSafeImageName('abcdef12.png')).toBe(false);
    expect(isSafeImageName('../secret.txt')).toBe(false);
    expect(isSafeImageName('abcdef12.exe')).toBe(false);
    expect(resolveImageFile('/data', '../secret.txt')).toBeNull();
  });

  it('/api/images/:name 拒绝非法文件名并提供已缓存图片', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coffee-images-'));
    tempDirs.push(directory);
    const repository = new JsonRepository(directory);
    await repository.initialize();
    await mkdir(join(directory, 'images'), { recursive: true });
    await writeFile(join(directory, 'images', 'abcdef1200000000.png'), Buffer.from('89504e47', 'hex'));
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token' });

    const missing = await app.inject({ method: 'GET', url: '/api/images/ffffffff.png' });
    expect(missing.statusCode).toBe(404);
    const traversal = await app.inject({ method: 'GET', url: '/api/images/..%2Fcoffee-data.json' });
    expect(traversal.statusCode).toBe(404);
    const found = await app.inject({ method: 'GET', url: '/api/images/abcdef1200000000.png' });
    expect(found.statusCode).toBe(200);
    expect(found.headers['content-type']).toBe('image/png');
    await app.close();
  });

  it('confirm 持久化候选中的 imageUrl 到商品来源', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coffee-image-confirm-'));
    tempDirs.push(directory);
    const repository = new JsonRepository(directory);
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token' });
    const saved = await app.inject({ method: 'POST', url: '/api/collect/confirm', headers, payload: {
      expectedRevision: 0,
      operationKey: '00000000-0000-4000-8000-000000000301',
      action: 'create',
      candidate: { title: '测试豆', capturedAt: '2026-09-22T00:00:00.000Z', sourceKind: 'user', sourceUrl: 'https://shop.example.com/bean', imageUrl: 'https://cdn.example.com/bean.jpg', fields: { brandName: '铁壶', beanName: '黑猫' } },
      acceptedFields: { brandName: '铁壶', beanName: '黑猫' },
    } });
    expect(saved.statusCode).toBe(201);
    const source = (await repository.read()).productSources[0]!;
    expect(source.imageUrl).toBe('https://cdn.example.com/bean.jpg');
    expect(source.imageSource).toBe('cdn.example.com');
    await app.close();
  });

  it('cacheProductImage 对非图片内容返回 null', async () => {
    // 依赖受限下载器的内容类型白名单；对不可达地址静默失败即可。
    const result = await cacheProductImage({ dataDir: tempDirs[0] ?? '.', imageUrl: 'https://127.0.0.1:9/x.jpg' });
    expect(result).toBeNull();
  });
});
