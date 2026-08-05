import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 1;

const Id = z.string().uuid();
const IsoInstant = z.string().datetime({ offset: true });
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const FieldProvenanceSchema = z.object({
  sourceKind: z.enum(['user', 'excel', 'official', 'search', 'derived']),
  sourceId: z.string().min(1),
  capturedAt: IsoInstant,
  rawValue: z.unknown().optional(),
  displayedText: z.string().optional(),
  location: z.string().optional(),
});

export const BrandSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(160)).default([]),
  archivedAt: IsoInstant.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const CoffeeBeanSchema = z.object({
  id: Id,
  brandId: Id.nullable().default(null),
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
  provenance: z.record(z.string(), z.array(FieldProvenanceSchema)).default({}),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ProductSourceSchema = z.object({
  id: Id,
  beanId: Id,
  url: z.string().url(),
  title: z.string().max(500).nullable().default(null),
  capturedAt: IsoInstant,
  fields: z.record(z.string(), FieldProvenanceSchema).default({}),
});

export const MoneySchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().length(3).default('CNY'),
});

export const PurchaseItemSchema = z.object({
  id: Id,
  purchaseId: Id,
  beanId: Id,
  quantity: z.number().int().positive(),
  packageGrams: z.number().positive().nullable().default(null),
  paid: MoneySchema.nullable().default(null),
  bagStatus: z.enum(['unknown', 'unopened', 'drinking', 'finished']).default('unknown'),
});

export const PurchaseSchema = z.object({
  id: Id,
  purchasedOn: LocalDate,
  channel: z.string().max(200).nullable().default(null),
  note: z.string().max(4_000).nullable().default(null),
  shipping: MoneySchema.nullable().default(null),
  discount: MoneySchema.nullable().default(null),
  itemIds: z.array(Id).min(1),
  deletedAt: IsoInstant.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ReviewSchema = z.object({
  state: z.enum(['unreviewed', 'reviewed', 'not_applicable']),
  score: z.number().min(1).max(5).multipleOf(0.5).nullable().default(null),
  flavorNotes: z.array(z.string().trim().min(1).max(100)).default([]),
  pros: z.string().max(4_000).nullable().default(null),
  cons: z.string().max(4_000).nullable().default(null),
  note: z.string().max(8_000).nullable().default(null),
});

export const DrinkingRecordSchema = z.object({
  id: Id,
  beanId: Id,
  purchaseItemId: Id.nullable().default(null),
  drankOn: LocalDate,
  brewMethod: z.enum(['americano', 'milk', 'espresso', 'other']),
  extractionNote: z.string().max(4_000).nullable().default(null),
  feeling: z.string().max(8_000).nullable().default(null),
  americanoReview: ReviewSchema.nullable().default(null),
  milkReview: ReviewSchema.nullable().default(null),
  isDraft: z.boolean().default(false),
  deletedAt: IsoInstant.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const UserBeanAssessmentSchema = z.object({
  id: Id,
  beanId: Id,
  grade: z.string().max(40).nullable().default(null),
  repurchase: z.enum(['yes', 'price_dependent', 'no']).nullable().default(null),
  summary: z.string().max(8_000).nullable().default(null),
  basedOnDrinkingIds: z.array(Id).default([]),
  updatedAt: IsoInstant,
});

export const PreferenceProfileSchema = z.object({
  brewMode: z.enum(['americano', 'milk', 'balanced']).default('balanced'),
  roastLevels: z.array(z.string().max(80)).default([]),
  flavorNotes: z.array(z.string().max(100)).default([]),
  avoidedFlavorNotes: z.array(z.string().max(100)).default([]),
  maxPricePer100g: z.number().positive().nullable().default(null),
  updatedAt: IsoInstant.nullable().default(null),
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
  recommendationSnapshots: z.array(z.unknown()),
  importBatches: z.array(z.unknown()),
  exportSnapshots: z.array(z.unknown()),
});

export type CoffeeData = z.infer<typeof CoffeeDataSchema>;
export type CoffeeBean = z.infer<typeof CoffeeBeanSchema>;

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
      roastLevels: [],
      flavorNotes: [],
      avoidedFlavorNotes: [],
      maxPricePer100g: null,
      updatedAt: null,
    },
    recommendationSnapshots: [],
    importBatches: [],
    exportSnapshots: [],
  };
}

