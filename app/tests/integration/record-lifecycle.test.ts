import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveBeanBadges } from '../../src/domain/status.js';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
const headers = {
  host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json', 'x-csrf-token': 'records-token',
};

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-record-lifecycle-'));
  tempDirs.push(dataDir);
  const repository = new JsonRepository(dataDir);
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'records-token' });
  const beanIds = [
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000103',
  ];
  await repository.mutate(0, (data) => {
    const now = new Date().toISOString();
    for (const [index, id] of beanIds.entries()) {
      data.beans.push({ id, brandId: null, name: `豆 ${index + 1}`, normalizedKey: `豆-${index + 1}`,
        roastLevel: null, process: null, flavorNotes: [], followedAt: null, archivedAt: null,
        isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {},
        createdAt: now, updatedAt: now });
    }
    data.recommendationSnapshots.push({ id: 'recommendation-before-facts', staleAt: null });
    data.exportSnapshots.push({ id: 'export-before-facts', immutableMarker: 'must-not-change' });
  });
  return { app, repository, beanIds };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function purchasePayload(expectedRevision: number, beanIds: string[]) {
  return {
    expectedRevision, purchaseId: null, purchasedOn: '2026-08-06', channel: '线下门店', note: '三豆拼单',
    shipping: { amount: 8, currency: 'CNY' }, discount: { amount: 10, currency: 'CNY' },
    items: beanIds.map((beanId, index) => ({ purchaseItemId: null, beanId, quantity: index + 1,
      packageGrams: index === 2 ? null : 250, paid: index === 1 ? null : { amount: 88 + index, currency: 'CNY' } })),
  };
}

