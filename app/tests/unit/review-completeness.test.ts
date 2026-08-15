import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData, DrinkingRecordSchema, type CoffeeData } from '../../src/domain/schema.js';
import {
  buildCatchUpQueue,
  isDrinkingRecordReviewComplete,
  reviewedScore,
} from '../../src/domain/review-completeness.js';

const beanA = '00000000-0000-4000-8000-000000000101';
const beanB = '00000000-0000-4000-8000-000000000102';

function addBean(data: CoffeeData, id: string, name: string, legacyStatusRaw: string | null = null) {
  data.beans.push({
    id,
    brandId: null,
    name,
    normalizedKey: name,
    roastLevel: null,
    process: null,
    flavorNotes: [],
    followedAt: null,
    archivedAt: null,
    isDraft: false,
    legacyStatusRaw,
    legacyPersonalScoreRaw: null,
    provenance: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
}

function addDrink(
  data: CoffeeData,
  id: string,
  beanId: string,
  americanoState: 'unreviewed' | 'reviewed' | 'not_applicable',
  milkState: 'unreviewed' | 'reviewed' | 'not_applicable',
  options: { draft?: boolean; deleted?: boolean; americanoScore?: number; milkScore?: number } = {},
) {
  data.drinkingRecords.push({
    id,
    beanId,
    purchaseItemId: null,
    drankOn: '2026-08-02',
    brewMethod: 'milk',
    extractionNote: null,
    feeling: null,
    americanoReview: {
      state: americanoState,
      score: options.americanoScore ?? null,
      flavorNotes: [],
      pros: null,
      cons: null,
      note: null,
    },
    milkReview: {
      state: milkState,
      score: options.milkScore ?? null,
      flavorNotes: [],
      pros: null,
      cons: null,
      note: null,
    },
    draftAssessment: null,
    isDraft: options.draft ?? false,
    deletedAt: options.deleted ? '2026-08-03T00:00:00.000Z' : null,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
}

describe('review completeness', () => {
  it('allows an incomplete reviewed dimension only while the record is a draft', () => {
    const record = {
      id: '00000000-0000-4000-8000-000000000110',
      beanId: beanA,
      purchaseItemId: null,
      drankOn: '2026-08-02',
      brewMethod: 'milk',
      extractionNote: null,
      feeling: null,
      americanoReview: { state: 'reviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
      draftAssessment: { grade: 'A', repurchase: 'yes', summary: '待补评分' },
      deletedAt: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    expect(DrinkingRecordSchema.safeParse({ ...record, isDraft: true }).success).toBe(true);
    const finalResult = DrinkingRecordSchema.safeParse({ ...record, isDraft: false });
    expect(finalResult.success).toBe(false);
    if (!finalResult.success) expect(finalResult.error.issues[0]?.path).toEqual(['americanoReview', 'score']);
  });

  it('keeps milk-only review pending until americano is explicitly handled', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    addBean(data, beanA, '茶花女');
    addDrink(data, '00000000-0000-4000-8000-000000000111', beanA, 'unreviewed', 'reviewed', {
      milkScore: 4.5,
    });

    expect(isDrinkingRecordReviewComplete(data.drinkingRecords[0])).toBe(false);
    expect(buildCatchUpQueue(data).items).toHaveLength(1);
  });

  it('treats not-applicable as handled and exposes only reviewed scores', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    addBean(data, beanA, '茶花女');
    addDrink(data, '00000000-0000-4000-8000-000000000112', beanA, 'not_applicable', 'reviewed', {
      milkScore: 4.5,
    });

    expect(isDrinkingRecordReviewComplete(data.drinkingRecords[0])).toBe(true);
    expect(buildCatchUpQueue(data)).toMatchObject({ items: [], completed: 1, total: 1 });
    expect(reviewedScore(data.drinkingRecords[0].americanoReview)).toBeNull();
    expect(reviewedScore(data.drinkingRecords[0].milkReview)).toBe(4.5);
  });

  it('keeps imported drank beans without a factual drink record in the queue', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    addBean(data, beanA, '四月旧豆', '✅已喝');

    expect(buildCatchUpQueue(data)).toMatchObject({
      items: [{ beanId: beanA, reason: 'legacy_without_drinking_record', drinkingRecordId: null }],
      completed: 0,
      total: 1,
    });
  });

  it('requires every non-draft active drinking record to be complete', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    addBean(data, beanA, '多次饮用');
    addDrink(data, '00000000-0000-4000-8000-000000000113', beanA, 'reviewed', 'not_applicable', {
      americanoScore: 4,
    });
    addDrink(data, '00000000-0000-4000-8000-000000000114', beanA, 'unreviewed', 'unreviewed');

    expect(buildCatchUpQueue(data).items).toHaveLength(1);
  });

  it('keeps drafts resumable and ignores deleted records in the catch-up queue', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    addBean(data, beanA, '草稿豆');
    addBean(data, beanB, '删除豆');
    addDrink(data, '00000000-0000-4000-8000-000000000115', beanA, 'reviewed', 'not_applicable', {
      draft: true,
      americanoScore: 5,
    });
    addDrink(data, '00000000-0000-4000-8000-000000000116', beanB, 'reviewed', 'not_applicable', {
      deleted: true,
      americanoScore: 1,
    });

    expect(buildCatchUpQueue(data)).toMatchObject({
      items: [{ beanId: beanA, reason: 'draft_drinking_record' }],
      completed: 0,
      total: 1,
    });
  });
});
