import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { sha256 } from '../lib/sha256.js';

export interface BackupEntry {
  name: string;
  checksum: string;
  valid: boolean;
  retention?: BackupRetentionResult;
}

export interface BackupRetentionResult {
  pruned: number;
  warning: string | null;
}

interface BackupServiceOptions {
  removeFile?: (path: string) => Promise<void>;
}

/**
 * Automatic transaction backups are intentionally generous for a personal,
 * local archive, while still bounding long-term disk use and recovery scans.
 */
export const MAX_AUTOMATIC_BACKUPS = 100;
export const MAX_LISTED_AUTOMATIC_BACKUPS = MAX_AUTOMATIC_BACKUPS;
export const MAX_LISTED_FORENSIC_BACKUPS = 100;
export const MAX_LISTED_BACKUPS = MAX_LISTED_AUTOMATIC_BACKUPS + MAX_LISTED_FORENSIC_BACKUPS;

const AUTOMATIC_BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9_-]{1,40}-[0-9a-f]{8}\.json$/i;

export class BackupService {
  readonly backupDir: string;

  constructor(
    private readonly dataFile: string,
    dataDir: string,
    private readonly options: BackupServiceOptions = {},
  ) {
    this.backupDir = join(dataDir, 'backups');
  }

  async create(reason: string): Promise<BackupEntry> {
    await mkdir(this.backupDir, { recursive: true });
    const safeReason = reason.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'manual';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${safeReason}-${randomUUID().slice(0, 8)}.json`;
    const target = join(this.backupDir, name);
    await copyFile(this.dataFile, target);
    const checksum = sha256(await readFile(target));
    await writeFile(`${target}.sha256`, `${checksum}\n`, 'utf8');
    const retention = await this.pruneAutomaticBackups();
    return { name, checksum, valid: true, retention };
  }

  async list(): Promise<BackupEntry[]> {
    await mkdir(this.backupDir, { recursive: true });
    const jsonNames = (await readdir(this.backupDir)).filter((name) => name.endsWith('.json')).sort().reverse();
    const automatic = jsonNames.filter((name) => AUTOMATIC_BACKUP_NAME.test(name));
    const other = jsonNames.filter((name) => !AUTOMATIC_BACKUP_NAME.test(name));
    const selected = [
      ...automatic.slice(0, MAX_LISTED_AUTOMATIC_BACKUPS),
      ...other.slice(0, MAX_LISTED_FORENSIC_BACKUPS),
    ];
    return Promise.all(selected.map((name) => this.validate(name)));
  }

  async readValidated(name: string): Promise<Buffer> {
    if (basename(name) !== name || !name.endsWith('.json')) {
      throw new Error('备份名称无效。');
    }
    const entry = await this.validate(name);
    if (!entry.valid) {
      throw new Error('备份不存在或校验失败。');
    }
    return readFile(join(this.backupDir, name));
  }

  private async validate(name: string): Promise<BackupEntry> {
    const file = join(this.backupDir, name);
    let checksum = '';
    let expected = '';
    try {
      checksum = sha256(await readFile(file));
      expected = (await readFile(`${file}.sha256`, 'utf8')).trim();
    } catch {
      // Missing or unreadable evidence remains visible but is never pruned.
    }
    return { name, checksum, valid: checksum.length > 0 && expected === checksum };
  }

  private async pruneAutomaticBackups(): Promise<BackupRetentionResult> {
    let pruned = 0;
    try {
      const names = await readdir(this.backupDir);
      const nameSet = new Set(names);
      const candidates = names
        .filter((name) => AUTOMATIC_BACKUP_NAME.test(name) && nameSet.has(`${name}.sha256`))
        .sort()
        .reverse();
      const valid: string[] = [];
      for (const name of candidates) {
        if ((await this.validate(name)).valid) valid.push(name);
      }

      const removeFile = this.options.removeFile ?? unlink;
      for (const name of valid.slice(MAX_AUTOMATIC_BACKUPS)) {
        const file = join(this.backupDir, name);
        await removeFile(file);
        await removeFile(`${file}.sha256`);
        pruned += 1;
      }
      return { pruned, warning: null };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'unknown';
      return { pruned, warning: `backup_retention_failed:${code}` };
    }
  }
}
