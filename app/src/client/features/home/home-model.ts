import { isDrinkingRecordReviewComplete } from '../../../domain/review-completeness.js';
import { compareByRecency } from '../drinking/brew-recipe.js';
import type { CoffeeData } from '../../../domain/schema.js';

export interface HomeDrinkLine {
  record: CoffeeData['drinkingRecords'][number];
  beanName: string;
  /** 当前有评分的轨（奶咖优先于美式），可能为 null（两轨都未评）。 */
  score: number | null;
}

export interface HomeBeanLine {
  beanId: string;
  name: string;
  brand: string | null;
  roastLevel: string | null;
}

function sortedByRecency(records: CoffeeData['drinkingRecords']): CoffeeData['drinkingRecords'] {
  return [...records].sort(compareByRecency);
}

// 当前在喝：有未喝完的在库购买项（bagStatus = drinking）的豆。
export function currentlyDrinkingBeans(data: CoffeeData): HomeBeanLine[] {
  const brands = new Map(data.brands.map((brand) => [brand.id, brand.name]));
  const activePurchaseIds = new Set(data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id));
  const drinkingBeanIds = new Set(
    data.purchaseItems
      .filter((item) => item.bagStatus === 'drinking' && activePurchaseIds.has(item.purchaseId))
      .map((item) => item.beanId),
  );
  return data.beans
    .filter((bean) => !bean.archivedAt && drinkingBeanIds.has(bean.id))
    .map((bean) => ({ beanId: bean.id, name: bean.name, brand: bean.brandId ? brands.get(bean.brandId) ?? null : null, roastLevel: bean.roastLevel }));
}

// 最近喝过：按日期倒序的可见饮用记录（排除草稿；评分取有分的轨）。
export function recentDrinks(data: CoffeeData, limit = 5): HomeDrinkLine[] {
  const beanNames = new Map(data.beans.map((bean) => [bean.id, bean.name]));
  return sortedByRecency(data.drinkingRecords.filter((record) => !record.deletedAt && !record.isDraft))
    .slice(0, limit)
    .map((record) => ({
      record,
      beanName: beanNames.get(record.beanId) ?? '未知咖啡豆',
      score: record.milkReview?.score ?? record.americanoReview?.score ?? null,
    }));
}

// 待评价：已保存但任一轨未完成评价的可见正式记录。
export function pendingReviewDrinks(data: CoffeeData): HomeDrinkLine[] {
  const beanNames = new Map(data.beans.map((bean) => [bean.id, bean.name]));
  return sortedByRecency(data.drinkingRecords.filter((record) => !record.deletedAt && !record.isDraft && !isDrinkingRecordReviewComplete(record)))
    .map((record) => ({ record, beanName: beanNames.get(record.beanId) ?? '未知咖啡豆', score: record.milkReview?.score ?? record.americanoReview?.score ?? null }));
}

// 最近新增：按创建时间倒序的豆。
export function recentlyAddedBeans(data: CoffeeData, limit = 5): HomeBeanLine[] {
  return [...data.beans]
    .filter((bean) => !bean.archivedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map((bean) => ({ beanId: bean.id, name: bean.name, brand: bean.brandId ? data.brands.find((brand) => brand.id === bean.brandId)?.name ?? null : null, roastLevel: bean.roastLevel }));
}
