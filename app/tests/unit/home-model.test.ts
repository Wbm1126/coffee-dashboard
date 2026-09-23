import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData, type CoffeeData } from '../../src/domain/schema.js';
import { currentlyDrinkingBeans, pendingReviewDrinks, recentDrinks, recentlyAddedBeans } from '../../src/client/features/home/home-model.js';

function seed(): CoffeeData {
  const data = createEmptyCoffeeData(new Date('2026-09-22T00:00:00.000Z'));
  data.brands.push({ id: '00000000-0000-4000-8000-000000000101', name: '铁壶', aliases: [], archivedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt });
  for (const [id, name, createdAt] of [
    ['00000000-0000-4000-8000-000000000201', '黑猫', '2026-09-01T00:00:00.000Z'],
    ['00000000-0000-4000-8000-000000000202', '疣猪', '2026-09-10T00:00:00.000Z'],
    ['00000000-0000-4000-8000-000000000203', '三重奏', '2026-09-20T00:00:00.000Z'],
  ] as const) {
    data.beans.push({
      id, brandId: '00000000-0000-4000-8000-000000000101', name, normalizedKey: name,
      roastLevel: '中深', process: null, flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false,
      legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {}, createdAt, updatedAt: createdAt,
    });
  }
  data.purchases.push({ id: '00000000-0000-4000-8000-000000000301', purchasedOn: '2026-09-15', channel: null, note: null, shipping: null, discount: null, itemIds: ['00000000-0000-4000-8000-000000000401'], deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt });
  data.purchaseItems.push({ id: '00000000-0000-4000-8000-000000000401', purchaseId: '00000000-0000-4000-8000-000000000301', beanId: '00000000-0000-4000-8000-000000000201', quantity: 1, packageGrams: 250, paid: null, bagStatus: 'drinking' });
  return data;
}

function drink(data: CoffeeData, id: string, beanId: string, drankOn: string, milkScore: number | null, complete: boolean) {
  data.drinkingRecords.push({
    id, beanId, purchaseItemId: null, drankOn, brewMethod: 'milk', extractionNote: null, brewParams: null, feeling: null,
    americanoReview: complete
      ? { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null }
      : { state: 'unreviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
    milkReview: { state: milkScore === null ? 'unreviewed' : 'reviewed', score: milkScore, flavorNotes: [], pros: null, cons: null, note: null },
    draftAssessment: null, isDraft: false, deletedAt: null, createdAt: `${drankOn}T08:00:00.000Z`, updatedAt: `${drankOn}T08:00:00.000Z`,
  });
}

describe('首页模块数据推导', () => {
  it('当前在喝：只列出在库饮用中的豆', () => {
    const data = seed();
    const drinking = currentlyDrinkingBeans(data);
    expect(drinking.map((line) => line.name)).toEqual(['黑猫']);
    expect(drinking[0]?.brand).toBe('铁壶');
  });

  it('最近喝过：倒序且不超过上限，评分取有分的轨', () => {
    const data = seed();
    drink(data, '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000201', '2026-09-18', 4, false);
    drink(data, '00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000202', '2026-09-21', null, false);
    const lines = recentDrinks(data, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ beanName: '疣猪', score: null });
    expect(recentDrinks(data).map((line) => line.beanName)).toEqual(['疣猪', '黑猫']);
  });

  it('待评价：未完成评价的正式记录进入队列', () => {
    const data = seed();
    drink(data, '00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-000000000201', '2026-09-18', 4, true);
    drink(data, '00000000-0000-4000-8000-000000000504', '00000000-0000-4000-8000-000000000202', '2026-09-21', null, false);
    expect(pendingReviewDrinks(data).map((line) => line.beanName)).toEqual(['疣猪']);
  });

  it('最近新增：按创建时间倒序', () => {
    expect(recentlyAddedBeans(seed(), 2).map((line) => line.name)).toEqual(['三重奏', '疣猪']);
  });
});
