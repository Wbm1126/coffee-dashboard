import { describe, expect, it } from 'vitest';
import { CoffeeDataSchema, createEmptyCoffeeData } from '../../src/domain/schema.js';
import { migrateRawDocument } from '../../src/storage/migrations/index.js';

describe('coffee data schema', () => {
  it('creates a valid empty local document', () => {
    const empty = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    expect(CoffeeDataSchema.parse(empty)).toEqual(empty);
    expect(empty.dataRevision).toBe(0);
    expect(empty.preferenceProfile.brewMode).toBe('balanced');
  });

  it('defaults the additive acidity preference when reading an older v1 document', () => {
    const older = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z')) as unknown as Record<string, unknown>;
    const profile = older.preferenceProfile as Record<string, unknown>;
    delete profile.acidityPreference;
    expect(CoffeeDataSchema.parse(older).preferenceProfile.acidityPreference).toBe('any');
  });

  it('keeps formerly accepted opaque recommendation snapshots readable', () => {
    const older = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z')) as unknown as Record<string, unknown>;
    older.recommendationSnapshots = ['legacy-marker', { staleAt: null }];
    expect(CoffeeDataSchema.parse(older).recommendationSnapshots).toEqual(['legacy-marker', { staleAt: null }]);
  });

  it('compatibly reads older v1 review semantics and preserves opaque import metadata', () => {
    const older = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z')) as unknown as Record<string, unknown>;
    delete older.legacyImportBatches;
    delete older.legacyReviewScores;
    older.importBatches = [{ legacy: 'opaque import receipt' }];
    older.drinkingRecords = [{
      id: '00000000-0000-4000-8000-000000000011', beanId: '00000000-0000-4000-8000-000000000012',
      purchaseItemId: null, drankOn: '2026-08-01', brewMethod: 'americano', extractionNote: null, feeling: null,
      americanoReview: { state: 'unreviewed', score: 4, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: null, draftAssessment: null, isDraft: true, deletedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }];

    const migrated = migrateRawDocument(older);
    expect(migrated.drinkingRecords[0]?.americanoReview?.score).toBeNull();
    expect(migrated.importBatches).toEqual([]);
    expect(migrated.legacyImportBatches).toEqual([{ legacy: 'opaque import receipt' }]);
    expect(migrated.legacyReviewScores).toEqual([{
      drinkingRecordId: '00000000-0000-4000-8000-000000000011',
      dimension: 'americanoReview', state: 'unreviewed', score: 4,
    }]);
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
