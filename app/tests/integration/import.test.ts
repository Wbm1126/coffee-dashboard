import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitImportPreview,
  InvalidImportResolutionError,
  UnresolvedImportConflictError,
  UnresolvedImportItemError,
} from '../../src/import/xlsx/commit-service.js';
import { createImportPreview } from '../../src/import/xlsx/preview-service.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import { buildRepresentativeWorkbooks } from '../fixtures/import/build-workbooks.js';

const tempDirs: string[] = [];

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-import-'));
  tempDirs.push(dataDir);
  const repository = new JsonRepository(dataDir);
  await repository.initialize();
  return { repository, files: await buildRepresentativeWorkbooks() };
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Excel import commit', () => {
  it('surfaces duplicate normalized rows instead of silently keeping the last row', async () => {
    const { repository } = await fixture();
    const files = await buildRepresentativeWorkbooks({ duplicateComplete: true });
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    expect(preview.categories.unrecognized).toBe(1);
    expect(preview.items.find((item) => item.beanName === '晨光')).toMatchObject({
      category: 'unrecognized',
      reason: 'duplicate_complete',
      bean: null,
    });
    expect(preview.summary.beans).toBe(1);
  });

  it('requires a conflict choice before an imported value can replace an existing roast', async () => {
    const { repository, files } = await fixture();
    await repository.mutate(0, (draft) => {
      draft.beans.push({
        id: '00000000-0000-4000-8000-000000000101',
        brandId: null,
        name: '晨光',
        normalizedKey: '示例烘焙::晨光',
        roastLevel: '浅烘焙',
        process: null,
        flavorNotes: [],
        followedAt: null,
        archivedAt: null,
        isDraft: false,
        legacyStatusRaw: null,
        legacyPersonalScoreRaw: null,
        provenance: {},
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      });
    });
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    const morning = preview.items.find((item) => item.beanName === '晨光');
    expect(morning?.category).toBe('confirm');
    expect(preview.conflicts.find((conflict) => conflict.beanName === '晨光')).toMatchObject({ existingValue: '浅烘焙' });
    await expect(commitImportPreview(repository, preview, {})).rejects.toBeInstanceOf(UnresolvedImportConflictError);
  });

  it('requires an explicit skip for every unrecognized row and persists that decision', async () => {
    const { repository } = await fixture();
    const files = await buildRepresentativeWorkbooks({ duplicateComplete: true });
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    const resolutions = Object.fromEntries(preview.conflicts.map((conflict) => [conflict.id, conflict.availableChoices[0]]));
    await expect(commitImportPreview(repository, preview, resolutions)).rejects.toBeInstanceOf(UnresolvedImportItemError);
    const duplicate = preview.items.find((item) => item.category === 'unrecognized');
    const committed = await commitImportPreview(repository, preview, resolutions, [duplicate!.beanKey]);
    expect(committed.data.importBatches[0].skippedBeanKeys).toEqual([duplicate!.beanKey]);
  });

  it('preserves an existing field when the user selects the current dashboard value', async () => {
    const { repository, files } = await fixture();
    await repository.mutate(0, (draft) => {
      draft.beans.push({
        id: '00000000-0000-4000-8000-000000000102', brandId: null, name: '晨光', normalizedKey: '示例烘焙::晨光',
        roastLevel: '中烘焙', process: '蜜处理', flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false,
        legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {}, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
      });
    });
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    const processConflict = preview.conflicts.find((conflict) => conflict.field === 'process' && conflict.beanName === '晨光');
    expect(processConflict?.availableChoices).toContain('existing');
    const resolutions = Object.fromEntries(preview.conflicts.map((conflict) => [
      conflict.id,
      conflict.id === processConflict?.id ? 'existing' : conflict.availableChoices[0],
    ]));
    await expect(commitImportPreview(repository, preview, { ...resolutions, unknown: 'complete' })).rejects.toBeInstanceOf(InvalidImportResolutionError);
    const result = await commitImportPreview(repository, preview, resolutions);
    expect(result.data.beans.find((bean) => bean.name === '晨光')?.process).toBe('蜜处理');
  });

  it('does not erase an existing value when both source cells are blank', async () => {
    const { repository } = await fixture();
    await repository.mutate(0, (draft) => {
      draft.beans.push({
        id: '00000000-0000-4000-8000-000000000103', brandId: null, name: '晨光', normalizedKey: '示例烘焙::晨光',
        roastLevel: null, process: '蜜处理', flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false,
        legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {}, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
      });
    });
    const files = await buildRepresentativeWorkbooks({ blankProcess: true });
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    expect(preview.conflicts.some((conflict) => conflict.field === 'process')).toBe(false);
    const resolutions = Object.fromEntries(preview.conflicts.map((conflict) => [conflict.id, conflict.availableChoices[0]]));
    const result = await commitImportPreview(repository, preview, resolutions);
    expect(result.data.beans.find((bean) => bean.name === '晨光')?.process).toBe('蜜处理');
  });

  it('requires conflict decisions before atomically committing a recoverable batch', async () => {
    const { repository, files } = await fixture();
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    const before = sha256(await readFile(repository.dataFile));
    await expect(commitImportPreview(repository, preview, {})).rejects.toBeInstanceOf(UnresolvedImportConflictError);
    await expect(commitImportPreview(repository, preview, { [preview.conflicts[0].id]: 'existing' })).rejects.toBeInstanceOf(InvalidImportResolutionError);
    expect(sha256(await readFile(repository.dataFile))).toBe(before);

    const resolution = { [preview.conflicts[0].id]: 'selection' as const };
    const result = await commitImportPreview(repository, preview, resolution);
    expect(result.alreadyImported).toBe(false);
    expect(result.backupName).toMatch(/before-excel-import/);
    expect(result.data).toMatchObject({ dataRevision: 1 });
    expect(result.data.beans).toHaveLength(2);
    expect(result.data.brands).toHaveLength(1);
    expect(result.data.beans.find((bean) => bean.name === '晨光')?.roastLevel).toBe('中浅烘焙');
    const morning = result.data.beans.find((bean) => bean.name === '晨光');
    expect(morning?.importedFacts).toMatchObject({
      pricePerGram: 0.69,
      packageGrams: 227,
      officialFlavorDescription: '柑橘\n白花',
    });
    expect(morning?.legacyStatusRaw).toBe('🆕未喝');
    expect(morning?.provenance.pricePerGram).toHaveLength(2);
    expect(morning?.provenance.pricePerGram?.[0]).toMatchObject({ sourceId: expect.any(String), location: '产品详情对比!G2' });
    expect(morning?.provenance.pricePerGram?.[0]).toHaveProperty('numberFormat');
    expect(Object.keys(morning?.provenance ?? {})).toEqual(expect.arrayContaining([
      'overallScoreRaw', 'preferenceMatchRaw', 'recommendationRaw', 'originOrVariety',
      'officialFlavorDescription', 'americanoPerformance', 'milkPerformance', 'suitableScenes', 'flavorNotes',
    ]));
    expect(result.data.drinkingRecords).toHaveLength(0);
    expect(result.data.purchases).toHaveLength(0);
  });

  it('is idempotent when the same pair of workbooks is committed again', async () => {
    const { repository, files } = await fixture();
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    const resolutions = { [preview.conflicts[0].id]: 'complete' as const };
    await commitImportPreview(repository, preview, resolutions);
    const repeated = await commitImportPreview(repository, preview, resolutions);
    expect(repeated.alreadyImported).toBe(true);
    expect(repeated.data.dataRevision).toBe(1);
    expect(repeated.data.beans).toHaveLength(2);
    expect(repeated.data.importBatches).toHaveLength(1);

    const freshPreview = await createImportPreview({ ...files, existing: await repository.read() });
    const freshRepeated = await commitImportPreview(repository, freshPreview, {});
    expect(freshRepeated.alreadyImported).toBe(true);
    expect(freshRepeated.data.dataRevision).toBe(1);
  });

  it('serializes concurrent commits so one batch is written exactly once', async () => {
    const { repository, files } = await fixture();
    const preview = await createImportPreview({ ...files, existing: await repository.read() });
    const resolutions = Object.fromEntries(preview.conflicts.map((conflict) => [conflict.id, conflict.availableChoices[0]]));
    const results = await Promise.all([
      commitImportPreview(repository, preview, resolutions),
      commitImportPreview(repository, preview, resolutions),
    ]);
    expect(results.map((result) => result.alreadyImported).sort()).toEqual([false, true]);
    const data = await repository.read();
    expect(data.dataRevision).toBe(1);
    expect(data.importBatches).toHaveLength(1);
  });
});
