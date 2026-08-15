import type { CoffeeData } from './schema.js';

export interface PurchaseLineDraft {
  purchaseItemId: string | null;
  beanId: string;
  quantity: number;
  packageGrams: number | null;
  paid: { amount: number; currency: string } | null;
}

export function unitPricePer100g(line: Pick<PurchaseLineDraft, 'quantity' | 'packageGrams' | 'paid'>): number | null {
  if (line.paid === null || line.packageGrams === null) return null;
  const totalGrams = line.packageGrams * line.quantity;
  if (totalGrams <= 0) return null;
  return Math.round((line.paid.amount / totalGrams) * 100 * 100) / 100;
}

export function purchaseImpact(data: CoffeeData, purchaseId: string) {
  const purchase = data.purchases.find((candidate) => candidate.id === purchaseId);
  if (!purchase) return null;
  const items = data.purchaseItems.filter((item) => item.purchaseId === purchaseId);
  const itemIds = new Set(items.map((item) => item.id));
  return {
    recordId: purchaseId,
    beanIds: [...new Set(items.map((item) => item.beanId))],
    purchaseItemCount: items.length,
    linkedDrinkingCount: data.drinkingRecords.filter((record) => record.purchaseItemId && itemIds.has(record.purchaseItemId)).length,
    consequences: ['bean_badges_recomputed', 'bag_statuses_recomputed', 'recommendations_expire'],
  };
}
