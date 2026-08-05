import type { CoffeeData } from './schema.js';

export type BeanBadge =
  | 'followed'
  | 'purchased_waiting'
  | 'drank_pending_review'
  | 'review_complete'
  | 'archived';

function reviewIsComplete(state: string | undefined): boolean {
  return state === 'reviewed' || state === 'not_applicable';
}

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
    const allComplete = drinks.every((record) => {
      const dimensions = [record.americanoReview, record.milkReview];
      return dimensions.every((review) => review !== null && reviewIsComplete(review.state));
    });
    badges.add(allComplete ? 'review_complete' : 'drank_pending_review');
  }

  return [...badges];
}
