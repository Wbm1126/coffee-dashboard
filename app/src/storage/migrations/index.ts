import { CURRENT_SCHEMA_VERSION, CoffeeDataSchema, type CoffeeData } from '../../domain/schema.js';

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

  return CoffeeDataSchema.parse(raw);
}

