import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  CoffeeDataSchema,
  createEmptyCoffeeData,
  type CoffeeData,
} from '../domain/schema.js';
import { BackupService, type BackupEntry } from './backup-service.js';
import { migrateRawDocument, UnsupportedSchemaVersionError } from './migrations/index.js';
import { sha256 } from '../lib/sha256.js';

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

export interface TransactionDecision<T> {
  commit: boolean;
  value: T;
}

export interface TransactionResult<T> {
  data: CoffeeData;
  value: T;
  backup: BackupEntry | null;
}

// 尚未迁移到当前版本的整份数据文档。
function isMigratableVersion(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const version = Reflect.get(raw, 'schemaVersion');
  return Number.isInteger(version) && (version as number) >= 1 && (version as number) < CURRENT_SCHEMA_VERSION;
}

export class JsonRepository {
  readonly dataFile: string;
  readonly revisionFile: string;
  readonly backups: BackupService;
  private writeQueue: Promise<void> = Promise.resolve();
  // 队列任务体（mutate/transact/restoreBackup）执行期间为 true，
  // 供 readCurrent 判断迁移是否必须内联执行（见 migrateCurrentDocument）。
  private insideQueuedTask = false;
  private highestObservedRevision = -1;

  constructor(readonly dataDir: string) {
    this.dataFile = join(dataDir, 'coffee-data.json');
    this.revisionFile = join(dataDir, 'coffee-data.revision.json');
    this.backups = new BackupService(this.dataFile, dataDir);
  }

