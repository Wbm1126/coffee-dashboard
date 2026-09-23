import { z } from 'zod';
import { MoneySchema } from '../domain/schema.js';

export const CollectionFieldKeySchema = z.enum([
  'brandName',
  'beanName',
  'roastLevel',
  'process',
  'flavorNotes',
  'originOrVariety',
  'officialFlavorDescription',
  'referencePrice',
  'packageGrams',
]);
export const COLLECTION_FIELD_KEYS = CollectionFieldKeySchema.options;

export const CollectionFieldsSchema = z.object({
  brandName: z.string().trim().min(1).max(160).optional(),
  beanName: z.string().trim().min(1).max(240).optional(),
  roastLevel: z.string().trim().min(1).max(80).optional(),
  process: z.string().trim().min(1).max(120).optional(),
  flavorNotes: z.array(z.string().trim().min(1).max(100)).max(24).optional(),
  originOrVariety: z.string().trim().min(1).max(1_000).optional(),
  officialFlavorDescription: z.string().trim().min(1).max(4_000).optional(),
  referencePrice: MoneySchema.optional(),
  packageGrams: z.number().positive().max(20_000).optional(),
}).strict();

export const CollectionCandidateSchema = z.object({
  // A manual fallback has no external source by design. If a link was supplied,
  // it remains traceable; a failed or unsafe network request must not make local
  // creation impossible.
  sourceUrl: z.string().url().max(2_000).optional(),
  title: z.string().trim().min(1).max(500),
  capturedAt: z.string().datetime({ offset: true }),
  sourceKind: z.enum(['official', 'search', 'user']),
  // U7 商品图片：页面声明的图片地址；本地缓存由确认流程异步完成，失败不影响入库。
  imageUrl: z.string().url().max(2_000).optional(),
  fields: CollectionFieldsSchema,
}).strict();

export const SearchCandidateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  url: z.string().url().max(2_000),
  snippet: z.string().trim().max(1_000).nullable(),
}).strict();

export type CollectionFieldKey = z.infer<typeof CollectionFieldKeySchema>;
export type CollectionFields = z.infer<typeof CollectionFieldsSchema>;
export type CollectionCandidate = z.infer<typeof CollectionCandidateSchema>;
export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;
