import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRepository, RevisionConflictError } from '../../src/storage/json-repository.js';
import { sha256 } from '../../src/lib/sha256.js';

const tempDirs: string[] = [];

async function repositoryFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-repository-'));
  tempDirs.push(dataDir);
  const repository = new JsonRepository(dataDir);
  await repository.initialize();
  return { dataDir, repository };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JsonRepository', () => {
  it('initializes and commits one revision atomically', async () => {
    const { repository } = await repositoryFixture();
    const next = await repository.mutate(0, (draft) => {
      draft.preferenceProfile.brewMode = 'milk';
    });
    expect(next.dataRevision).toBe(1);
    expect((await repository.read()).preferenceProfile.brewMode).toBe('milk');
    expect(JSON.parse(await readFile(repository.dataFile, 'utf8')).dataRevision).toBe(1);
  });

  it('creates a validated recovery backup before every ordinary mutation', async () => {
    const { repository } = await repositoryFixture();
    await repository.mutate(0, (draft) => {
      draft.preferenceProfile.brewMode = 'milk';
    });
    const backups = await repository.backups.list();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ valid: true });

    await writeFile(repository.dataFile, '{damaged', 'utf8');
    const inspection = await repository.restoreBackup(backups[0]!.name);
    expect(inspection).toMatchObject({ mode: 'ready', data: { dataRevision: 2 } });
  });

  it('rejects a stale revision without changing the document', async () => {
    const { repository } = await repositoryFixture();
    await repository.mutate(0, () => undefined);
    await expect(repository.mutate(0, () => undefined)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await repository.read()).dataRevision).toBe(1);
  });

  it('does not rescan recovery backups during an ordinary data read', async () => {
    const { repository } = await repositoryFixture();
    let backupScans = 0;
    repository.backups.list = async () => { backupScans += 1; return []; };
    expect((await repository.read()).dataRevision).toBe(0);
    expect(backupScans).toBe(0);
    expect((await repository.inspect()).mode).toBe('ready');
    expect(backupScans).toBe(1);
  });

  it('enters recovery mode for damaged JSON instead of overwriting it', async () => {
    const { repository } = await repositoryFixture();
    await writeFile(repository.dataFile, '{damaged', 'utf8');
    const inspection = await repository.initialize();
    expect(inspection.mode).toBe('recovery');
    expect(await readFile(repository.dataFile, 'utf8')).toBe('{damaged');
  });

  it('enters recovery when the main file is missing but backup assets exist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coffee-repository-'));
    tempDirs.push(dataDir);
    const backupDir = join(dataDir, 'backups');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'orphan.json'), '{}', 'utf8');
    const repository = new JsonRepository(dataDir);

    const inspection = await repository.initialize();

    expect(inspection.mode).toBe('recovery');
    await expect(readFile(repository.dataFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a validated backup with a new monotonic revision and rejects the old revision', async () => {
    const { repository } = await repositoryFixture();
    await repository.mutate(0, (draft) => { draft.preferenceProfile.brewMode = 'milk'; });
    const backup = await repository.backups.create('known-good');
    await writeFile(repository.dataFile, '{damaged', 'utf8');

    const inspection = await repository.restoreBackup(backup.name);

    expect(inspection.mode).toBe('ready');
    if (inspection.mode !== 'ready') throw new Error('expected ready inspection');
    expect(inspection.data.dataRevision).toBe(2);
    expect(inspection.data.preferenceProfile.brewMode).toBe('milk');
    await expect(repository.mutate(1, () => undefined)).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('keeps the restore revision above the persisted high water after a restart', async () => {
    const { dataDir, repository } = await repositoryFixture();
    await repository.mutate(0, () => undefined);
    const oldBackup = await repository.backups.create('old-revision');
    await repository.mutate(1, () => undefined);
    await writeFile(repository.dataFile, '{damaged', 'utf8');

    const restarted = new JsonRepository(dataDir);
    const inspection = await restarted.restoreBackup(oldBackup.name);

    expect(inspection).toMatchObject({ mode: 'ready', data: { dataRevision: 3 } });
    await expect(restarted.mutate(2, () => undefined)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await restarted.read()).dataRevision).toBe(3);
  });

  it('ignores a corrupt revision high-water file and still uses a safe revision from the damaged main document', async () => {
    const { dataDir, repository } = await repositoryFixture();
    const backup = await repository.backups.create('known-good');
    const damagedButReadable = JSON.parse(await readFile(repository.dataFile, 'utf8')) as Record<string, unknown>;
    damagedButReadable.dataRevision = 7;
    damagedButReadable.brands = 'invalid';
    await writeFile(repository.dataFile, JSON.stringify(damagedButReadable), 'utf8');
    await writeFile(repository.revisionFile, '{corrupt', 'utf8');

    const restarted = new JsonRepository(dataDir);
    const inspection = await restarted.restoreBackup(backup.name);

    expect(inspection).toMatchObject({ mode: 'ready', data: { dataRevision: 8 } });
    await expect(restarted.mutate(7, () => undefined)).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('rejects a tampered backup without replacing the damaged main file', async () => {
    const { repository } = await repositoryFixture();
    const backup = await repository.backups.create('known-good');
    await writeFile(join(repository.backups.backupDir, backup.name), '{"tampered":true}', 'utf8');
    await writeFile(repository.dataFile, '{damaged', 'utf8');

    await expect(repository.restoreBackup(backup.name)).rejects.toThrow('校验失败');
    expect(await readFile(repository.dataFile, 'utf8')).toBe('{damaged');
  });

  it('rejects checksum-valid backup bytes that are not valid coffee data', async () => {
    const { repository } = await repositoryFixture();
    const backup = await repository.backups.create('known-good');
    const invalidBytes = Buffer.from('{"not":"coffee-data"}', 'utf8');
    const backupPath = join(repository.backups.backupDir, backup.name);
    await writeFile(backupPath, invalidBytes);
    await writeFile(`${backupPath}.sha256`, `${sha256(invalidBytes)}\n`, 'utf8');
    await writeFile(repository.dataFile, '{damaged', 'utf8');

    await expect(repository.restoreBackup(backup.name)).rejects.toThrow();
    expect(await readFile(repository.dataFile, 'utf8')).toBe('{damaged');
  });

  it('serializes restore with writes and never reuses the pre-recovery revision', async () => {
    const { repository } = await repositoryFixture();
    await repository.mutate(0, () => undefined);
    const backup = await repository.backups.create('before-damage');
    await writeFile(repository.dataFile, '{damaged', 'utf8');

    const restore = repository.restoreBackup(backup.name);
    const staleWrite = repository.mutate(1, () => undefined);

    await expect(restore).resolves.toMatchObject({ mode: 'ready', data: { dataRevision: 2 } });
    await expect(staleWrite).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await repository.read()).dataRevision).toBe(2);
  });

  it('does not allow a backup to overwrite healthy ready data', async () => {
    const { repository } = await repositoryFixture();
    const backup = await repository.backups.create('healthy');

    await expect(repository.restoreBackup(backup.name)).rejects.toThrow('当前不允许执行备份恢复');
    expect((await repository.read()).dataRevision).toBe(0);
  });

  it('opens a future schema as read-only', async () => {
    const { repository } = await repositoryFixture();
    await writeFile(repository.dataFile, JSON.stringify({ schemaVersion: 99 }), 'utf8');
    const inspection = await repository.inspect();
    expect(inspection.mode).toBe('read_only');
    if (inspection.mode === 'read_only') expect(inspection.schemaVersion).toBe(99);
  });
});
