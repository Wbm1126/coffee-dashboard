import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

export interface BackupEntry {
  name: string;
  checksum: string;
  valid: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class BackupService {
  readonly backupDir: string;

  constructor(
    private readonly dataFile: string,
    dataDir: string,
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
    return { name, checksum, valid: true };
  }

  async list(): Promise<BackupEntry[]> {
    await mkdir(this.backupDir, { recursive: true });
    const names = (await readdir(this.backupDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse();
    return Promise.all(
      names.map(async (name) => {
        const file = join(this.backupDir, name);
        const checksum = sha256(await readFile(file));
        let expected = '';
        try {
          expected = (await readFile(`${file}.sha256`, 'utf8')).trim();
        } catch {
          expected = '';
        }
        return { name, checksum, valid: expected === checksum };
      }),
    );
  }

  async restore(name: string): Promise<void> {
    if (basename(name) !== name || !name.endsWith('.json')) {
      throw new Error('备份名称无效。');
    }
    const entry = (await this.list()).find((candidate) => candidate.name === name);
    if (!entry?.valid) {
      throw new Error('备份不存在或校验失败。');
    }

    const source = join(this.backupDir, name);
    const temporary = `${this.dataFile}.restore-${randomUUID()}`;
    await copyFile(source, temporary);
    try {
      await rename(temporary, this.dataFile);
    } catch (error) {
      const quarantine = `${temporary}.quarantine-${Date.now()}`;
      await rename(temporary, quarantine).catch(() => undefined);
      throw error;
    }
  }
}

