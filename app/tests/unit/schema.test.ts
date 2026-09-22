import { describe, expect, it } from 'vitest';
import { BeanEvaluationSchema, CoffeeDataSchema, createEmptyCoffeeData } from '../../src/domain/schema.js';
import { migrateRawDocument } from '../../src/storage/migrations/index.js';

describe('coffee data schema', () => {
  it('creates a valid empty local document', () => {
    const empty = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    expect(CoffeeDataSchema.parse(empty)).toEqual(empty);
    expect(empty.dataRevision).toBe(0);
    expect(empty.preferenceProfile.brewMode).toBe('balanced');
  });

  it('defaults the additive acidity preference when reading an older document', () => {
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

  it('compatibly reads older review semantics and preserves opaque import metadata', () => {
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

  it('fills v2 additive fields when reading a document written before v2', () => {
    const older = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z')) as unknown as Record<string, unknown>;
    const records = older.drinkingRecords as Array<Record<string, unknown>>;
    records.push({
      id: '00000000-0000-4000-8000-000000000021', beanId: '00000000-0000-4000-8000-000000000022',
      purchaseItemId: null, drankOn: '2026-08-01', brewMethod: 'milk', extractionNote: '旧记录', feeling: null,
      americanoReview: null, milkReview: null, draftAssessment: null, isDraft: false, deletedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    });
    delete older.beanEvaluations;

    const parsed = CoffeeDataSchema.parse(older);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.beanEvaluations).toEqual([]);
    expect(parsed.drinkingRecords[0]?.brewParams).toBeNull();
    expect(parsed.productSources[0] ?? null).toBeNull();
  });

  it('accepts a manual BeanEvaluation without date or tracks, keeping unknowns unknown', () => {
    const evaluation = BeanEvaluationSchema.parse({
      id: '00000000-0000-4000-8000-000000000041',
      beanId: '00000000-0000-4000-8000-000000000042',
      source: 'legacy_import',
      overallScore: 4.5,
      summary: '历史个人评分，无准确日期。',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
    expect(evaluation.evaluatedOn).toBeNull();
    expect(evaluation.brewMethod).toBeNull();
    expect(evaluation.sourceRecordId).toBeNull();
  });

  it('rejects a reviewed BeanEvaluation track without a score', () => {
    expect(
      BeanEvaluationSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000043',
        beanId: '00000000-0000-4000-8000-000000000044',
        source: 'manual',
        milkReview: { state: 'reviewed', score: null, flavorNotes: [], pros: null, cons: null, note: null },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
