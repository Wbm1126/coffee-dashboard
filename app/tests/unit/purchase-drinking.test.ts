import { describe, expect, it } from 'vitest';
import { purgeDrinkingRecord } from '../../src/domain/commands.js';
import { recomputeBagStatuses } from '../../src/domain/drinking.js';
import { unitPricePer100g } from '../../src/domain/purchase.js';
import { RecordCommandError } from '../../src/domain/record-command-error.js';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';

describe('purchase price derivation', () => {
  it('derives per-100g price only when paid amount and package size are known', () => {
    expect(unitPricePer100g({ quantity: 2, packageGrams: 250, paid: { amount: 176, currency: 'CNY' } })).toBe(35.2);
    expect(unitPricePer100g({ quantity: 2, packageGrams: 250, paid: null })).toBeNull();
    expect(unitPricePer100g({ quantity: 2, packageGrams: null, paid: { amount: 176, currency: 'CNY' } })).toBeNull();
  });
});

describe('drinking package-state derivation', () => {
  it('recomputes linked packages while preserving an explicitly finished package', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    const purchaseId = '00000000-0000-4000-8000-000000000201';
    const beanId = '00000000-0000-4000-8000-000000000202';
    const linked = '00000000-0000-4000-8000-000000000203';
    const finished = '00000000-0000-4000-8000-000000000204';
    data.purchases.push({ id: purchaseId, purchasedOn: '2026-08-01', channel: null, note: null,
      shipping: null, discount: null, itemIds: [linked, finished], deletedAt: null,
      createdAt: data.updatedAt, updatedAt: data.updatedAt });
    data.purchaseItems.push(
      { id: linked, purchaseId, beanId, quantity: 1, packageGrams: 250, paid: null, bagStatus: 'unknown' },
      { id: finished, purchaseId, beanId, quantity: 1, packageGrams: 250, paid: null, bagStatus: 'finished' },
    );
    data.drinkingRecords.push({ id: '00000000-0000-4000-8000-000000000205', beanId, purchaseItemId: linked,
      drankOn: '2026-08-05', brewMethod: 'americano', extractionNote: null, feeling: null,
      americanoReview: null, milkReview: null, draftAssessment: null, isDraft: false, deletedAt: null,
      createdAt: data.updatedAt, updatedAt: data.updatedAt });

    recomputeBagStatuses(data);
    expect(data.purchaseItems.map((item) => item.bagStatus)).toEqual(['drinking', 'finished']);
    data.drinkingRecords[0]!.deletedAt = data.updatedAt;
    recomputeBagStatuses(data);
    expect(data.purchaseItems.map((item) => item.bagStatus)).toEqual(['unopened', 'finished']);
  });

  it('refuses to purge the sole provenance of an assessment but removes a redundant reference', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    const beanId = '00000000-0000-4000-8000-000000000211';
    const recordId = '00000000-0000-4000-8000-000000000212';
    const otherRecordId = '00000000-0000-4000-8000-000000000213';
    data.drinkingRecords.push({ id: recordId, beanId, purchaseItemId: null,
      drankOn: '2026-08-05', brewMethod: 'americano', extractionNote: null, feeling: null,
      americanoReview: null, milkReview: null, draftAssessment: null, isDraft: false, deletedAt: data.updatedAt,
      createdAt: data.updatedAt, updatedAt: data.updatedAt });
    data.assessments.push({ id: '00000000-0000-4000-8000-000000000214', beanId,
      grade: 'A', repurchase: 'yes', summary: '唯一依据', basedOnDrinkingIds: [recordId], updatedAt: data.updatedAt });

    expect(() => purgeDrinkingRecord(data, recordId, data.updatedAt)).toThrowError(
      expect.objectContaining<RecordCommandError>({ code: 'assessment_basis_conflict' }),
    );
    expect(data.drinkingRecords).toHaveLength(1);
    expect(data.assessments[0]!.basedOnDrinkingIds).toEqual([recordId]);

    data.assessments[0]!.basedOnDrinkingIds.push(otherRecordId);
    purgeDrinkingRecord(data, recordId, data.updatedAt);
    expect(data.drinkingRecords).toHaveLength(0);
    expect(data.assessments[0]!.basedOnDrinkingIds).toEqual([otherRecordId]);
  });
});
