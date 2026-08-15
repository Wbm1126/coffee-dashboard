import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
const headers = {
  host: '127.0.0.1:4173',
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-csrf-token': 'drink-token',
};

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-drinking-route-'));
  tempDirs.push(dataDir);
  const repository = new JsonRepository(dataDir);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'drink-token' });
  return { app, repository };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('catch-up and drinking API', () => {
  it('atomically creates a batch of minimal beans and factual drinking records', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/catch-up/quick',
      headers,
      payload: {
        expectedRevision: 0,
        items: [
          { brandName: '明谦', beanName: '新豆 A', drankOn: '2026-08-04', brewMethod: 'americano' },
          { brandName: '明谦', beanName: '新豆 B', drankOn: '2026-08-05', brewMethod: 'milk' },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ dataRevision: 1, created: 2 });
    const data = await repository.read();
    expect(data.brands).toHaveLength(1);
    expect(data.beans).toHaveLength(2);
    expect(data.drinkingRecords).toHaveLength(2);
    expect(data.drinkingRecords.every((record) => record.americanoReview?.state === 'unreviewed')).toBe(true);
    expect(data.drinkingRecords.every((record) => record.milkReview?.state === 'unreviewed')).toBe(true);
    await app.close();
  });

  it('creates a new active brand instead of reusing an archived matching brand', async () => {
    const { app, repository } = await fixture();
    const archivedBrandId = '00000000-0000-4000-8000-000000000021';
    await repository.mutate(0, (data) => {
      data.brands.push({
        id: archivedBrandId, name: '旧品牌', aliases: [], archivedAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      });
    });
    const response = await app.inject({
      method: 'POST', url: '/api/catch-up/quick', headers,
      payload: { expectedRevision: 1, items: [{ brandName: '旧品牌', beanName: '新豆', drankOn: '2026-08-14', brewMethod: 'americano' }] },
    });

    expect(response.statusCode).toBe(201);
    const data = await repository.read();
    expect(data.brands).toHaveLength(2);
    expect(data.brands.find((brand) => brand.id !== archivedBrandId)?.archivedAt).toBeNull();
    expect(data.beans[0]?.brandId).not.toBe(archivedBrandId);
    await app.close();
  });

  it('expires recommendation snapshots once after a quick catch-up batch', async () => {
    const { app, repository } = await fixture();
    await repository.mutate(0, (data) => {
      data.recommendationSnapshots.push({ id: 'before-quick-entry', staleAt: null });
    });
    const response = await app.inject({
      method: 'POST', url: '/api/catch-up/quick', headers,
      payload: { expectedRevision: 1, items: [
        { brandName: '测试', beanName: '补录一', drankOn: '2026-08-01', brewMethod: 'americano' },
        { brandName: '测试', beanName: '补录二', drankOn: '2026-08-02', brewMethod: 'milk' },
      ] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ dataRevision: 2, created: 2 });
    expect((await repository.read()).recommendationSnapshots[0]).toMatchObject({
      id: 'before-quick-entry', staleBecauseRevision: 2,
    });
    await app.close();
  });

  it('saves independent reviews, authoritative assessment and completes the queue item', async () => {
    const { app, repository } = await fixture();
    const quick = await app.inject({
      method: 'POST', url: '/api/catch-up/quick', headers,
      payload: { expectedRevision: 0, items: [{ brandName: '治光师', beanName: '补评豆', drankOn: '2026-08-01', brewMethod: 'milk' }] },
    });
    const created = quick.json().items[0] as { beanId: string; drinkingRecordId: string };
    const save = await app.inject({
      method: 'POST', url: '/api/drinking/save', headers,
      payload: {
        expectedRevision: 1,
        beanId: created.beanId,
        drinkingRecordId: created.drinkingRecordId,
        drankOn: '2026-08-01',
        brewMethod: 'milk',
        extractionNote: '18g / 36g',
        feeling: '榛果和焦糖',
        americanoReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
        milkReview: { state: 'reviewed', score: 4.5, flavorNotes: ['榛果'], pros: '甜感好', cons: null, note: null },
        isDraft: false,
        assessment: { grade: 'A', repurchase: 'yes', summary: '适合奶咖' },
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ dataRevision: 2, reviewComplete: true });
    const data = await repository.read();
    expect(data.assessments[0]).toMatchObject({ grade: 'A', repurchase: 'yes', summary: '适合奶咖' });
    const queue = await app.inject({ method: 'GET', url: '/api/catch-up', headers: { host: headers.host } });
    expect(queue.json()).toMatchObject({ items: [], completed: 1, total: 1 });
    await app.close();
  });

  it('rejects invalid reviewed semantics and stale revisions without a partial write', async () => {
    const { app, repository } = await fixture();
    const invalid = await app.inject({
      method: 'POST', url: '/api/drinking/save', headers,
      payload: {
        expectedRevision: 0,
        beanId: '00000000-0000-4000-8000-000000000201',
        drinkingRecordId: null,
        drankOn: '2026-08-01',
        brewMethod: 'milk',
        americanoReview: { state: 'reviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
        milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
        isDraft: false,
        assessment: null,
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect((await repository.read()).dataRevision).toBe(0);

    await repository.mutate(0, () => undefined);
    const stale = await app.inject({
      method: 'POST', url: '/api/catch-up/quick', headers,
      payload: { expectedRevision: 0, items: [{ brandName: '测试', beanName: '过期', drankOn: '2026-08-01', brewMethod: 'milk' }] },
    });
    expect(stale.statusCode).toBe(409);
    expect((await repository.read()).beans).toHaveLength(0);
    await app.close();
  });

  it('persists draft verdicts without changing the authoritative assessment, then promotes them on final save', async () => {
    const { app, repository } = await fixture();
    const quick = await app.inject({
      method: 'POST', url: '/api/catch-up/quick', headers,
      payload: { expectedRevision: 0, items: [{ brandName: '测试', beanName: '草稿豆', drankOn: '2026-08-01', brewMethod: 'milk' }] },
    });
    const created = quick.json().items[0] as { beanId: string; drinkingRecordId: string };
    const draftPayload = {
      beanId: created.beanId,
      drinkingRecordId: created.drinkingRecordId,
      drankOn: '2026-08-01',
      brewMethod: 'milk',
      americanoReview: { state: 'reviewed', score: null, flavorNotes: [], pros: null, cons: null, note: '待补分' },
      milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      assessment: { grade: 'A', repurchase: 'price_dependent', summary: '草稿总结' },
    };
    const saveDraft = await app.inject({
      method: 'POST', url: '/api/drinking/save', headers,
      payload: { ...draftPayload, expectedRevision: 1, isDraft: true },
    });

    expect(saveDraft.statusCode).toBe(200);
    expect(saveDraft.json()).toMatchObject({ dataRevision: 2, reviewComplete: false });
    let data = await repository.read();
    expect(data.assessments).toEqual([]);
    expect(data.drinkingRecords[0].draftAssessment).toEqual({
      grade: 'A', repurchase: 'price_dependent', summary: '草稿总结',
    });
    const queue = await app.inject({ method: 'GET', url: '/api/catch-up', headers: { host: headers.host } });
    expect(queue.json().items[0]).toMatchObject({
      reason: 'draft_drinking_record',
      americanoReview: { state: 'reviewed', score: null, note: '待补分' },
      assessment: { grade: 'A', repurchase: 'price_dependent', summary: '草稿总结' },
    });

    const saveFinal = await app.inject({
      method: 'POST', url: '/api/drinking/save', headers,
      payload: {
        ...draftPayload,
        expectedRevision: 2,
        isDraft: false,
        americanoReview: { ...draftPayload.americanoReview, score: 4 },
        milkReview: { ...draftPayload.milkReview, state: 'not_applicable' },
      },
    });

    expect(saveFinal.statusCode).toBe(200);
    data = await repository.read();
    expect(data.drinkingRecords[0].draftAssessment).toBeNull();
    expect(data.assessments[0]).toMatchObject({
      grade: 'A', repurchase: 'price_dependent', summary: '草稿总结',
      basedOnDrinkingIds: [created.drinkingRecordId],
    });
    await app.close();
  });

  it('does not turn an update for a missing drinking record into a duplicate create', async () => {
    const { app, repository } = await fixture();
    const quick = await app.inject({
      method: 'POST', url: '/api/catch-up/quick', headers,
      payload: { expectedRevision: 0, items: [{ brandName: '测试', beanName: '原记录', drankOn: '2026-08-01', brewMethod: 'milk' }] },
    });
    const beanId = quick.json().items[0].beanId as string;
    const missing = await app.inject({
      method: 'POST', url: '/api/drinking/save', headers,
      payload: {
        expectedRevision: 1,
        beanId,
        drinkingRecordId: '00000000-0000-4000-8000-000000000299',
        drankOn: '2026-08-02',
        brewMethod: 'milk',
        americanoReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
        milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
        isDraft: false,
        assessment: null,
      },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'drinking_record_not_found' });
    expect((await repository.read()).drinkingRecords).toHaveLength(1);
    await app.close();
  });
});
