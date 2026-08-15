import { z } from 'zod';
import { ImportConflictChoiceSchema } from './import-contract.js';

export const CURRENT_SCHEMA_VERSION = 1;

export const IdSchema = z.string().uuid();
const IsoInstant = z.string().datetime({ offset: true });
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const BrewMethodSchema = z.enum(['americano', 'milk', 'espresso', 'other']);
export const RepurchaseSchema = z.enum(['yes', 'price_dependent', 'no']);

export const FieldProvenanceSchema = z.object({
  sourceKind: z.enum(['user', 'excel', 'official', 'search', 'derived']),
  sourceId: z.string().min(1),
  capturedAt: IsoInstant,
  rawValue: z.unknown().optional(),
  displayedText: z.string().optional(),
  numberFormat: z.string().nullable().optional(),
  location: z.string().optional(),
});

export const MoneySchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().length(3).default('CNY'),
});

export const BrandSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(160)).default([]),
  archivedAt: IsoInstant.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const CoffeeBeanSchema = z.object({
  id: IdSchema,
  brandId: IdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(240),
  normalizedKey: z.string().min(1).max(480),
  roastLevel: z.string().max(80).nullable().default(null),
  process: z.string().max(120).nullable().default(null),
  flavorNotes: z.array(z.string().trim().min(1).max(100)).default([]),
  followedAt: IsoInstant.nullable().default(null),
  archivedAt: IsoInstant.nullable().default(null),
  isDraft: z.boolean().default(false),
  legacyStatusRaw: z.string().max(120).nullable().default(null),
  legacyPersonalScoreRaw: z.string().max(120).nullable().default(null),
  importedFacts: z
    .object({
      overallScoreRaw: z.string().max(120).nullable(),
      preferenceMatchRaw: z.string().max(120).nullable(),
      recommendationRaw: z.string().max(120).nullable(),
      referencePrice: MoneySchema.nullable(),
      pricePerGram: z.number().finite().nonnegative().nullable(),
      packageGrams: z.number().positive().nullable(),
      originOrVariety: z.string().max(1_000).nullable(),
      officialFlavorDescription: z.string().max(4_000).nullable(),
      americanoPerformance: z.string().max(4_000).nullable(),
      milkPerformance: z.string().max(4_000).nullable(),
      suitableScenes: z.array(z.string().max(200)),
      legacyNote: z.string().max(8_000).nullable(),
      legacyScoreBasisRaw: z.string().max(4_000).nullable(),
    })
    .optional(),
  provenance: z.record(z.string(), z.array(FieldProvenanceSchema)).default({}),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ProductSourceSchema = z.object({
  id: IdSchema,
  beanId: IdSchema,
  url: z.string().url(),
  title: z.string().max(500).nullable().default(null),
  capturedAt: IsoInstant,
  fields: z.record(z.string(), FieldProvenanceSchema).default({}),
});

export const PurchaseItemSchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema,
  beanId: IdSchema,
  quantity: z.number().int().positive(),
  packageGrams: z.number().positive().nullable().default(null),
  paid: MoneySchema.nullable().default(null),
  bagStatus: z.enum(['unknown', 'unopened', 'drinking', 'finished']).default('unknown'),
});

