import { describe, expect, it } from 'vitest';
import { CoffeeDataSchema, createEmptyCoffeeData } from '../../src/domain/schema.js';

describe('coffee data schema', () => {
  it('creates a valid empty local document', () => {
    const empty = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    expect(CoffeeDataSchema.parse(empty)).toEqual(empty);
    expect(empty.dataRevision).toBe(0);
    expect(empty.preferenceProfile.brewMode).toBe('balanced');
  });

  it('rejects score increments outside half points', () => {
    const empty = createEmptyCoffeeData();
    empty.drinkingRecords.push({
      id: '00000000-0000-4000-8000-000000000001',
      beanId: '00000000-0000-4000-8000-000000000002',
      purchaseItemId: null,
      drankOn: '2026-08-06',
      brewMethod: 'americano',
      extractionNote: null,
      feeling: null,
      americanoReview: {
        state: 'reviewed',
        score: 4.2,
        flavorNotes: [],
        pros: null,
        cons: null,
        note: null,
      },
      milkReview: null,
      isDraft: false,
      deletedAt: null,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(CoffeeDataSchema.safeParse(empty).success).toBe(false);
  });
});

