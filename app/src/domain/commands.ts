import type { CoffeeData } from './schema.js';
import { recomputeBagStatuses, soleBasisAssessments } from './drinking.js';
import { RecordCommandError } from './record-command-error.js';

export function expireRecommendations(data: CoffeeData, now: string, staleBecauseRevision = data.dataRevision + 1): void {
  data.recommendationSnapshots = data.recommendationSnapshots.map((snapshot) => {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
    return { ...snapshot, staleAt: now, staleBecauseRevision };
  });
}

export function finishFactMutation(data: CoffeeData, now: string, staleBecauseRevision = data.dataRevision + 1): void {
  recomputeBagStatuses(data);
  expireRecommendations(data, now, staleBecauseRevision);
}

export function trashDrinkingRecord(data: CoffeeData, recordId: string, now: string, nextRevision = data.dataRevision + 1): void {
  const record = data.drinkingRecords.find((candidate) => candidate.id === recordId);
  if (!record) throw new RecordCommandError('drinking_record_not_found');
  if (record.deletedAt) throw new RecordCommandError('already_in_trash');
  record.deletedAt = now;
  record.updatedAt = now;
  finishFactMutation(data, now, nextRevision);
}

export function restoreDrinkingRecord(data: CoffeeData, recordId: string, now: string, nextRevision = data.dataRevision + 1): void {
  const record = data.drinkingRecords.find((candidate) => candidate.id === recordId);
  if (!record) throw new RecordCommandError('drinking_record_not_found');
  if (!record.deletedAt) throw new RecordCommandError('not_in_trash');
  const missingReferences: string[] = [];
  if (!data.beans.some((bean) => bean.id === record.beanId)) missingReferences.push(record.beanId);
  if (record.purchaseItemId && !data.purchaseItems.some((item) => item.id === record.purchaseItemId)) missingReferences.push(record.purchaseItemId);
  if (missingReferences.length) throw new RecordCommandError('restore_conflict', { missingReferences });
  record.deletedAt = null;
  record.updatedAt = now;
  finishFactMutation(data, now, nextRevision);
}

export function purgeDrinkingRecord(data: CoffeeData, recordId: string, now: string, nextRevision = data.dataRevision + 1): void {
  const index = data.drinkingRecords.findIndex((record) => record.id === recordId);
  if (index < 0) throw new RecordCommandError('drinking_record_not_found');
  if (!data.drinkingRecords[index]!.deletedAt) throw new RecordCommandError('permanent_clear_requires_trashed_record');
  const dependentAssessments = soleBasisAssessments(data, recordId);
  if (dependentAssessments.length > 0) {
    throw new RecordCommandError('assessment_basis_conflict', {
      assessmentIds: dependentAssessments.map((assessment) => assessment.id),
      beanIds: [...new Set(dependentAssessments.map((assessment) => assessment.beanId))],
    });
  }
  data.drinkingRecords.splice(index, 1);
  for (const assessment of data.assessments) {
    assessment.basedOnDrinkingIds = assessment.basedOnDrinkingIds.filter((id) => id !== recordId);
  }
  finishFactMutation(data, now, nextRevision);
}

export function beanDeleteImpact(data: CoffeeData, beanId: string) {
  const bean = data.beans.find((candidate) => candidate.id === beanId);
  if (!bean) return null;
  const purchaseItemCount = data.purchaseItems.filter((item) => item.beanId === beanId).length;
  const drinkingRecordCount = data.drinkingRecords.filter((record) => record.beanId === beanId).length;
  const assessmentCount = data.assessments.filter((assessment) => assessment.beanId === beanId).length;
  const sourceCount = data.productSources.filter((source) => source.beanId === beanId).length;
  const hasReferences = purchaseItemCount + drinkingRecordCount + assessmentCount + sourceCount > 0;
  const canPermanentlyDelete = !hasReferences && bean.isDraft;
  return { beanId, purchaseItemCount, drinkingRecordCount, assessmentCount, sourceCount,
    canPermanentlyDelete, action: canPermanentlyDelete ? 'permanently_delete' : 'archive' };
}
