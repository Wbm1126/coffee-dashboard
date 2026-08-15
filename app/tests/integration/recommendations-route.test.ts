import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { generateRecommendationSnapshot } from '../../src/recommendation/engine.js';
import { RECOMMENDATION_RULE_VERSION } from '../../src/recommendation/rules.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import { sha256 } from '../../src/lib/sha256.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'recommend-token' };
const NOW = '2026-08-07T08:00:00.000Z';
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-recommendations-')); tempDirs.push(directory);
  const repository = new JsonRepository(directory);
  await repository.initialize();
  await repository.mutate(0, (data) => {
    data.brands.push({ id: uuid(1), name: '推荐测试社', aliases: [], archivedAt: null, createdAt: NOW, updatedAt: NOW });
    data.beans.push({ id: uuid(2), brandId: uuid(1), name: '低酸奶咖豆', normalizedKey: '推荐测试社\u0000低酸奶咖豆', roastLevel: '中深烘焙', process: null,
      flavorNotes: ['巧克力'], followedAt: NOW, archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null,
      importedFacts: { overallScoreRaw: null, preferenceMatchRaw: null, recommendationRaw: null, referencePrice: { amount: 68, currency: 'CNY' },
        pricePerGram: 0.68, packageGrams: 100, originOrVariety: null, officialFlavorDescription: '低酸巧克力', americanoPerformance: null,
        milkPerformance: '适合奶咖', suitableScenes: ['奶咖'], legacyNote: null, legacyScoreBasisRaw: null }, provenance: {}, createdAt: NOW, updatedAt: NOW });
  });
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'recommend-token' });
  return { app, repository };
}

describe('recommendations API', () => {
  it('saves preferences, stales the previous snapshot, and refreshes locally without immediately staling the new snapshot', async () => {
    const { app, repository } = await setup();
    const initial = await repository.read();
    const previous = generateRecommendationSnapshot(initial, { id: uuid(10), generatedAt: NOW, dataRevision: initial.dataRevision + 1 });
    await repository.mutate(initial.dataRevision, (data) => { data.recommendationSnapshots.push(previous); });

    const saved = await app.inject({ method: 'PUT', url: '/api/recommendations/preferences', headers, payload: {
      expectedRevision: 2, brewMode: 'milk', acidityPreference: 'low', roastLevels: ['中深烘焙'], flavorNotes: ['巧克力'],
      avoidedFlavorNotes: ['烟熏'], maxPricePer100g: 80,
    } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ dataRevision: 3, preferenceProfile: { brewMode: 'milk', acidityPreference: 'low' } });
    expect((await repository.read()).recommendationSnapshots[0]).toMatchObject({ staleBecauseRevision: 3 });
    const staleView = await app.inject({ method: 'GET', url: '/api/recommendations', headers: { host: headers.host } });
    expect(staleView.json()).toMatchObject({ dataRevision: 3, stale: true, snapshot: { staleBecauseRevision: 3 } });

    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network must not be used'); }));
    const refreshed = await app.inject({ method: 'POST', url: '/api/recommendations/refresh', headers, payload: { expectedRevision: 3 } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ dataRevision: 4, snapshot: { dataRevision: 4, ruleVersion: RECOMMENDATION_RULE_VERSION, staleAt: null } });
    expect(refreshed.json().snapshot.worthTrying[0]).toMatchObject({ beanId: uuid(2) });
    const stored = await repository.read();
    expect(stored.recommendationSnapshots.at(-1)).toMatchObject({ dataRevision: stored.dataRevision, staleAt: null, staleBecauseRevision: null });
    expect(stored.recommendationSnapshots).toHaveLength(1);

    const current = await app.inject({ method: 'GET', url: '/api/recommendations', headers: { host: headers.host } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ dataRevision: 4, stale: false, snapshot: { dataRevision: 4 } });
    await app.close();
  });

  it('rejects stale preference and refresh writes with 409 and leaves current data unchanged', async () => {
    const { app, repository } = await setup();
    const preferenceConflict = await app.inject({ method: 'PUT', url: '/api/recommendations/preferences', headers, payload: {
      expectedRevision: 0, brewMode: 'americano', acidityPreference: 'any', roastLevels: [], flavorNotes: [], avoidedFlavorNotes: [], maxPricePer100g: null,
    } });
    expect(preferenceConflict.statusCode).toBe(409);
    expect(preferenceConflict.json().message).toContain('偏好没有保存');
    const refreshConflict = await app.inject({ method: 'POST', url: '/api/recommendations/refresh', headers, payload: { expectedRevision: 0 } });
    expect(refreshConflict.statusCode).toBe(409);
    expect(refreshConflict.json().message).toContain('推荐没有刷新');
    expect((await repository.read()).dataRevision).toBe(1);
    await app.close();
  });

  it('uses the persisted revision high water in refreshed snapshot metadata', async () => {
    const { app, repository } = await setup();
    const highWater = 5;
    await writeFile(repository.revisionFile, `${JSON.stringify({
      revision: highWater,
      checksum: sha256(Buffer.from(`coffee-data-revision:${highWater}`, 'utf8')),
    })}\n`, 'utf8');

    const refreshed = await app.inject({
      method: 'POST', url: '/api/recommendations/refresh', headers, payload: { expectedRevision: 1 },
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ dataRevision: 6, snapshot: { dataRevision: 6 } });
    expect((await repository.read()).recommendationSnapshots[0]).toMatchObject({ dataRevision: 6, staleAt: null });
    await app.close();
  });

  it('validates preference writes and enforces the normal CSRF boundary', async () => {
    const { app } = await setup();
    const invalid = await app.inject({ method: 'PUT', url: '/api/recommendations/preferences', headers, payload: {
      expectedRevision: 1, brewMode: 'milk', acidityPreference: 'low', roastLevels: [], flavorNotes: [], avoidedFlavorNotes: [], maxPricePer100g: 0,
    } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().message).toContain('偏好没有保存');
    const csrf = await app.inject({ method: 'POST', url: '/api/recommendations/refresh', headers: { ...headers, 'x-csrf-token': 'wrong' }, payload: { expectedRevision: 1 } });
    expect(csrf.statusCode).toBe(403);
    await app.close();
  });
});
