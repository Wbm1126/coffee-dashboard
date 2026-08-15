import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import {
  buildGalleryItems,
  createEmptyGalleryFilters,
  filterAndSortGalleryItems,
} from '../../src/client/features/gallery/gallery-model.js';

function galleryFixture() {
  const data = createEmptyCoffeeData(new Date('2026-08-07T08:00:00+08:00'));
  data.brands = [
    { id: '00000000-0000-4000-8000-000000000101', name: '莓果社', aliases: [], archivedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt },
    { id: '00000000-0000-4000-8000-000000000102', name: '青线烘焙', aliases: [], archivedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt },
  ];
  data.beans = [
    {
      id: '00000000-0000-4000-8000-000000000201', brandId: data.brands[0]!.id, name: '日晒草莓', normalizedKey: '莓果社\u0000日晒草莓',
      roastLevel: '中浅烘焙', process: '日晒', flavorNotes: ['草莓', '可可'], followedAt: data.updatedAt,
      archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null,
      importedFacts: { overallScoreRaw: null, preferenceMatchRaw: null, recommendationRaw: null,
        referencePrice: { amount: 88, currency: 'CNY' }, pricePerGram: 0.352, packageGrams: 250,
        originOrVariety: '埃塞俄比亚', officialFlavorDescription: null, americanoPerformance: null,
        milkPerformance: null, suitableScenes: ['美式'], legacyNote: null, legacyScoreBasisRaw: null },
      provenance: {}, createdAt: data.updatedAt, updatedAt: data.updatedAt,
    },
    {
      id: '00000000-0000-4000-8000-000000000202', brandId: data.brands[1]!.id, name: '雾谷', normalizedKey: '青线烘焙\u0000雾谷',
      roastLevel: null, process: null, flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false,
      legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {}, createdAt: data.updatedAt, updatedAt: data.updatedAt,
    },
  ];
  data.assessments.push({ id: '00000000-0000-4000-8000-000000000301', beanId: data.beans[0]!.id, grade: 'A', repurchase: 'yes', summary: '果香清楚', basedOnDrinkingIds: [], updatedAt: data.updatedAt });
  return data;
}

