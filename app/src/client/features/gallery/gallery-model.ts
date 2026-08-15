import { isDrinkingRecordReviewComplete, reviewedScore } from '../../../domain/review-completeness.js';
import type { BeanBadge } from '../../../domain/status.js';
import type { CoffeeData } from '../../../domain/schema.js';

type GalleryPriceFilter = '' | 'under_100' | '100_199' | '200_plus' | 'unknown';
type GalleryStatusFilter = '' | BeanBadge | 'unknown';
export interface GalleryFilters {
  query: string;
  brand: string;
  roast: string;
  price: GalleryPriceFilter;
  flavor: string;
  process: string;
  scene: string;
  status: GalleryStatusFilter;
  grade: string;
}
type GallerySortField = 'name' | 'brand' | 'price' | 'roast' | 'grade';
export interface GallerySort { field: GallerySortField; direction: 'asc' | 'desc' }

export interface GalleryItem {
  bean: CoffeeData['beans'][number];
  brand: string | null;
  price: number | null;
  roast: string | null;
  grade: string | null;
  assessment: CoffeeData['assessments'][number] | null;
  badges: BeanBadge[];
  scenes: string[];
  americanoScore: number | null;
  milkScore: number | null;
  sources: CoffeeData['productSources'];
  purchaseHistory: Array<{
    purchase: CoffeeData['purchases'][number];
    items: CoffeeData['purchaseItems'];
  }>;
  drinkingHistory: Array<{
    record: CoffeeData['drinkingRecords'][number];
    purchaseItem: CoffeeData['purchaseItems'][number] | null;
    purchase: CoffeeData['purchases'][number] | null;
  }>;
  originalIndex: number;
}

export function createEmptyGalleryFilters(): GalleryFilters {
  return { query: '', brand: '', roast: '', price: '', flavor: '', process: '', scene: '', status: '', grade: '' };
}

export function buildGalleryItems(data: CoffeeData): GalleryItem[] {
  const brands = new Map(data.brands.map((brand) => [brand.id, brand.name]));
  const assessments = new Map<string, CoffeeData['assessments'][number]>();
  for (const assessment of data.assessments) if (!assessments.has(assessment.beanId)) assessments.set(assessment.beanId, assessment);
  const purchases = new Map(data.purchases.map((purchase) => [purchase.id, purchase]));
  const activePurchaseIds = new Set(data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id));
  const purchaseItems = new Map(data.purchaseItems.map((item) => [item.id, item]));
  const purchaseItemsByBean = groupBy(data.purchaseItems, (item) => item.beanId);
  const purchaseItemsByPurchase = groupBy(data.purchaseItems, (item) => item.purchaseId);
  const sourcesByBean = groupBy(data.productSources, (source) => source.beanId);
  const visibleDrinksByBean = groupBy(data.drinkingRecords.filter((record) => !record.deletedAt), (record) => record.beanId);
  const reviewDrinksByBean = groupBy(data.drinkingRecords.filter((record) => !record.deletedAt && !record.isDraft), (record) => record.beanId);
  const purchaseHistory = new Map<string, GalleryItem['purchaseHistory']>();
  for (const purchase of data.purchases) {
    if (purchase.deletedAt) continue;
    const itemsByBean = groupBy(purchaseItemsByPurchase.get(purchase.id) ?? [], (item) => item.beanId);
    for (const [beanId, items] of itemsByBean) append(purchaseHistory, beanId, { purchase, items });
  }
  return data.beans.filter((bean) => !bean.archivedAt).map((bean, originalIndex) => {
    const assessment = assessments.get(bean.id) ?? null;
    const drinks = reviewDrinksByBean.get(bean.id) ?? [];
    const beanPurchaseItems = purchaseItemsByBean.get(bean.id) ?? [];
    const averageReview = (mode: 'americanoReview' | 'milkReview') => {
      const scores = drinks.map((record) => reviewedScore(record[mode])).filter((score): score is number => score !== null);
      return scores.length ? Math.round((scores.reduce((total, score) => total + score, 0) / scores.length) * 10) / 10 : null;
    };
    const badges = new Set<BeanBadge>();
    if (bean.followedAt) badges.add('followed');
    if (beanPurchaseItems.some((item) => activePurchaseIds.has(item.purchaseId) && item.bagStatus !== 'finished')) badges.add('purchased_waiting');
    if (drinks.length) badges.add(drinks.every(isDrinkingRecordReviewComplete) ? 'review_complete' : 'drank_pending_review');
    return {
      bean,
      brand: bean.brandId ? brands.get(bean.brandId) ?? null : null,
      price: bean.importedFacts?.referencePrice?.amount ?? null,
      roast: bean.roastLevel,
      grade: assessment?.grade ?? bean.legacyPersonalScoreRaw,
      assessment,
      badges: [...badges],
      scenes: bean.importedFacts?.suitableScenes ?? [],
      americanoScore: averageReview('americanoReview'),
      milkScore: averageReview('milkReview'),
      sources: sourcesByBean.get(bean.id) ?? [],
      purchaseHistory: purchaseHistory.get(bean.id) ?? [],
      drinkingHistory: (visibleDrinksByBean.get(bean.id) ?? []).map((record) => {
        const purchaseItem = record.purchaseItemId ? purchaseItems.get(record.purchaseItemId) ?? null : null;
        return { record, purchaseItem, purchase: purchaseItem ? purchases.get(purchaseItem.purchaseId) ?? null : null };
      }),
      originalIndex,
    };
  });
}