export const PurchaseSchema = z.object({
  id: IdSchema,
  purchasedOn: LocalDateSchema,
  channel: z.string().max(200).nullable().default(null),
  note: z.string().max(4_000).nullable().default(null),
  shipping: MoneySchema.nullable().default(null),
  discount: MoneySchema.nullable().default(null),
  itemIds: z.array(IdSchema).min(1),
  deletedAt: IsoInstant.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ReviewSchema = z
  .object({
    state: z.enum(['unreviewed', 'reviewed', 'not_applicable']),
    score: z.number().min(1).max(5).multipleOf(0.5).nullable().default(null),
    flavorNotes: z.array(z.string().trim().min(1).max(100)).default([]),
    pros: z.string().max(4_000).nullable().default(null),
    cons: z.string().max(4_000).nullable().default(null),
    note: z.string().max(8_000).nullable().default(null),
  })
  .superRefine((review, context) => {
    if (review.state !== 'reviewed' && review.score !== null) {
      context.addIssue({ code: 'custom', path: ['score'], message: '未评价或不适用维度不得保存评分。' });
    }
  });

export const DraftAssessmentSchema = z.object({
  grade: z.string().max(40).nullable().default(null),
  repurchase: RepurchaseSchema.nullable().default(null),
  summary: z.string().max(8_000).nullable().default(null),
});

export const DrinkingRecordSchema = z
  .object({
    id: IdSchema,
    beanId: IdSchema,
    purchaseItemId: IdSchema.nullable().default(null),
    drankOn: LocalDateSchema,
    brewMethod: BrewMethodSchema,
    extractionNote: z.string().max(4_000).nullable().default(null),
    feeling: z.string().max(8_000).nullable().default(null),
    americanoReview: ReviewSchema.nullable().default(null),
    milkReview: ReviewSchema.nullable().default(null),
    draftAssessment: DraftAssessmentSchema.nullable().default(null),
    isDraft: z.boolean().default(false),
    deletedAt: IsoInstant.nullable().default(null),
    createdAt: IsoInstant,
    updatedAt: IsoInstant,
  })
  .superRefine((record, context) => {
    if (record.isDraft) return;
    for (const field of ['americanoReview', 'milkReview'] as const) {
      if (record[field]?.state === 'reviewed' && record[field].score === null) {
        context.addIssue({
          code: 'custom',
          path: [field, 'score'],
          message: '已评价维度必须填写 1–5 分评分。',
        });
      }
    }
  });

export const UserBeanAssessmentSchema = z.object({
  id: IdSchema,
  beanId: IdSchema,
  grade: z.string().max(40).nullable().default(null),
  repurchase: RepurchaseSchema.nullable().default(null),
  summary: z.string().max(8_000).nullable().default(null),
  basedOnDrinkingIds: z.array(IdSchema).default([]),
  updatedAt: IsoInstant,
});

export const PreferenceProfileSchema = z.object({
  brewMode: z.enum(['americano', 'milk', 'balanced']).default('balanced'),
  acidityPreference: z.enum(['any', 'low', 'medium', 'high']).default('any'),
  roastLevels: z.array(z.string().max(80)).default([]),
  flavorNotes: z.array(z.string().max(100)).default([]),
  avoidedFlavorNotes: z.array(z.string().max(100)).default([]),
  maxPricePer100g: z.number().positive().nullable().default(null),
  updatedAt: IsoInstant.nullable().default(null),
});

export const RecommendationFactorSchema = z.object({
  key: z.enum(['explicit', 'brew', 'flavor', 'price', 'interest']),
  label: z.string().min(1).max(80),
  weight: z.number().nonnegative().max(100),
  contribution: z.number().nonnegative().max(100),
  evidence: z.string().min(1).max(500),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const RecommendationItemSchema = z.object({
  beanId: IdSchema,
  score: z.number().nonnegative().max(100),
  confidence: z.enum(['high', 'medium', 'low']),
  factors: z.array(RecommendationFactorSchema).min(1).max(3),
  allFactors: z.array(RecommendationFactorSchema).length(5),
  missingData: z.array(z.string().min(1).max(240)),
});

export const RecommendationExclusionSchema = z.object({
  beanId: IdSchema,
  track: z.enum(['worth_trying', 'repurchase']),
  reason: z.enum(['draft', 'archived', 'already_tried', 'not_tried', 'explicit_no_repurchase']),
});

export const RecommendationSnapshotSchema = z.object({
  id: IdSchema,
  dataRevision: z.number().int().nonnegative(),
  ruleVersion: z.string().min(1).max(80),
  generatedAt: IsoInstant,
  staleAt: IsoInstant.nullable().default(null),
  staleBecauseRevision: z.number().int().nonnegative().nullable().default(null),
  worthTrying: z.array(RecommendationItemSchema),
  repurchase: z.array(RecommendationItemSchema),
  exclusions: z.array(RecommendationExclusionSchema),
});

export const ImportBatchSchema = z.object({
  id: IdSchema,
  batchKey: z.string().length(64),
  sourceFileNames: z.object({ complete: z.string().min(1), selection: z.string().min(1) }),
  fileHashes: z.object({ complete: z.string().length(64), selection: z.string().length(64) }),
  counts: z.object({
    beans: z.number().int().nonnegative(),
    brands: z.number().int().nonnegative(),
    untried: z.number().int().nonnegative(),
    drank: z.number().int().nonnegative(),
    drinking: z.number().int().nonnegative(),
    legacyScores: z.number().int().nonnegative(),
  }),
  conflictResolutions: z.record(z.string(), ImportConflictChoiceSchema),
  skippedBeanKeys: z.array(z.string().min(1)).default([]),
  createdAt: IsoInstant,
  committedAt: IsoInstant,
});

export const CollectionOperationSchema = z.object({
  key: IdSchema,
  requestHash: z.string().length(64),
  action: z.enum(['create', 'merge']),
  beanId: IdSchema,
  dataRevision: z.number().int().nonnegative(),
  completedAt: IsoInstant,
});

export const LegacyReviewScoreSchema = z.object({
  drinkingRecordId: z.string().min(1),
  dimension: z.enum(['americanoReview', 'milkReview']),
  state: z.string().min(1),
  score: z.number(),
});

export const CoffeeDataSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  dataRevision: z.number().int().nonnegative(),
  updatedAt: IsoInstant,
  brands: z.array(BrandSchema),
  beans: z.array(CoffeeBeanSchema),
  productSources: z.array(ProductSourceSchema),
  purchases: z.array(PurchaseSchema),
  purchaseItems: z.array(PurchaseItemSchema),
  drinkingRecords: z.array(DrinkingRecordSchema),
  assessments: z.array(UserBeanAssessmentSchema),
  preferenceProfile: PreferenceProfileSchema,
  // U1 accepted this rebuildable layer as unknown. Keep every formerly valid
  // value readable; recommendation consumers parse current snapshots themselves.
  recommendationSnapshots: z.array(z.unknown()),
  importBatches: z.array(ImportBatchSchema),
  legacyImportBatches: z.array(z.unknown()).default([]),
  legacyReviewScores: z.array(LegacyReviewScoreSchema).default([]),
  exportSnapshots: z.array(z.unknown()),
  collectionOperations: z.array(CollectionOperationSchema).optional(),
});

export type CoffeeData = z.infer<typeof CoffeeDataSchema>;
export type CoffeeBean = z.infer<typeof CoffeeBeanSchema>;
export type ImportBatch = z.infer<typeof ImportBatchSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type DrinkingRecord = z.infer<typeof DrinkingRecordSchema>;
export type BrewMethod = z.infer<typeof BrewMethodSchema>;
export type Repurchase = z.infer<typeof RepurchaseSchema>;
export type PreferenceProfile = z.infer<typeof PreferenceProfileSchema>;
export type RecommendationSnapshot = z.infer<typeof RecommendationSnapshotSchema>;
export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;
export type RecommendationFactor = z.infer<typeof RecommendationFactorSchema>;

export function createEmptyCoffeeData(now = new Date()): CoffeeData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dataRevision: 0,
    updatedAt: now.toISOString(),
    brands: [],
    beans: [],
    productSources: [],
    purchases: [],
    purchaseItems: [],
    drinkingRecords: [],
    assessments: [],
    preferenceProfile: {
      brewMode: 'balanced',
      acidityPreference: 'any',
      roastLevels: [],
      flavorNotes: [],
      avoidedFlavorNotes: [],
      maxPricePer100g: null,
      updatedAt: null,
    },
    recommendationSnapshots: [],
    importBatches: [],
    legacyImportBatches: [],
    legacyReviewScores: [],
    exportSnapshots: [],
    collectionOperations: [],
  };
}
