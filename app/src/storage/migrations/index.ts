import { CURRENT_SCHEMA_VERSION, CoffeeDataSchema, ImportBatchSchema, type CoffeeData } from '../../domain/schema.js';

export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly schemaVersion: number) {
    super(`数据版本 ${schemaVersion} 高于本应用支持的版本 ${CURRENT_SCHEMA_VERSION}。`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

type RawDocument = Record<string, unknown>;

// 逐步迁移注册表：键为源版本，值为迁移到下一版本的纯函数。
// 迁移不得伪造数据：缺失容器补空数组，字段级缺省交给 zod 默认值。
const SCHEMA_MIGRATIONS: Record<number, (document: RawDocument) => RawDocument> = {
  1: migrateV1ToV2,
};

function migrateV1ToV2(document: RawDocument): RawDocument {
  // document 已是 migrateRawDocument 手中的私有克隆，此处原地修补即可。
  document.schemaVersion = 2;
  document.beanEvaluations = Array.isArray(document.beanEvaluations) ? document.beanEvaluations : [];
  return document;
}

export function migrateRawDocument(raw: unknown): CoffeeData {
  if (!raw || typeof raw !== 'object') {
    throw new Error('数据文件不是有效对象。');
  }

  let version = Reflect.get(raw, 'schemaVersion');
  if (!Number.isInteger(version)) {
    throw new Error('数据文件缺少有效的 schemaVersion。');
  }
  if ((version as number) > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version as number);
  }

  let document = structuredClone(raw) as RawDocument;
  while ((version as number) < CURRENT_SCHEMA_VERSION) {
    const previousVersion = version as number;
    const step = SCHEMA_MIGRATIONS[previousVersion];
    if (!step) {
      throw new Error(`暂不支持从数据版本 ${String(previousVersion)} 升级。`);
    }
    document = step(document);
    version = Reflect.get(document, 'schemaVersion');
    if (!Number.isInteger(version) || (version as number) <= previousVersion) {
      throw new Error(`迁移步骤 ${String(previousVersion)} 未正确递增 schemaVersion。`);
    }
    if ((version as number) > CURRENT_SCHEMA_VERSION) {
      throw new Error(`迁移步骤 ${String(previousVersion)} 越过了当前版本 ${String(CURRENT_SCHEMA_VERSION)}。`);
    }
  }

  const drinkingRecords = Array.isArray(document.drinkingRecords) ? document.drinkingRecords : [];
  const legacyReviewScores = Array.isArray(document.legacyReviewScores) ? [...document.legacyReviewScores] : [];
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
  document.legacyReviewScores = legacyReviewScores;

  const importBatches = Array.isArray(document.importBatches) ? document.importBatches : [];
  const validImportBatches: unknown[] = [];
  const legacyImportBatches = Array.isArray(document.legacyImportBatches) ? [...document.legacyImportBatches] : [];
  for (const batch of importBatches) {
    if (ImportBatchSchema.safeParse(batch).success) validImportBatches.push(batch);
    else legacyImportBatches.push(batch);
  }
  document.importBatches = validImportBatches;
  document.legacyImportBatches = legacyImportBatches;

  return CoffeeDataSchema.parse(document);
}
