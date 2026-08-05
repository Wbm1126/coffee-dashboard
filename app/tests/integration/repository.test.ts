import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRepository, RevisionConflictError } from '../../src/storage/json-repository.js';

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

  it('rejects a stale revision without changing the document', async () => {
    const { repository } = await repositoryFixture();
    await repository.mutate(0, () => undefined);
    await expect(repository.mutate(0, () => undefined)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await repository.read()).dataRevision).toBe(1);
  });

  it('enters recovery mode for damaged JSON instead of overwriting it', async () => {
    const { repository } = await repositoryFixture();
    await writeFile(repository.dataFile, '{damaged', 'utf8');
    const inspection = await repository.initialize();
    expect(inspection.mode).toBe('recovery');
    expect(await readFile(repository.dataFile, 'utf8')).toBe('{damaged');
  });

  it('opens a future schema as read-only', async () => {
    const { repository } = await repositoryFixture();
    await writeFile(repository.dataFile, JSON.stringify({ schemaVersion: 99 }), 'utf8');
    const inspection = await repository.inspect();
    expect(inspection.mode).toBe('read_only');
    if (inspection.mode === 'read_only') expect(inspection.schemaVersion).toBe(99);
  });
});