  async initialize(): Promise<RepositoryInspection> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      await readFile(this.dataFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((await this.backups.list()).length > 0 || (await this.readRevisionHighWater()) >= 0) return this.inspect();
      await this.atomicReplace(createEmptyCoffeeData());
    }
    return this.inspect();
  }

  async inspect(): Promise<RepositoryInspection> {
    const backups = await this.backups.list();
    try {
      const data = await this.readCurrent();
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
    return structuredClone(await this.readCurrent());
  }

  mutate(
    expectedRevision: number,
    mutator: (draft: CoffeeData, nextRevision: number) => void | Promise<void>,
  ): Promise<CoffeeData> {
    const operation = this.writeQueue.then(async () => {
      this.insideQueuedTask = true;
      try {
        const current = await this.read();
        if (current.dataRevision !== expectedRevision) {
          throw new RevisionConflictError(expectedRevision, current.dataRevision);
        }
        const next = structuredClone(current);
        const nextRevision = await this.nextRevision(current.dataRevision);
        await mutator(next, nextRevision);
        next.dataRevision = nextRevision;
        next.updatedAt = new Date().toISOString();
        const validated = CoffeeDataSchema.parse(next);
        await this.backups.create('before-mutation');
        await this.atomicReplace(validated);
        return structuredClone(validated);
      } finally {
        this.insideQueuedTask = false;
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  transact<T>(
    expectedRevision: number,
    backupReason: string,
    transaction: (draft: CoffeeData) => TransactionDecision<T> | Promise<TransactionDecision<T>>,
  ): Promise<TransactionResult<T>> {
    const operation = this.writeQueue.then(async () => {
      this.insideQueuedTask = true;
      try {
        const current = await this.read();
        const next = structuredClone(current);
        const decision = await transaction(next);
        if (!decision.commit) {
          return { data: structuredClone(current), value: decision.value, backup: null };
        }
        if (current.dataRevision !== expectedRevision) {
          throw new RevisionConflictError(expectedRevision, current.dataRevision);
        }
        const backup = await this.backups.create(backupReason);
        next.dataRevision = await this.nextRevision(current.dataRevision);
        next.updatedAt = new Date().toISOString();
        const validated = CoffeeDataSchema.parse(next);
        await this.atomicReplace(validated);
        return { data: structuredClone(validated), value: decision.value, backup };
      } finally {
        this.insideQueuedTask = false;
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  restoreBackup(name: string): Promise<RepositoryInspection> {
    const operation = this.writeQueue.then(async () => {
      this.insideQueuedTask = true;
      try {
        return await this.restoreBackupTask(name);
      } finally {
        this.insideQueuedTask = false;
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async restoreBackupTask(name: string): Promise<RepositoryInspection> {
    const recoverableMainRevision = await this.readRecoverableMainRevision();
    try {
      await this.readCurrent();
      throw new Error('主数据仍可正常读取，当前不允许执行备份恢复。');
    } catch (error) {
      if (error instanceof UnsupportedSchemaVersionError) {
        throw new Error('当前是高版本只读数据，不能用旧备份覆盖。');
      }
      if (error instanceof Error && error.message === '主数据仍可正常读取，当前不允许执行备份恢复。') {
        throw error;
      }
    }

    const backupBytes = await this.backups.readValidated(name);
    const restored = migrateRawDocument(JSON.parse(backupBytes.toString('utf8')) as unknown);
    restored.dataRevision = await this.nextRevision(restored.dataRevision, recoverableMainRevision);
    restored.updatedAt = new Date().toISOString();
    const validated = CoffeeDataSchema.parse(restored);
    await this.atomicReplace(validated);
    this.observe(validated);
    return this.inspect();
  }

  private async atomicReplace(data: CoffeeData): Promise<void> {
    await mkdir(dirname(this.dataFile), { recursive: true });
    await this.persistRevisionHighWater(data.dataRevision);
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    const expectedChecksum = sha256(bytes);
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
    if (sha256(reopened) !== expectedChecksum) {
      throw new Error('数据文件写入后的校验和不一致，已停止继续写入。');
    }
  }

  private async readCurrent(): Promise<CoffeeData> {
    const rawText = await readFile(this.dataFile, 'utf8');
    const raw = JSON.parse(rawText) as unknown;
    if (isMigratableVersion(raw)) {
      return this.migrateCurrentDocument();
    }
    const data = migrateRawDocument(raw);
    this.observe(data);
    return data;
  }

  // 旧版本数据的自动迁移。串行规则：
  // - 队列任务内（mutate/transact/restoreBackup 的 read）：当前任务本身就是串行点，
  //   直接内联执行——再挂到 writeQueue 尾部会形成循环等待死锁；
  // - 队列外（GET 路由、inspect 等）：挂到 writeQueue，避免与并发写者互相覆盖，
  //   并在队内重读最新字节（排队期间其他写者可能已完成迁移）。
  // 先校验并算出迁移结果，再备份原始字节并原子落盘：注定失败的迁移不留备份。
  // 备份或落盘失败不阻塞读取：按内存结果继续，磁盘恢复后下次读取会自动重试落盘。
  private async migrateCurrentDocument(): Promise<CoffeeData> {
    const run = async (): Promise<CoffeeData> => {
      const latest = JSON.parse(await readFile(this.dataFile, 'utf8')) as unknown;
      if (!isMigratableVersion(latest)) return this.parsedCurrent(latest);
      const migrated = migrateRawDocument(latest);
      try {
        await this.backups.create('schema-migration');
        await this.atomicReplace(migrated);
      } catch (error) {
        process.stderr.write(`Schema 迁移落盘失败，已按内存结果继续，磁盘恢复后读取会自动重试：${String(error)}\n`);
      }
      this.observe(migrated);
      return migrated;
    };
    if (this.insideQueuedTask) {
      return run();
    }
    const migration = this.writeQueue.then(run);
    this.writeQueue = migration.then(
      () => undefined,
      () => undefined,
    );
    return migration;
  }

  private parsedCurrent(raw: unknown): CoffeeData {
    const data = migrateRawDocument(raw);
    this.observe(data);
    return data;
  }

  private observe(data: CoffeeData): void {
    this.highestObservedRevision = Math.max(this.highestObservedRevision, data.dataRevision);
  }

  private async nextRevision(...observed: number[]): Promise<number> {
    const highest = Math.max(
      this.highestObservedRevision,
      await this.readRevisionHighWater(),
      ...observed,
    );
    if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER) {
      throw new Error('数据 revision 已超出安全范围，已停止写入。');
    }
    return highest + 1;
  }

  private async readRecoverableMainRevision(): Promise<number> {
    try {
      const raw = JSON.parse(await readFile(this.dataFile, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return -1;
      const schemaVersion = Reflect.get(raw, 'schemaVersion');
      const revision = Reflect.get(raw, 'dataRevision');
      return schemaVersion === CURRENT_SCHEMA_VERSION && Number.isSafeInteger(revision) && (revision as number) >= 0
        ? revision as number
        : -1;
    } catch {
      return -1;
    }
  }

  private async readRevisionHighWater(): Promise<number> {
    try {
      const raw = JSON.parse(await readFile(this.revisionFile, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return -1;
      const revision = Reflect.get(raw, 'revision');
      const checksum = Reflect.get(raw, 'checksum');
      if (!Number.isSafeInteger(revision) || (revision as number) < 0) return -1;
      return checksum === this.revisionChecksum(revision as number) ? revision as number : -1;
    } catch {
      return -1;
    }
  }

  private async persistRevisionHighWater(revision: number): Promise<void> {
    const current = await this.readRevisionHighWater();
    if (revision <= current) return;
    const bytes = Buffer.from(`${JSON.stringify({ revision, checksum: this.revisionChecksum(revision) })}\n`, 'utf8');
    const temporary = `${this.revisionFile}.tmp-${randomUUID()}`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.revisionFile);
    if ((await this.readRevisionHighWater()) !== revision) {
      throw new Error('数据 revision 高水位写入后的校验不一致，已停止继续写入。');
    }
  }

  private revisionChecksum(revision: number): string {
    return sha256(Buffer.from(`coffee-data-revision:${revision}`, 'utf8'));
  }
}
