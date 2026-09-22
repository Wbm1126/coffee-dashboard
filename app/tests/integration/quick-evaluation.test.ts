import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { createEmptyCoffeeData, type CoffeeData } from '../../src/domain/schema.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'drink-token' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const reviewed = (score: number) => ({ state: 'reviewed', score, flavorNotes: [], pros: null, cons: null, note: null });
const unreviewed = { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null };

async function setupWithBean() {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-quick-eval-'));
  tempDirs.push(directory);
  const repository = new JsonRepository(directory);
  await repository.initialize();
  const data: CoffeeData = createEmptyCoffeeData(new Date('2026-09-22T00:00:00.000Z'));
  await repository.mutate(0, (draft) => {
    draft.beans.push({
      id: '00000000-0000-4000-8000-000000000101', brandId: null, name: '黑猫', normalizedKey: '黑猫',
      roastLevel: '中深', process: null, flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false,
      legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {},
      createdAt: data.updatedAt, updatedAt: data.updatedAt,
    });
  });
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'drink-token' });
  return { app, repository };
}

describe('U5 快速评价（单轨 + 冲煮参数）', () => {
  it('选豆+喝法+评分+一句感受即可保存完整单轨评价', async () => {
    const { app, repository } = await setupWithBean();
    const beanId = (await repository.read()).beans[0]!.id;
    const saved = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId, drinkingRecordId: null, drankOn: '2026-09-22', brewMethod: 'americano',
      extractionNote: null, feeling: '干净，回甘明显',
      americanoReview: reviewed(4), milkReview: unreviewed, isDraft: false, assessment: null,
    } });
    expect(saved.statusCode).toBe(200);
    const data = await repository.read();
    const record = data.drinkingRecords[0]!;
    expect(record).toMatchObject({ brewMethod: 'americano', feeling: '干净，回甘明显', brewParams: null });
    expect(record.americanoReview).toMatchObject({ state: 'reviewed', score: 4 });
    expect(record.milkReview).toMatchObject({ state: 'unreviewed', score: null });
    await app.close();
  });

  it('brewParams 随保存持久化，编辑其他字段时未传参数保留原值', async () => {
    const { app, repository } = await setupWithBean();
    const beanId = (await repository.read()).beans[0]!.id;
    const brewParams = { doseGrams: 15, yieldGrams: 225, brewTimeSeconds: 30, temperatureC: 92, grindSetting: '中细', waterGrams: null, milkGrams: null };
    const first = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId, drinkingRecordId: null, drankOn: '2026-09-22', brewMethod: 'americano',
      extractionNote: '一刀流', brewParams, feeling: '均衡',
      americanoReview: reviewed(4), milkReview: unreviewed, isDraft: false, assessment: null,
    } });
    expect(first.statusCode).toBe(200);
    const recordId = (await repository.read()).drinkingRecords[0]!.id;
    expect((await repository.read()).drinkingRecords[0]!.brewParams).toMatchObject({ doseGrams: 15, temperatureC: 92, grindSetting: '中细' });

    const second = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 2, beanId, drinkingRecordId: recordId, drankOn: '2026-09-22', brewMethod: 'americano',
      extractionNote: '改水流', feeling: '更干净',
      americanoReview: reviewed(4.5), milkReview: unreviewed, isDraft: false, assessment: null,
    } });
    expect(second.statusCode).toBe(200);
    const after = (await repository.read()).drinkingRecords[0]!;
    expect(after.feeling).toBe('更干净');
    expect(after.brewParams).toMatchObject({ doseGrams: 15, temperatureC: 92 });
    await app.close();
  });

  it('非法冲煮参数（负粉量/越界水温）返回 422 且数据不写入', async () => {
    const { app, repository } = await setupWithBean();
    const beanId = (await repository.read()).beans[0]!.id;
    const saved = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId, drinkingRecordId: null, drankOn: '2026-09-22', brewMethod: 'milk',
      extractionNote: null, brewParams: { doseGrams: -3, temperatureC: 999 }, feeling: null,
      americanoReview: unreviewed, milkReview: reviewed(3), isDraft: false, assessment: null,
    } });
    expect(saved.statusCode).toBe(422);
    expect((await repository.read()).drinkingRecords).toHaveLength(0);
    await app.close();
  });

  it('奶咖轨只评奶咖：美式轨保持未评价，不按零分处理', async () => {
    const { app, repository } = await setupWithBean();
    const beanId = (await repository.read()).beans[0]!.id;
    const saved = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId, drinkingRecordId: null, drankOn: '2026-09-22', brewMethod: 'milk',
      extractionNote: null, feeling: '奶咖顺滑',
      americanoReview: unreviewed, milkReview: reviewed(3.5), isDraft: false, assessment: null,
    } });
    expect(saved.statusCode).toBe(200);
    const record = (await repository.read()).drinkingRecords[0]!;
    expect(record.americanoReview).toMatchObject({ state: 'unreviewed', score: null });
    expect(record.milkReview).toMatchObject({ state: 'reviewed', score: 3.5 });
    await app.close();
  });
});