describe('gallery model', () => {
  it('combines all eight filters and keeps unknown facts explicit', () => {
    const items = buildGalleryItems(galleryFixture());
    const filters = { ...createEmptyGalleryFilters(), brand: '莓果社', roast: '中浅烘焙', price: 'under_100' as const,
      flavor: '草莓', process: '日晒', scene: '美式', status: 'followed' as const, grade: 'A' };
    expect(filterAndSortGalleryItems(items, filters, { field: 'name', direction: 'asc' })).toHaveLength(1);
    expect(items.find((item) => item.bean.name === '雾谷')).toMatchObject({ price: null, roast: null, grade: null });
    dataWithUnknownBrand(items);
  });

  it('sorts supported fields in both directions with stable ties and leaves unknown last', () => {
    const data = galleryFixture();
    data.beans[1]!.importedFacts = { ...data.beans[0]!.importedFacts!, referencePrice: { amount: 88, currency: 'CNY' } };
    const items = buildGalleryItems(data);
    expect(filterAndSortGalleryItems(items, createEmptyGalleryFilters(), { field: 'price', direction: 'asc' }).map((item) => item.bean.name)).toEqual(['日晒草莓', '雾谷']);
    expect(filterAndSortGalleryItems(items, createEmptyGalleryFilters(), { field: 'price', direction: 'desc' }).map((item) => item.bean.name)).toEqual(['日晒草莓', '雾谷']);
    data.beans[1]!.importedFacts!.referencePrice = null;
    expect(filterAndSortGalleryItems(buildGalleryItems(data), createEmptyGalleryFilters(), { field: 'price', direction: 'desc' }).at(-1)?.bean.name).toBe('雾谷');
  });

  it('projects purchase and drinking trace data without changing review semantics', () => {
    const data = galleryFixture();
    const beanId = data.beans[0]!.id;
    const purchaseId = '00000000-0000-4000-8000-000000000401';
    const purchaseItemId = '00000000-0000-4000-8000-000000000402';
    data.purchases.push({ id: purchaseId, purchasedOn: '2026-08-01', channel: '线下店', note: null, shipping: null, discount: null,
      itemIds: [purchaseItemId], deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt });
    data.purchaseItems.push({ id: purchaseItemId, purchaseId, beanId, quantity: 2, packageGrams: 250,
      paid: { amount: 168, currency: 'CNY' }, bagStatus: 'drinking' });
    data.drinkingRecords.push({ id: '00000000-0000-4000-8000-000000000403', beanId, purchaseItemId, drankOn: '2026-08-07', brewMethod: 'americano',
      extractionNote: null, feeling: null, americanoReview: { state: 'reviewed', score: 4.5, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null }, draftAssessment: null,
      isDraft: false, deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt });

    const item = buildGalleryItems(data).find((candidate) => candidate.bean.id === beanId)!;

    expect(item).toMatchObject({ americanoScore: 4.5, milkScore: null });
    expect(item.purchaseHistory).toEqual([{ purchase: data.purchases[0], items: [data.purchaseItems[0]] }]);
    expect(item.drinkingHistory[0]).toMatchObject({ record: data.drinkingRecords[0], purchaseItem: data.purchaseItems[0], purchase: data.purchases[0] });
  });

  it('indexes fact tables once instead of scanning every table for every bean', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-07T08:00:00+08:00'));
    const count = 100;
    const uuid = (offset: number) => `00000000-0000-4000-8000-${String(offset).padStart(12, '0')}`;
    data.brands = [{ id: uuid(1), name: '批量社', aliases: [], archivedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt }];
    data.beans = Array.from({ length: count }, (_, index) => ({ id: uuid(1000 + index), brandId: data.brands[0]!.id, name: `豆 ${index}`,
      normalizedKey: `批量社\u0000豆 ${index}`, roastLevel: null, process: null, flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false,
      legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {}, createdAt: data.updatedAt, updatedAt: data.updatedAt }));
    data.assessments = data.beans.map((bean, index) => ({ id: uuid(2000 + index), beanId: bean.id, grade: null, repurchase: null, summary: null,
      basedOnDrinkingIds: [], updatedAt: data.updatedAt }));
    data.purchases = data.beans.map((_bean, index) => ({ id: uuid(3000 + index), purchasedOn: '2026-08-01', channel: null, note: null, shipping: null,
      discount: null, itemIds: [uuid(4000 + index)], deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt }));
    data.purchaseItems = data.beans.map((bean, index) => ({ id: uuid(4000 + index), purchaseId: data.purchases[index]!.id, beanId: bean.id, quantity: 1,
      packageGrams: null, paid: null, bagStatus: 'unknown' as const }));
    data.drinkingRecords = data.beans.map((bean, index) => ({ id: uuid(5000 + index), beanId: bean.id, purchaseItemId: data.purchaseItems[index]!.id,
      drankOn: '2026-08-07', brewMethod: 'americano' as const, extractionNote: null, feeling: null,
      americanoReview: { state: 'reviewed' as const, score: 4, flavorNotes: [], pros: null, cons: null, note: null }, milkReview: null, draftAssessment: null,
      isDraft: false, deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt }));
    const reads = { value: 0 };
    const countReads = <T>(values: T[]) => new Proxy(values, { get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads.value += 1;
      return Reflect.get(target, property, receiver);
    } });
    data.assessments = countReads(data.assessments);
    data.purchases = countReads(data.purchases);
    data.purchaseItems = countReads(data.purchaseItems);
    data.drinkingRecords = countReads(data.drinkingRecords);

    expect(buildGalleryItems(data)).toHaveLength(count);
    expect(reads.value).toBeLessThan(count * 20);
  });
});

function dataWithUnknownBrand(items: ReturnType<typeof buildGalleryItems>) {
  items[1]!.brand = null;
  const filters = { ...createEmptyGalleryFilters(), brand: 'unknown' };
  expect(filterAndSortGalleryItems(items, filters, { field: 'name', direction: 'asc' }).map((item) => item.bean.name)).toEqual(['雾谷']);
}
