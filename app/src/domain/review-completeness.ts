import type { CoffeeData, DrinkingRecord, Review } from './schema.js';
import { normalizeLegacyStatus } from './legacy-status.js';

export interface CatchUpQueueItem {
  beanId: string;
  beanName: string;
  brandName: string | null;
  drinkingRecordId: string | null;
  drankOn: string | null;
  brewMethod: DrinkingRecord['brewMethod'] | null;
  reason: 'legacy_without_drinking_record' | 'incomplete_drinking_record' | 'draft_drinking_record';
  americanoReview: Review | null;
  milkReview: Review | null;
  extractionNote: string | null;
  feeling: string | null;
  assessment: {
    grade: string | null;
    repurchase: 'yes' | 'price_dependent' | 'no' | null;
    summary: string | null;
  } | null;
}

export interface CatchUpQueue {
  items: CatchUpQueueItem[];
  completed: number;
  total: number;
}

export function isReviewDimensionComplete(review: Review | null): boolean {
  return review?.state === 'not_applicable' || (review?.state === 'reviewed' && review.score !== null);
}

export function reviewedScore(review: Review | null): number | null {
  return review?.state === 'reviewed' ? review.score : null;
}

export function isDrinkingRecordReviewComplete(record: DrinkingRecord): boolean {
  return isReviewDimensionComplete(record.americanoReview) && isReviewDimensionComplete(record.milkReview);
}

function hasLegacyDrinkingFact(status: string | null): boolean {
  const normalized = normalizeLegacyStatus(status);
  return normalized === 'drank' || normalized === 'drinking';
}

export function buildCatchUpQueue(data: CoffeeData): CatchUpQueue {
  const brands = new Map(data.brands.map((brand) => [brand.id, brand.name]));
  const assessments = new Map(data.assessments.map((assessment) => [assessment.beanId, assessment]));
  const drinksByBean = new Map<string, DrinkingRecord[]>();
  for (const record of data.drinkingRecords) {
    if (record.deletedAt) continue;
    const bucket = drinksByBean.get(record.beanId) ?? [];
    bucket.push(record);
    drinksByBean.set(record.beanId, bucket);
  }
  const items: CatchUpQueueItem[] = [];
  let completed = 0;
  let total = 0;

  for (const bean of data.beans) {
    if (bean.archivedAt || bean.isDraft) continue;
    const visibleDrinks = (drinksByBean.get(bean.id) ?? [])
      .sort((left, right) => right.drankOn.localeCompare(left.drankOn) || right.updatedAt.localeCompare(left.updatedAt));
    const activeDrinks = visibleDrinks.filter((record) => !record.isDraft);
    const draftDrink = visibleDrinks.find((record) => record.isDraft);
    const assessment = assessments.get(bean.id) ?? null;
    const isLegacyDrink = hasLegacyDrinkingFact(bean.legacyStatusRaw);
    if (visibleDrinks.length === 0 && !isLegacyDrink) continue;

    total += 1;
    const incomplete = activeDrinks.find((record) => !isDrinkingRecordReviewComplete(record)) ?? draftDrink;
    if (!incomplete && activeDrinks.length > 0) {
      completed += 1;
      continue;
    }

    const visibleAssessment = incomplete?.isDraft ? incomplete.draftAssessment : assessment;
    items.push({
      beanId: bean.id,
      beanName: bean.name,
      brandName: bean.brandId ? (brands.get(bean.brandId) ?? null) : null,
      drinkingRecordId: incomplete?.id ?? null,
      drankOn: incomplete?.drankOn ?? null,
      brewMethod: incomplete?.brewMethod ?? null,
      reason: incomplete
        ? (incomplete.isDraft ? 'draft_drinking_record' : 'incomplete_drinking_record')
        : 'legacy_without_drinking_record',
      americanoReview: incomplete?.americanoReview ?? null,
      milkReview: incomplete?.milkReview ?? null,
      extractionNote: incomplete?.extractionNote ?? null,
      feeling: incomplete?.feeling ?? null,
      assessment: visibleAssessment ? {
        grade: visibleAssessment.grade,
        repurchase: visibleAssessment.repurchase,
        summary: visibleAssessment.summary,
      } : null,
    });
  }

  items.sort((left, right) => {
    if (left.reason !== right.reason) return left.reason === 'legacy_without_drinking_record' ? -1 : 1;
    return (left.drankOn ?? '').localeCompare(right.drankOn ?? '') || left.beanName.localeCompare(right.beanName, 'zh-CN');
  });
  return { items, completed, total };
}
