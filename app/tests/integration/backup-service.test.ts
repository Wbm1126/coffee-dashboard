import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupService,
  MAX_AUTOMATIC_BACKUPS,
  MAX_LISTED_AUTOMATIC_BACKUPS,
  MAX_LISTED_FORENSIC_BACKUPS,
} from '../../src/storage/backup-service.js';
import { sha256 } from '../../src/lib/sha256.js';

const tempDirs: string[] = [];

async function fixture(options?: ConstructorParameters<typeof BackupService>[2]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-backups-'));
  tempDirs.push(dataDir);
  const dataFile = join(dataDir, 'coffee-data.json');
  await writeFile(dataFile, '{"schemaVersion":1}', 'utf8');
  return { dataDir, dataFile, service: new BackupService(dataFile, dataDir, options) };
}

function automaticName(index: number) {
  const second = String(index % 60).padStart(2, '0');
  const minute = String(Math.floor(index / 60) % 60).padStart(2, '0');
  return `2026-08-15T12-${minute}-${second}-000Z-transaction-${index.toString(16).padStart(8, '0')}.json`;
}

async function writeValidPair(directory: string, name: string) {
  const content = Buffer.from(`{"name":"${name}"}`, 'utf8');
  await writeFile(join(directory, name), content);
  await writeFile(join(directory, `${name}.sha256`), `${sha256(content)}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('BackupService retention', () => {
  it('keeps only the newest fixed number of valid automatic backup pairs', async () => {
    const { service } = await fixture();
    await mkdir(service.backupDir, { recursive: true });
    for (let index = 0; index < MAX_AUTOMATIC_BACKUPS + 3; index += 1) {
      await writeValidPair(service.backupDir, automaticName(index));
    }

    const created = await service.create('transaction');
    const files = await readdir(service.backupDir);
    const automaticJson = files.filter((name) => /^2026-.*\.json$/.test(name));

    expect(created.retention).toEqual({ pruned: 4, warning: null });
    expect(automaticJson).toHaveLength(MAX_AUTOMATIC_BACKUPS);
    expect(files).not.toContain(automaticName(0));
    expect(files).not.toContain(`${automaticName(0)}.sha256`);
  });

  it('preserves unknown, orphaned, and checksum-invalid forensic files', async () => {
    const { service } = await fixture();
    await mkdir(service.backupDir, { recursive: true });
    for (let index = 0; index < MAX_AUTOMATIC_BACKUPS; index += 1) {
      await writeValidPair(service.backupDir, automaticName(index));
    }
    await writeValidPair(service.backupDir, 'manual-preserve.json');
    await writeFile(join(service.backupDir, 'orphan.json'), '{"keep":true}', 'utf8');
    const invalidName = automaticName(MAX_AUTOMATIC_BACKUPS + 1);
    await writeFile(join(service.backupDir, invalidName), '{"tampered":true}', 'utf8');
    await writeFile(join(service.backupDir, `${invalidName}.sha256`), 'not-the-checksum\n', 'utf8');

    await service.create('transaction');
    const files = await readdir(service.backupDir);

    expect(files).toContain('manual-preserve.json');
    expect(files).toContain('manual-preserve.json.sha256');
    expect(files).toContain('orphan.json');
    expect(files).toContain(invalidName);
    expect(files).toContain(`${invalidName}.sha256`);
  });

  it('lists manual, orphaned, and invalid evidence without exceeding either listing quota', async () => {
    const { service } = await fixture();
    await mkdir(service.backupDir, { recursive: true });
    for (let index = 0; index < MAX_AUTOMATIC_BACKUPS; index += 1) {
      await writeValidPair(service.backupDir, automaticName(index));
    }
    await writeValidPair(service.backupDir, 'manual-visible.json');
    await writeFile(join(service.backupDir, 'orphan-visible.json'), '{"keep":true}', 'utf8');
    const invalidName = automaticName(MAX_AUTOMATIC_BACKUPS + 1);
    await writeFile(join(service.backupDir, invalidName), '{"tampered":true}', 'utf8');
    await writeFile(join(service.backupDir, `${invalidName}.sha256`), 'wrong\n', 'utf8');

    const listed = await service.list();
    const automatic = listed.filter((entry) => /^\d{4}-/.test(entry.name));
    const forensic = listed.filter((entry) => !/^\d{4}-/.test(entry.name));

    expect(automatic).toHaveLength(MAX_LISTED_AUTOMATIC_BACKUPS);
    expect(forensic.length).toBeLessThanOrEqual(MAX_LISTED_FORENSIC_BACKUPS);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: invalidName, valid: false }),
      expect.objectContaining({ name: 'manual-visible.json', valid: true }),
      expect.objectContaining({ name: 'orphan-visible.json', valid: false }),
    ]));
  });

  it('bounds recovery validation work and reports cleanup failure without losing the new backup', async () => {
    let removeAttempts = 0;
    const { service } = await fixture({ removeFile: async () => {
      removeAttempts += 1;
      throw Object.assign(new Error('simulated'), { code: 'EACCES' });
    } });
    await mkdir(service.backupDir, { recursive: true });
    for (let index = 0; index < MAX_AUTOMATIC_BACKUPS + 2; index += 1) {
      await writeValidPair(service.backupDir, automaticName(index));
    }
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(service.backupDir, `unknown-${index}.json`), '{}', 'utf8');
    }

    const created = await service.create('transaction');
    const listed = await service.list();

    expect(created.retention).toEqual({ pruned: 0, warning: 'backup_retention_failed:EACCES' });
    expect(removeAttempts).toBe(1);
    expect(await readFile(join(service.backupDir, created.name), 'utf8')).toBe('{"schemaVersion":1}');
    expect(await readFile(join(service.backupDir, `${created.name}.sha256`), 'utf8')).toBe(`${created.checksum}\n`);
    expect(listed.filter((entry) => /^\d{4}-/.test(entry.name))).toHaveLength(MAX_LISTED_AUTOMATIC_BACKUPS);
    expect(listed.filter((entry) => !/^\d{4}-/.test(entry.name))).toHaveLength(20);
  });
});