function groupBy<T>(values: T[], keyFor: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) append(groups, keyFor(value), value);
  return groups;
}

function append<T>(groups: Map<string, T[]>, key: string, value: T) {
  const values = groups.get(key);
  if (values) values.push(value);
  else groups.set(key, [value]);
}

function includes(value: string | null, query: string) {
  return value?.toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN')) ?? false;
}

function matchesPrice(price: number | null, filter: GalleryPriceFilter) {
  if (!filter) return true;
  if (filter === 'unknown') return price === null;
  if (price === null) return false;
  if (filter === 'under_100') return price < 100;
  if (filter === '100_199') return price >= 100 && price < 200;
  return price >= 200;
}

export function filterAndSortGalleryItems(items: GalleryItem[], filters: GalleryFilters, sort: GallerySort) {
  const query = filters.query.trim();
  const filtered = items.filter((item) => {
    const searchValues = [item.bean.name, item.brand, item.roast, item.bean.process, item.grade,
      item.bean.importedFacts?.originOrVariety ?? null, ...item.bean.flavorNotes, ...item.scenes];
    return (!query || searchValues.some((value) => includes(value, query)))
      && (!filters.brand || (filters.brand === 'unknown' ? item.brand === null : item.brand === filters.brand))
      && (!filters.roast || (filters.roast === 'unknown' ? item.roast === null : item.roast === filters.roast))
      && matchesPrice(item.price, filters.price)
      && (!filters.flavor || (filters.flavor === 'unknown' ? item.bean.flavorNotes.length === 0 : item.bean.flavorNotes.includes(filters.flavor)))
      && (!filters.process || (filters.process === 'unknown' ? item.bean.process === null : item.bean.process === filters.process))
      && (!filters.scene || (filters.scene === 'unknown' ? item.scenes.length === 0 : item.scenes.includes(filters.scene)))
      && (!filters.status || (filters.status === 'unknown' ? item.badges.length === 0 : item.badges.includes(filters.status)))
      && (!filters.grade || (filters.grade === 'unknown' ? item.grade === null : item.grade === filters.grade));
  });
  const valueFor = (item: GalleryItem): string | number | null => {
    if (sort.field === 'name') return item.bean.name;
    if (sort.field === 'brand') return item.brand;
    if (sort.field === 'price') return item.price;
    if (sort.field === 'roast') return item.roast;
    return item.grade;
  };
  return filtered.sort((left, right) => {
    const a = valueFor(left); const b = valueFor(right);
    if (a === null && b === null) return left.originalIndex - right.originalIndex;
    if (a === null) return 1;
    if (b === null) return -1;
    const comparison = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
    return comparison === 0 ? left.originalIndex - right.originalIndex : comparison * (sort.direction === 'asc' ? 1 : -1);
  });
}

export function uniqueKnown(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
