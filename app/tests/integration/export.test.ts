import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
const dirs: string[] = []; const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'export-token' };
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
describe('export API', () => {
it('freezes a markdown report and keeps it readable after later data changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-export-')); dirs.push(dir); const repository = new JsonRepository(dir); const app = await buildApp({ repository, serveStatic: false, csrfToken: 'export-token' });
  const quick = await app.inject({ method: 'POST', url: '/api/catch-up/quick', headers, payload: { expectedRevision: 0, items: [{ brandName: '山谷咖啡', beanName: '长风味豆', drankOn: '2026-08-15', brewMethod: 'americano' }] } });
  const beanId = quick.json().items[0].beanId as string;
  const exported = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: { expectedRevision: 1, beanIds: [beanId], filters: { roast: '中深烘焙' }, sort: { field: 'name', direction: 'asc' }, formats: ['markdown'] } });
  expect(exported.statusCode).toBe(200); expect(exported.json()).toMatchObject({ snapshot: { beanIds: [beanId], dataRevision: 1 }, artifacts: { markdown: expect.stringMatching(/\.md$/) } });
  const markdown = await app.inject({ method: 'GET', url: exported.json().artifacts.markdown });
  expect(markdown.statusCode).toBe(200); expect(markdown.body).toContain('快照标识'); expect(markdown.body).toContain('山谷咖啡');
  const afterExport = await repository.read();
  expect(afterExport.exportSnapshots).toHaveLength(1);
  expect(afterExport.exportSnapshots[0]).toMatchObject({ reportBeans: [{ id: beanId, name: '长风味豆' }] });

  const changed = await repository.mutate(afterExport.dataRevision, (draft) => {
    const bean = draft.beans.find((item) => item.id === beanId)!;
    bean.name = '后来改名的豆';
    bean.updatedAt = new Date().toISOString();
  });
  const retried = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: {
    expectedRevision: changed.dataRevision,
    beanIds: [beanId],
    filters: { roast: '中深烘焙' },
    sort: { field: 'name', direction: 'asc' },
    formats: ['markdown'],
    snapshotId: exported.json().snapshot.id,
  } });
  expect(retried.statusCode).toBe(200);
  const retriedMarkdown = await app.inject({ method: 'GET', url: retried.json().artifacts.markdown });
  expect(retriedMarkdown.body).toBe(markdown.body);
  expect(retriedMarkdown.body).not.toContain('后来改名的豆');
  expect((await repository.read()).dataRevision).toBe(changed.dataRevision);
  await app.close();
});

it('upgrades a legacy snapshot when no report facts changed after its creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-export-legacy-')); dirs.push(dir); const repository = new JsonRepository(dir); const app = await buildApp({ repository, serveStatic: false, csrfToken: 'export-token' });
  const quick = await app.inject({ method: 'POST', url: '/api/catch-up/quick', headers, payload: { expectedRevision: 0, items: [{ brandName: '兼容咖啡', beanName: '旧快照豆', drankOn: '2026-08-15', brewMethod: 'milk' }] } });
  const beanId = quick.json().items[0].beanId as string;
  const snapshotId = '00000000-0000-4000-8000-000000000099';
  const withLegacySnapshot = await repository.mutate(1, (draft) => {
    draft.exportSnapshots.push({
      id: snapshotId,
      dataRevision: 1,
      generatedAt: '2026-08-15T09:00:00.000Z',
      beanIds: [beanId],
      filters: {},
      sort: { field: 'name', direction: 'asc' },
    });
  });

  const retried = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: {
    expectedRevision: withLegacySnapshot.dataRevision,
    beanIds: [beanId],
    formats: ['markdown'],
    snapshotId,
  } });
  expect(retried.statusCode).toBe(200);
  expect((await repository.read()).exportSnapshots[0]).toMatchObject({
    id: snapshotId,
    reportBeans: [{ id: beanId, name: '旧快照豆' }],
  });
  await app.close();
});

it('serves markdown and a valid PDF from one immutable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-export-both-')); dirs.push(dir);
  const repository = new JsonRepository(dir);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'export-token' });
  const quick = await app.inject({ method: 'POST', url: '/api/catch-up/quick', headers, payload: {
    expectedRevision: 0,
    items: [{ brandName: '双格式咖啡', beanName: '同一快照豆', drankOn: '2026-08-15', brewMethod: 'americano' }],
  } });
  const beanId = quick.json().items[0].beanId as string;
  const exported = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: {
    expectedRevision: 1,
    beanIds: [beanId],
    filters: { exportScope: '当前筛选结果', roast: '中深烘焙' },
    sort: { field: 'name', direction: 'asc' },
    formats: ['markdown', 'pdf'],
  } });

  expect(exported.statusCode).toBe(200);
  const result = exported.json() as {
    snapshot: { id: string; dataRevision: number; beanIds: string[]; filters: Record<string, string> };
    dataRevision: number;
    artifacts: { markdown: string; pdf: string };
  };
  expect(result.snapshot).toMatchObject({ dataRevision: 1, beanIds: [beanId], filters: { exportScope: '当前筛选结果', roast: '中深烘焙' } });
  expect(result.dataRevision).toBe(2);
  expect(result.artifacts.markdown).toContain(result.snapshot.id);
  expect(result.artifacts.pdf).toContain(result.snapshot.id);

  const [markdown, pdf] = await Promise.all([
    app.inject({ method: 'GET', url: result.artifacts.markdown }),
    app.inject({ method: 'GET', url: result.artifacts.pdf }),
  ]);
  expect(markdown.statusCode).toBe(200);
  expect(markdown.body).toContain(result.snapshot.id);
  expect(markdown.body).toContain(`数据版本：${result.snapshot.dataRevision}`);
  expect(markdown.body).toContain('当前筛选结果');
  expect(pdf.statusCode).toBe(200);
  expect(pdf.headers['content-type']).toBe('application/pdf');
  const pdfBytes = pdf.rawPayload;
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdfBytes.subarray(-6).toString()).toMatch(/%%EOF\s*$/);
  expect(pdfBytes.byteLength).toBeGreaterThan(5_000);
  await app.close();
});

it('allows concurrent retries of the same snapshot without sharing a temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-export-concurrent-')); dirs.push(dir);
  const repository = new JsonRepository(dir);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'export-token' });
  const quick = await app.inject({ method: 'POST', url: '/api/catch-up/quick', headers, payload: {
    expectedRevision: 0,
    items: [{ brandName: '并发咖啡', beanName: '重试豆', drankOn: '2026-08-15', brewMethod: 'milk' }],
  } });
  const beanId = quick.json().items[0].beanId as string;
  const first = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: {
    expectedRevision: 1, beanIds: [beanId], formats: ['markdown'],
  } });
  expect(first.statusCode).toBe(200);
  const { snapshot, dataRevision } = first.json() as { snapshot: { id: string }; dataRevision: number };
  const retryPayload = { expectedRevision: dataRevision, beanIds: [beanId], formats: ['markdown'], snapshotId: snapshot.id };

  const retries = await Promise.all(Array.from({ length: 4 }, () => app.inject({
    method: 'POST', url: '/api/exports', headers, payload: retryPayload,
  })));
  expect(retries.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
  expect(retries.map((response) => response.json().snapshot.id)).toEqual(Array(4).fill(snapshot.id));
  const artifact = await app.inject({ method: 'GET', url: retries[0]!.json().artifacts.markdown });
  expect(artifact.statusCode).toBe(200);
  expect(artifact.body).toContain(snapshot.id);
  await app.close();
});
});
