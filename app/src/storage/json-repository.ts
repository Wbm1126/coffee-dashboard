import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CoffeeDataSchema,
  createEmptyCoffeeData,
  type CoffeeData,
} from '../domain/schema.js';
import { BackupService, type BackupEntry } from './backup-service.js';
import { migrateRawDocument, UnsupportedSchemaVersionError } from './migrations/index.js';

export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`数据已更新：期望 revision ${expected}，实际为 ${actual}。`);
    this.name = 'RevisionConflictError';
  }
}

export type RepositoryInspection =
  | { mode: 'ready'; data: CoffeeData; backups: BackupEntry[] }
  | { mode: 'read_only'; reason: string; schemaVersion: number; backups: BackupEntry[] }
  | { mode: 'recovery'; reason: string; backups: BackupEntry[] };

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class JsonRepository {
  readonly dataFile: string;
  readonly backups: BackupService;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {
    this.dataFile = join(dataDir, 'coffee-data.json');
    this.backups = new BackupService(this.dataFile, dataDir);
  }

  async initialize(): Promise<RepositoryInspection> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      await readFile(this.dataFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.atomicReplace(createEmptyCoffeeData());
    }
    return this.inspect();
  }

  async inspect(): Promise<RepositoryInspection> {
    const backups = await this.backups.list();
    try {
      const rawText = await readFile(this.dataFile, 'utf8');
      const raw = JSON.parse(rawText) as unknown;
      const data = migrateRawDocument(raw);
      return { mode: 'ready', data, backups };
    } catch (error) {
      if (error instanceof UnsupportedSchemaVersionError) {
        return {
          mode: 'read_only',
          reason: error.message,
          schemaVersion: error.schemaVersion,
          backups,
        };
      }
      return {
        mode: 'recovery',
        reason: error instanceof Error ? error.message : '数据文件无法读取。',
        backups,
      };
    }
  }

  async read(): Promise<CoffeeData> {
    const inspection = await this.inspect();
    if (inspection.mode !== 'ready') {
      throw new Error(inspection.reason);
    }
    return structuredClone(inspection.data);
  }

  mutate(
    expectedRevision: number,
    mutator: (draft: CoffeeData) => void | Promise<void>,
  ): Promise<CoffeeData> {
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      if (current.dataRevision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, current.dataRevision);
      }
      const next = structuredClone(current);
      await mutator(next);
      next.dataRevision += 1;
      next.updatedAt = new Date().toISOString();
      const validated = CoffeeDataSchema.parse(next);
      await this.atomicReplace(validated);
      return structuredClone(validated);
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async restoreBackup(name: string): Promise<RepositoryInspection> {
    await this.backups.restore(name);
    return this.inspect();
  }

  private async atomicReplace(data: CoffeeData): Promise<void> {
    await mkdir(dirname(this.dataFile), { recursive: true });
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    const expectedChecksum = checksum(bytes);
    const temporary = `${this.dataFile}.tmp-${randomUUID()}`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, this.dataFile);
    } catch (error) {
      const quarantine = `${this.dataFile}.quarantine-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await rename(temporary, quarantine).catch(async () => {
        await writeFile(`${temporary}.failed`, String(error), 'utf8').catch(() => undefined);
      });
      throw error;
    }

    const reopened = await readFile(this.dataFile);
    if (checksum(reopened) !== expectedChecksum) {
      throw new Error('数据文件写入后的校验和不一致，已停止继续写入。');
    }
  }
}