describe('purchase, drinking and trash lifecycle', () => {
  it('atomically saves one three-bean purchase, derives nullable unit prices, and supports repurchase badges', async () => {
    const { app, repository, beanIds } = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(1, beanIds) });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ dataRevision: 2, items: [
      { beanId: beanIds[0], unitPricePer100g: 35.2 },
      { beanId: beanIds[1], unitPricePer100g: null },
      { beanId: beanIds[2], unitPricePer100g: null },
    ] });
    let data = await repository.read();
    expect(data.purchases).toHaveLength(1);
    expect(data.purchaseItems).toHaveLength(3);
    expect(data.drinkingRecords).toHaveLength(0);
    expect(deriveBeanBadges(data, beanIds[0])).toContain('purchased_waiting');

    const repurchase = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: { ...purchasePayload(2, [beanIds[0]]), purchasedOn: '2026-08-07' } });
    expect(repurchase.statusCode).toBe(201);
    data = await repository.read();
    expect(data.purchaseItems.filter((item) => item.beanId === beanIds[0])).toHaveLength(2);
    await app.close();
  });

  it('rejects any invalid purchase row and stale revision without writing any part of the order', async () => {
    const { app, repository, beanIds } = await fixture();
    const invalid = purchasePayload(1, beanIds);
    invalid.items[1]!.quantity = 0;
    const response = await app.inject({ method: 'POST', url: '/api/purchases/save', headers, payload: invalid });
    expect(response.statusCode).toBe(422);
    expect((await repository.read()).purchases).toHaveLength(0);

    const stale = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(0, beanIds) });
    expect(stale.statusCode).toBe(409);
    expect((await repository.read()).purchases).toHaveLength(0);
    await app.close();
  });

  it('rejects duplicate non-null purchase item ids before mutation', async () => {
    const { app, repository, beanIds } = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(1, [beanIds[0], beanIds[1]]) });
    const purchaseId = created.json().purchaseId as string;
    const [firstItem, secondItem] = created.json().items as Array<{ purchaseItemId: string; beanId: string }>;
    const before = await repository.read();

    const duplicate = await app.inject({ method: 'POST', url: '/api/purchases/save', headers, payload: {
      ...purchasePayload(2, []), purchaseId, items: [
        { purchaseItemId: firstItem!.purchaseItemId, beanId: beanIds[0], quantity: 1,
          packageGrams: 250, paid: { amount: 88, currency: 'CNY' } },
        { purchaseItemId: firstItem!.purchaseItemId, beanId: beanIds[1], quantity: 2,
          packageGrams: 200, paid: { amount: 99, currency: 'CNY' } },
      ],
    } });

    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({ error: 'invalid_purchase', details: [
      expect.objectContaining({ path: ['items', 1, 'purchaseItemId'] }),
    ] });
    expect(await repository.read()).toEqual(before);
    expect(secondItem!.purchaseItemId).not.toBe(firstItem!.purchaseItemId);
    await app.close();
  });

  it('keeps an archived bean on its original purchase item but rejects new or rebound archived-bean lines', async () => {
    const { app, repository, beanIds } = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(1, [beanIds[0], beanIds[1]]) });
    const [archivedItem, activeItem] = created.json().items as Array<{ purchaseItemId: string; beanId: string }>;
    const archived = await app.inject({ method: 'DELETE', url: `/api/beans/${beanIds[0]}`, headers,
      payload: { expectedRevision: 2, confirmPermanent: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ dataRevision: 3, action: 'archived' });

    const corrected = await app.inject({ method: 'POST', url: '/api/purchases/save', headers, payload: {
      ...purchasePayload(3, []), purchaseId: created.json().purchaseId, note: '保留历史归档豆', items: [
        { purchaseItemId: archivedItem!.purchaseItemId, beanId: beanIds[0], quantity: 2,
          packageGrams: 200, paid: { amount: 120, currency: 'CNY' } },
        { purchaseItemId: activeItem!.purchaseItemId, beanId: beanIds[1], quantity: 1,
          packageGrams: 250, paid: { amount: 90, currency: 'CNY' } },
      ],
    } });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({ dataRevision: 4, items: [
      { purchaseItemId: archivedItem!.purchaseItemId, beanId: beanIds[0] },
      { purchaseItemId: activeItem!.purchaseItemId, beanId: beanIds[1] },
    ] });

    const addedArchived = await app.inject({ method: 'POST', url: '/api/purchases/save', headers, payload: {
      ...purchasePayload(4, []), purchaseId: created.json().purchaseId, items: [
        { purchaseItemId: archivedItem!.purchaseItemId, beanId: beanIds[0], quantity: 2,
          packageGrams: 200, paid: { amount: 120, currency: 'CNY' } },
        { purchaseItemId: activeItem!.purchaseItemId, beanId: beanIds[1], quantity: 1,
          packageGrams: 250, paid: { amount: 90, currency: 'CNY' } },
        { purchaseItemId: null, beanId: beanIds[0], quantity: 1, packageGrams: 100, paid: null },
      ],
    } });
    expect(addedArchived.statusCode).toBe(404);
    expect(addedArchived.json()).toMatchObject({ error: 'bean_not_found', missingReferences: [beanIds[0]] });
    expect((await repository.read()).dataRevision).toBe(4);

    const reboundArchived = await app.inject({ method: 'POST', url: '/api/purchases/save', headers, payload: {
      ...purchasePayload(4, []), purchaseId: created.json().purchaseId, items: [
        { purchaseItemId: archivedItem!.purchaseItemId, beanId: beanIds[0], quantity: 2,
          packageGrams: 200, paid: { amount: 120, currency: 'CNY' } },
        { purchaseItemId: activeItem!.purchaseItemId, beanId: beanIds[0], quantity: 1,
          packageGrams: 250, paid: { amount: 90, currency: 'CNY' } },
      ],
    } });
    expect(reboundArchived.statusCode).toBe(404);
    expect((await repository.read()).dataRevision).toBe(4);

    const newPurchase = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(4, [beanIds[0]]) });
    expect(newPurchase.statusCode).toBe(404);
    expect((await repository.read()).dataRevision).toBe(4);
    await app.close();
  });

  it('covers the complete multi-item purchase trash, restore, conflict, and permanent purge lifecycle', async () => {
    const { app, repository, beanIds } = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(1, [beanIds[0], beanIds[1], beanIds[2]]) });
    expect(created.statusCode).toBe(201);
    const purchaseId = created.json().purchaseId as string;
    const itemIds = (created.json().items as Array<{ purchaseItemId: string }>).map((item) => item.purchaseItemId);

    const impact = await app.inject({ method: 'GET', url: `/api/purchases/${purchaseId}/trash-impact`,
      headers: { host: headers.host } });
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toMatchObject({ recordId: purchaseId, beanIds,
      purchaseItemCount: 3, linkedDrinkingCount: 0,
      consequences: ['bean_badges_recomputed', 'bag_statuses_recomputed', 'recommendations_expire'] });

    const missingConfirmation = await app.inject({ method: 'DELETE', url: `/api/purchases/${purchaseId}`, headers,
      payload: { expectedRevision: 2 } });
    expect(missingConfirmation.statusCode).toBe(422);
    expect(missingConfirmation.json()).toMatchObject({ error: 'explicit_confirmation_required' });
    expect((await repository.read()).dataRevision).toBe(2);
    const refusedConfirmation = await app.inject({ method: 'DELETE', url: `/api/purchases/${purchaseId}`, headers,
      payload: { expectedRevision: 2, confirmPermanent: false } });
    expect(refusedConfirmation.statusCode).toBe(422);
    expect((await repository.read()).dataRevision).toBe(2);

    const activePurge = await app.inject({ method: 'DELETE', url: `/api/purchases/${purchaseId}`, headers,
      payload: { expectedRevision: 2, confirmPermanent: true } });
    expect(activePurge.statusCode).toBe(422);
    expect(activePurge.json()).toMatchObject({ error: 'permanent_clear_requires_trashed_record' });
    expect((await repository.read()).dataRevision).toBe(2);

    expect((await app.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/trash`, headers,
      payload: { expectedRevision: 2 } })).json()).toMatchObject({ dataRevision: 3, action: 'trashed', undoAvailable: true });
    expect((await app.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/restore`, headers,
      payload: { expectedRevision: 3 } })).json()).toMatchObject({ dataRevision: 4, action: 'restored' });
    expect((await app.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/trash`, headers,
      payload: { expectedRevision: 4 } })).statusCode).toBe(200);
    await app.close();

    const restartedRepository = new JsonRepository(repository.dataDir);
    const restarted = await buildApp({ repository: restartedRepository, serveStatic: false, csrfToken: 'records-token' });
    const restoredAfterRestart = await restarted.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/restore`, headers,
      payload: { expectedRevision: 5 } });
    expect(restoredAfterRestart.statusCode).toBe(200);
    expect(restoredAfterRestart.json()).toMatchObject({ dataRevision: 6, action: 'restored' });

    const removedBean = structuredClone((await restartedRepository.read()).beans.find((bean) => bean.id === beanIds[0])!);
    await restartedRepository.mutate(6, (data) => { data.beans = data.beans.filter((bean) => bean.id !== beanIds[0]); });
    await restarted.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/trash`, headers,
      payload: { expectedRevision: 7 } });
    const restoreConflict = await restarted.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/restore`, headers,
      payload: { expectedRevision: 8 } });
    expect(restoreConflict.statusCode).toBe(409);
    expect(restoreConflict.json()).toMatchObject({ error: 'restore_conflict', missingReferences: [beanIds[0]] });
    expect((await restartedRepository.read()).dataRevision).toBe(8);

    await restartedRepository.mutate(8, (data) => { data.beans.push(removedBean); });
    expect((await restarted.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/restore`, headers,
      payload: { expectedRevision: 9 } })).statusCode).toBe(200);
    const drink = await restarted.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 10, beanId: beanIds[0], purchaseItemId: itemIds[0], drinkingRecordId: null,
      drankOn: '2026-08-07', brewMethod: 'americano', extractionNote: null, feeling: null,
      americanoReview: { state: 'reviewed', score: 4, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: null,
    } });
    expect(drink.statusCode).toBe(200);
    const drinkingRecordId = drink.json().drinkingRecordId as string;
    expect((await restarted.inject({ method: 'GET', url: `/api/purchases/${purchaseId}/trash-impact`,
      headers: { host: headers.host } })).json()).toMatchObject({ purchaseItemCount: 3, linkedDrinkingCount: 1 });
    expect((await restarted.inject({ method: 'POST', url: `/api/purchases/${purchaseId}/trash`, headers,
      payload: { expectedRevision: 11 } })).statusCode).toBe(200);

    const referencedPurge = await restarted.inject({ method: 'DELETE', url: `/api/purchases/${purchaseId}`, headers,
      payload: { expectedRevision: 12, confirmPermanent: true } });
    expect(referencedPurge.statusCode).toBe(422);
    expect(referencedPurge.json()).toMatchObject({ error: 'purchase_item_referenced' });
    expect((await restartedRepository.read()).dataRevision).toBe(12);

    expect((await restarted.inject({ method: 'POST', url: `/api/drinking/${drinkingRecordId}/trash`, headers,
      payload: { expectedRevision: 12 } })).statusCode).toBe(200);
    expect((await restarted.inject({ method: 'DELETE', url: `/api/drinking/${drinkingRecordId}`, headers,
      payload: { expectedRevision: 13, confirmPermanent: true } })).statusCode).toBe(200);
    const purged = await restarted.inject({ method: 'DELETE', url: `/api/purchases/${purchaseId}`, headers,
      payload: { expectedRevision: 14, confirmPermanent: true } });
    expect(purged.statusCode).toBe(200);
    expect(purged.json()).toMatchObject({ dataRevision: 15, action: 'permanently_deleted' });
    const finalData = await restartedRepository.read();
    expect(finalData.purchases.some((purchase) => purchase.id === purchaseId)).toBe(false);
    expect(finalData.purchaseItems.some((item) => item.purchaseId === purchaseId)).toBe(false);
    await restarted.close();
  });

  it('saves historical drinks without an item, links a matching item, and rejects a different bean item', async () => {
    const { app, repository, beanIds } = await fixture();
    const historical = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId: beanIds[0], purchaseItemId: null, drinkingRecordId: null,
      drankOn: '2026-05-01', brewMethod: 'americano', extractionNote: null, feeling: '历史补录',
      americanoReview: { state: 'reviewed', score: 4, flavorNotes: ['坚果'], pros: null, cons: null, note: null },
      milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: { grade: 'A-', repurchase: 'price_dependent', summary: '继续观察' },
    } });
    expect(historical.statusCode).toBe(200);
    expect(deriveBeanBadges(await repository.read(), beanIds[0])).toContain('drank_pending_review');

    const purchase = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(2, [beanIds[0], beanIds[1]]) });
    const itemIds = (purchase.json().items as Array<{ purchaseItemId: string }>).map((item) => item.purchaseItemId);
    const linked = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 3, beanId: beanIds[0], purchaseItemId: itemIds[0], drinkingRecordId: null,
      drankOn: '2026-08-06', brewMethod: 'milk', extractionNote: null, feeling: null,
      americanoReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'reviewed', score: 4.5, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: null,
    } });
    expect(linked.statusCode).toBe(200);
    expect((await repository.read()).purchaseItems.find((item) => item.id === itemIds[0])?.bagStatus).toBe('drinking');

    const mismatch = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 4, beanId: beanIds[0], purchaseItemId: itemIds[1], drinkingRecordId: null,
      drankOn: '2026-08-07', brewMethod: 'other', extractionNote: null, feeling: null,
      americanoReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: null,
    } });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: 'purchase_item_bean_mismatch' });
    expect((await repository.read()).dataRevision).toBe(4);
    await app.close();
  });

  it('recomputes both beans after correcting a linked drink without overwriting assessment', async () => {
    const { app, repository, beanIds } = await fixture();
    const purchase = await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(1, [beanIds[0], beanIds[1]]) });
    const itemIds = (purchase.json().items as Array<{ purchaseItemId: string }>).map((item) => item.purchaseItemId);
    const base = {
      drankOn: '2026-08-06', brewMethod: 'milk', extractionNote: null, feeling: null,
      americanoReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'reviewed', score: 5, flavorNotes: [], pros: null, cons: null, note: null }, isDraft: false,
    };
    const made = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...base, expectedRevision: 2, beanId: beanIds[0], purchaseItemId: itemIds[0], drinkingRecordId: null,
      assessment: { grade: 'A+', repurchase: 'yes', summary: '用户结论' },
    } });
    const recordId = made.json().drinkingRecordId as string;
    const corrected = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...base, expectedRevision: 3, beanId: beanIds[1], purchaseItemId: itemIds[1], drinkingRecordId: recordId,
      assessment: { grade: 'A', repurchase: 'price_dependent', summary: '新豆结论' },
    } });
    expect(corrected.statusCode).toBe(200);
    const data = await repository.read();
    expect(data.purchaseItems.find((item) => item.id === itemIds[0])?.bagStatus).toBe('unopened');
    expect(data.purchaseItems.find((item) => item.id === itemIds[1])?.bagStatus).toBe('drinking');
    expect(data.assessments[0]).toMatchObject({ beanId: beanIds[0], grade: 'A+', summary: '用户结论' });
    expect(data.assessments[0]!.basedOnDrinkingIds).toEqual([]);
    expect(data.assessments[1]).toMatchObject({ beanId: beanIds[1], grade: 'A', summary: '新豆结论', basedOnDrinkingIds: [recordId] });
    expect(data.recommendationSnapshots[0]).toMatchObject({ id: 'recommendation-before-facts', staleBecauseRevision: 4 });
    expect(data.exportSnapshots[0]).toEqual({ id: 'export-before-facts', immutableMarker: 'must-not-change' });
    expect(deriveBeanBadges(data, beanIds[0])).not.toContain('review_complete');
    expect(deriveBeanBadges(data, beanIds[1])).toContain('review_complete');
    await app.close();
  });

  it('allows correcting a record on its archived bean but rejects new or rebound archived-bean facts', async () => {
    const { app, repository, beanIds } = await fixture();
    const payload = {
      purchaseItemId: null, drankOn: '2026-08-06', brewMethod: 'americano', extractionNote: '归档前记录', feeling: null,
      americanoReview: { state: 'reviewed', score: 4, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: null,
    };
    const made = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...payload, expectedRevision: 1, beanId: beanIds[0], drinkingRecordId: null,
    } });
    const recordId = made.json().drinkingRecordId as string;
    const archived = await app.inject({ method: 'DELETE', url: `/api/beans/${beanIds[0]}`, headers,
      payload: { expectedRevision: 2, confirmPermanent: true } });
    expect(archived.json()).toMatchObject({ action: 'archived', dataRevision: 3 });

    const corrected = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...payload, expectedRevision: 3, beanId: beanIds[0], drinkingRecordId: recordId, extractionNote: '归档后仍可更正',
    } });
    expect(corrected.statusCode).toBe(200);
    expect((await repository.read()).drinkingRecords[0]!.extractionNote).toBe('归档后仍可更正');

    const newlyCreated = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...payload, expectedRevision: 4, beanId: beanIds[0], drinkingRecordId: null,
    } });
    expect(newlyCreated.statusCode).toBe(404);
    const other = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...payload, expectedRevision: 4, beanId: beanIds[1], drinkingRecordId: null,
    } });
    const otherRecordId = other.json().drinkingRecordId as string;
    const rebound = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      ...payload, expectedRevision: 5, beanId: beanIds[0], drinkingRecordId: otherRecordId,
    } });
    expect(rebound.statusCode).toBe(404);
    expect((await repository.read()).dataRevision).toBe(5);
    await app.close();
  });

  it('reports and refuses permanent purge when a drink is an assessment sole basis', async () => {
    const { app, repository, beanIds } = await fixture();
    const made = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId: beanIds[0], purchaseItemId: null, drinkingRecordId: null,
      drankOn: '2026-08-06', brewMethod: 'americano', extractionNote: null, feeling: null,
      americanoReview: { state: 'reviewed', score: 5, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: { grade: 'A+', repurchase: 'yes', summary: '只能追溯到这一杯' },
    } });
    const recordId = made.json().drinkingRecordId as string;
    const impact = await app.inject({ method: 'GET', url: `/api/drinking/${recordId}/trash-impact`, headers: { host: headers.host } });
    expect(impact.json()).toMatchObject({ canPermanentlyDelete: false,
      assessmentBasisConflicts: [{ beanId: beanIds[0] }],
      consequences: expect.arrayContaining(['assessment_basis_must_be_preserved']) });
    expect((await app.inject({ method: 'POST', url: `/api/drinking/${recordId}/trash`, headers,
      payload: { expectedRevision: 2 } })).statusCode).toBe(200);

    const purge = await app.inject({ method: 'DELETE', url: `/api/drinking/${recordId}`, headers,
      payload: { expectedRevision: 3, confirmPermanent: true } });
    expect(purge.statusCode).toBe(409);
    expect(purge.json()).toMatchObject({ error: 'assessment_basis_conflict', beanIds: [beanIds[0]],
      message: expect.stringContaining('唯一依据') });
    const data = await repository.read();
    expect(data.drinkingRecords).toHaveLength(1);
    expect(data.assessments[0]!.basedOnDrinkingIds).toEqual([recordId]);
    expect(data.dataRevision).toBe(3);
    await app.close();
  });

  it('previews, trashes, immediately restores, survives restart, detects conflict, and purges only trashed drinks', async () => {
    const { app, repository, beanIds } = await fixture();
    const made = await app.inject({ method: 'POST', url: '/api/drinking/save', headers, payload: {
      expectedRevision: 1, beanId: beanIds[0], purchaseItemId: null, drinkingRecordId: null,
      drankOn: '2026-08-06', brewMethod: 'other', extractionNote: null, feeling: null,
      americanoReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false, assessment: null,
    } });
    const id = made.json().drinkingRecordId as string;
    const preview = await app.inject({ method: 'GET', url: `/api/drinking/${id}/trash-impact`, headers: { host: headers.host } });
    expect(preview.json()).toMatchObject({ recordId: id, beanIds: [beanIds[0]],
      consequences: ['bean_badges_recomputed', 'recommendations_expire'] });
    expect((await app.inject({ method: 'POST', url: `/api/drinking/${id}/trash`, headers,
      payload: { expectedRevision: 2 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/drinking/${id}/restore`, headers,
      payload: { expectedRevision: 3 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/drinking/${id}/trash`, headers,
      payload: { expectedRevision: 4 } })).statusCode).toBe(200);
    await app.close();

    const restarted = await buildApp({ repository: new JsonRepository(repository.dataDir), serveStatic: false, csrfToken: 'records-token' });
    const restored = await restarted.inject({ method: 'POST', url: `/api/drinking/${id}/restore`, headers,
      payload: { expectedRevision: 5 } });
    expect(restored.statusCode).toBe(200);
    await repository.mutate(6, (data) => { data.beans = data.beans.filter((bean) => bean.id !== beanIds[0]); });
    await restarted.inject({ method: 'POST', url: `/api/drinking/${id}/trash`, headers,
      payload: { expectedRevision: 7 } });
    const conflict = await restarted.inject({ method: 'POST', url: `/api/drinking/${id}/restore`, headers,
      payload: { expectedRevision: 8 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'restore_conflict', missingReferences: [beanIds[0]] });
    const purge = await restarted.inject({ method: 'DELETE', url: `/api/drinking/${id}`, headers,
      payload: { expectedRevision: 8, confirmPermanent: true } });
    expect(purge.statusCode).toBe(200);
    expect((await repository.read()).drinkingRecords).toHaveLength(0);
    await restarted.close();
  });

  it('archives a bean referenced by facts and only permanently deletes an unreferenced minimal bean', async () => {
    const { app, repository, beanIds } = await fixture();
    await app.inject({ method: 'POST', url: '/api/purchases/save', headers,
      payload: purchasePayload(1, [beanIds[0]]) });
    const impact = await app.inject({ method: 'GET', url: `/api/beans/${beanIds[0]}/delete-impact`, headers: { host: headers.host } });
    expect(impact.json()).toMatchObject({ canPermanentlyDelete: false, action: 'archive', purchaseItemCount: 1 });
    const archived = await app.inject({ method: 'DELETE', url: `/api/beans/${beanIds[0]}`, headers,
      payload: { expectedRevision: 2, confirmPermanent: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ action: 'archived' });

    await repository.mutate(3, (data) => { const bean = data.beans.find((item) => item.id === beanIds[2])!; bean.isDraft = true; });
    const removed = await app.inject({ method: 'DELETE', url: `/api/beans/${beanIds[2]}`, headers,
      payload: { expectedRevision: 4, confirmPermanent: true } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ action: 'permanently_deleted' });
    await app.close();
  });
});
