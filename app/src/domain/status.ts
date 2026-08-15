import type { CoffeeData } from './schema.js';
import { isDrinkingRecordReviewComplete } from './review-completeness.js';

export type BeanBadge =
  | 'followed'
  | 'purchased_waiting'
  | 'drank_pending_review'
  | 'review_complete'
  | 'archived';

export function deriveBeanBadges(data: CoffeeData, beanId: string): BeanBadge[] {
  const bean = data.beans.find((candidate) => candidate.id === beanId);
  if (!bean) return [];
  if (bean.archivedAt) return ['archived'];

  const badges = new Set<BeanBadge>();
  if (bean.followedAt) badges.add('followed');

  const activePurchases = new Set(
    data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id),
  );
  const hasWaitingPurchase = data.purchaseItems.some(
    (item) =>
      item.beanId === beanId &&
      activePurchases.has(item.purchaseId) &&
      item.bagStatus !== 'finished',
  );
  if (hasWaitingPurchase) badges.add('purchased_waiting');

  const drinks = data.drinkingRecords.filter(
    (record) => record.beanId === beanId && !record.deletedAt && !record.isDraft,
  );
  if (drinks.length > 0) {
    const allComplete = drinks.every(isDrinkingRecordReviewComplete);
    badges.add(allComplete ? 'review_complete' : 'drank_pending_review');
  }

  return [...badges];
}
