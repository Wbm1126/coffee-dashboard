import type { CoffeeData } from './schema.js';
import { RecordCommandError } from './record-command-error.js';

export function soleBasisAssessments(data: CoffeeData, recordId: string) {
  return data.assessments.filter((assessment) => assessment.basedOnDrinkingIds.includes(recordId)
    && assessment.basedOnDrinkingIds.every((id) => id === recordId));
}

export function recomputeBagStatuses(data: CoffeeData): void {
  const activePurchases = new Set(data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id));
  const activeLinkedItems = new Set(data.drinkingRecords
    .filter((record) => !record.deletedAt && !record.isDraft && record.purchaseItemId !== null)
    .map((record) => record.purchaseItemId!));
  for (const item of data.purchaseItems) {
    if (!activePurchases.has(item.purchaseId) || item.bagStatus === 'finished') continue;
    item.bagStatus = activeLinkedItems.has(item.id) ? 'drinking' : 'unopened';
  }
}

export function drinkingImpact(data: CoffeeData, recordId: string) {
  const record = data.drinkingRecords.find((candidate) => candidate.id === recordId);
  if (!record) return null;
  const assessmentBasisConflicts = soleBasisAssessments(data, recordId)
    .map((assessment) => ({ assessmentId: assessment.id, beanId: assessment.beanId }));
  return {
    recordId,
    beanIds: [record.beanId],
    purchaseItemIds: record.purchaseItemId ? [record.purchaseItemId] : [],
    assessmentBasisConflicts,
    canPermanentlyDelete: assessmentBasisConflicts.length === 0,
    consequences: [
      'bean_badges_recomputed',
      ...(record.purchaseItemId ? ['bag_statuses_recomputed'] : []),
      'recommendations_expire',
      ...(assessmentBasisConflicts.length ? ['assessment_basis_must_be_preserved'] : []),
    ],
  };
}

export function assertPurchaseItemMatchesBean(data: CoffeeData, purchaseItemId: string | null, beanId: string): void {
  if (purchaseItemId === null) return;
  const item = data.purchaseItems.find((candidate) => candidate.id === purchaseItemId);
  const purchase = item && data.purchases.find((candidate) => candidate.id === item.purchaseId && !candidate.deletedAt);
  if (!item || !purchase) throw new RecordCommandError('purchase_item_not_found');
  if (item.beanId !== beanId) throw new RecordCommandError('purchase_item_bean_mismatch');
}
