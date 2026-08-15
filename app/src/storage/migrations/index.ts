import { CURRENT_SCHEMA_VERSION, CoffeeDataSchema, ImportBatchSchema, type CoffeeData } from '../../domain/schema.js';

export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly schemaVersion: number) {
    super(`数据版本 ${schemaVersion} 高于本应用支持的版本 ${CURRENT_SCHEMA_VERSION}。`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export function migrateRawDocument(raw: unknown): CoffeeData {
  if (!raw || typeof raw !== 'object') {
    throw new Error('数据文件不是有效对象。');
  }

  const version = Reflect.get(raw, 'schemaVersion');
  if (!Number.isInteger(version)) {
    throw new Error('数据文件缺少有效的 schemaVersion。');
  }
  if ((version as number) > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version as number);
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`暂不支持从数据版本 ${String(version)} 升级。`);
  }

  const compatible = structuredClone(raw) as Record<string, unknown>;
  const drinkingRecords = Array.isArray(compatible.drinkingRecords) ? compatible.drinkingRecords : [];
  const legacyReviewScores = Array.isArray(compatible.legacyReviewScores) ? [...compatible.legacyReviewScores] : [];
  for (const record of drinkingRecords) {
    if (!record || typeof record !== 'object') continue;
    for (const key of ['americanoReview', 'milkReview'] as const) {
      const review = Reflect.get(record, key);
      if (review && typeof review === 'object' && Reflect.get(review, 'state') !== 'reviewed') {
        const score = Reflect.get(review, 'score');
        if (typeof score === 'number') {
          legacyReviewScores.push({
            drinkingRecordId: String(Reflect.get(record, 'id') ?? ''),
            dimension: key,
            state: String(Reflect.get(review, 'state') ?? 'unknown'),
            score,
          });
        }
        Reflect.set(review, 'score', null);
      }
    }
  }
  compatible.legacyReviewScores = legacyReviewScores;

  const importBatches = Array.isArray(compatible.importBatches) ? compatible.importBatches : [];
  const validImportBatches: unknown[] = [];
  const legacyImportBatches = Array.isArray(compatible.legacyImportBatches) ? [...compatible.legacyImportBatches] : [];
  for (const batch of importBatches) {
    if (ImportBatchSchema.safeParse(batch).success) validImportBatches.push(batch);
    else legacyImportBatches.push(batch);
  }
  compatible.importBatches = validImportBatches;
  compatible.legacyImportBatches = legacyImportBatches;

  return CoffeeDataSchema.parse(compatible);
}
