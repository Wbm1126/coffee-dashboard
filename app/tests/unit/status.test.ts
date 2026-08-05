import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import { deriveBeanBadges } from '../../src/domain/status.js';

const beanId = '00000000-0000-4000-8000-000000000010';
const purchaseId = '00000000-0000-4000-8000-000000000011';
const itemId = '00000000-0000-4000-8000-000000000012';

describe('deriveBeanBadges', () => {
  it('preserves review-complete while a repurchase is waiting', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    data.beans.push({
      id: beanId,
      brandId: null,
      name: '测试豆',
      normalizedKey: '测试豆',
      roastLevel: null,
      process: null,
      flavorNotes: [],
      followedAt: '2026-08-01T00:00:00.000Z',
      archivedAt: null,
      isDraft: false,
      legacyStatusRaw: null,
      legacyPersonalScoreRaw: null,
      provenance: {},
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    data.purchases.push({
      id: purchaseId,
      purchasedOn: '2026-08-02',
      channel: null,
      note: null,
      shipping: null,
      discount: null,
      itemIds: [itemId],
      deletedAt: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    data.purchaseItems.push({
      id: itemId,
      purchaseId,
      beanId,
      quantity: 1,
      packageGrams: 250,
      paid: null,
      bagStatus: 'unopened',
    });
    data.drinkingRecords.push({
      id: '00000000-0000-4000-8000-000000000013',
      beanId,
      purchaseItemId: null,
      drankOn: '2026-08-03',
      brewMethod: 'milk',
      extractionNote: null,
      feeling: null,
      americanoReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'reviewed', score: 4.5, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false,
      deletedAt: null,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });

    expect(deriveBeanBadges(data, beanId)).toEqual([
      'followed',
      'purchased_waiting',
      'review_complete',
    ]);
  });

  it('does not treat a missing review as a low or complete review', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    data.beans.push({
      id: beanId,
      brandId: null,
      name: '测试豆',
      normalizedKey: '测试豆',
      roastLevel: null,
      process: null,
      flavorNotes: [],
      followedAt: null,
      archivedAt: null,
      isDraft: false,
      legacyStatusRaw: null,
      legacyPersonalScoreRaw: null,
      provenance: {},
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    data.drinkingRecords.push({
      id: '00000000-0000-4000-8000-000000000014',
      beanId,
      purchaseItemId: null,
      drankOn: '2026-08-03',
      brewMethod: 'milk',
      extractionNote: null,
      feeling: null,
      americanoReview: null,
      milkReview: { state: 'reviewed', score: 4, flavorNotes: [], pros: null, cons: null, note: null },
      isDraft: false,
      deletedAt: null,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(deriveBeanBadges(data, beanId)).toContain('drank_pending_review');
  });
});

