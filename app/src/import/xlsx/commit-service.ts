import { randomUUID } from 'node:crypto';
import type { BrandSchema, CoffeeBean, CoffeeData } from '../../domain/schema.js';
import type { ImportConflictChoice } from '../../domain/import-contract.js';
import { normalizeName } from './normalizers.js';
import type { ImportPreview } from './preview-service.js';
import type { JsonRepository } from '../../storage/json-repository.js';
import type { z } from 'zod';

export type ConflictResolutions = Record<string, ImportConflictChoice>;

export class UnresolvedImportConflictError extends Error {
  constructor(readonly conflictIds: string[]) {
    super(`仍有 ${conflictIds.length} 项导入冲突未处理。`);
    this.name = 'UnresolvedImportConflictError';
  }
}

export class InvalidImportResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImportResolutionError';
  }
}

export class UnresolvedImportItemError extends Error {
  constructor(readonly beanKeys: string[]) {
    super(`仍有 ${beanKeys.length} 项无法识别的记录未确认跳过。`);
    this.name = 'UnresolvedImportItemError';
  }
}

export interface CommitImportResult {
  data: CoffeeData;
  alreadyImported: boolean;
  backupName: string | null;
}

type Brand = z.infer<typeof BrandSchema>;

function applyFieldChoice(bean: CoffeeBean, field: ImportPreview['conflicts'][number]['field'], value: unknown): void {
  const facts = bean.importedFacts;
  if (!facts && field !== 'roastLevel' && field !== 'process' && field !== 'flavorNotes') {
    throw new InvalidImportResolutionError(`冲突字段 ${field} 缺少导入数据容器。`);
  }
  switch (field) {
    case 'roastLevel': bean.roastLevel = value as string | null; break;
    case 'process': bean.process = value as string | null; break;
    case 'flavorNotes': bean.flavorNotes = value as string[]; break;
    case 'legacyStatusRaw': bean.legacyStatusRaw = value as string | null; break;
    case 'legacyPersonalScoreRaw': bean.legacyPersonalScoreRaw = value as string | null; break;
    case 'overallScoreRaw': facts!.overallScoreRaw = value as string | null; break;
    case 'preferenceMatchRaw': facts!.preferenceMatchRaw = value as string | null; break;
    case 'recommendationRaw': facts!.recommendationRaw = value as string | null; break;
    case 'referencePrice': facts!.referencePrice = value as { amount: number; currency: string } | null; break;
    case 'pricePerGram': facts!.pricePerGram = value as number | null; break;
    case 'packageGrams': facts!.packageGrams = value as number | null; break;
    case 'originOrVariety': facts!.originOrVariety = value as string | null; break;
    case 'officialFlavorDescription': facts!.officialFlavorDescription = value as string | null; break;
    case 'americanoPerformance': facts!.americanoPerformance = value as string | null; break;
    case 'milkPerformance': facts!.milkPerformance = value as string | null; break;
    case 'suitableScenes': facts!.suitableScenes = value as string[]; break;
    case 'legacyNote': facts!.legacyNote = value as string | null; break;
    case 'legacyScoreBasisRaw': facts!.legacyScoreBasisRaw = value as string | null; break;
  }
}

function applyConflictChoices(preview: ImportPreview, resolutions: ConflictResolutions) {
  const conflictById = new Map(preview.conflicts.map((conflict) => [conflict.id, conflict]));
  const unknownIds = Object.keys(resolutions).filter((id) => !conflictById.has(id));
  if (unknownIds.length > 0) throw new InvalidImportResolutionError('提交中包含不属于当前预览的冲突决议。');
  const unresolved = preview.conflicts.filter((conflict) => !resolutions[conflict.id]);
  if (unresolved.length > 0) throw new UnresolvedImportConflictError(unresolved.map((conflict) => conflict.id));
  const beans = new Map(preview.items.filter((item) => item.bean !== null && item.category !== 'skip').map((item) => [item.beanKey, structuredClone(item.bean)]));
  for (const conflict of preview.conflicts) {
    const bean = beans.get(conflict.beanKey);
    if (!bean) continue;
    const choice = resolutions[conflict.id];
    if (!conflict.availableChoices.includes(choice)) {
      throw new InvalidImportResolutionError(`冲突 ${conflict.id} 不支持所选决议。`);
    }
    applyFieldChoice(bean, conflict.field, structuredClone(conflict.choiceValues[choice]));
  }
  return beans;
}

export async function commitImportPreview(
  repository: JsonRepository,
  preview: ImportPreview,
  resolutions: ConflictResolutions,
  skippedBeanKeys: string[] = [],
): Promise<CommitImportResult> {
  const unrecognizedKeys = new Set(preview.items.filter((item) => item.category === 'unrecognized').map((item) => item.beanKey));
  const submittedSkips = new Set(skippedBeanKeys);
  const committedAt = new Date().toISOString();
  const transaction = await repository.transact(preview.baseRevision, 'before-excel-import', (draft) => {
    if (draft.importBatches.some((batch) => batch.batchKey === preview.batchKey)) {
      return { commit: false, value: { alreadyImported: true } };
    }
    const invalidSkips = [...submittedSkips].filter((key) => !unrecognizedKeys.has(key));
    if (invalidSkips.length > 0) throw new InvalidImportResolutionError('提交中包含不属于当前预览的跳过项。');
    const unresolvedItems = [...unrecognizedKeys].filter((key) => !submittedSkips.has(key));
    if (unresolvedItems.length > 0) throw new UnresolvedImportItemError(unresolvedItems);
    const beans = applyConflictChoices(preview, resolutions);
    const brandByName = new Map(draft.brands.map((brand) => [normalizeName(brand.name), brand]));
    const beanIndexById = new Map(draft.beans.map((bean, index) => [bean.id, index]));
    const beanIndexByKey = new Map(draft.beans.map((bean, index) => [bean.normalizedKey, index]));
    for (const item of preview.items) {
      const bean = beans.get(item.beanKey);
      if (!bean) continue;
      let brand = brandByName.get(normalizeName(item.brandName));
      if (!brand) {
        brand = {
          id: randomUUID(),
          name: item.brandName,
          aliases: [],
          archivedAt: null,
          createdAt: committedAt,
          updatedAt: committedAt,
        } satisfies Brand;
        draft.brands.push(brand);
        brandByName.set(normalizeName(brand.name), brand);
      }
      bean.brandId = brand.id;
      bean.updatedAt = committedAt;
      const index = beanIndexById.get(bean.id) ?? beanIndexByKey.get(bean.normalizedKey) ?? -1;
      if (index >= 0) draft.beans[index] = bean;
      else {
        const nextIndex = draft.beans.push(bean) - 1;
        beanIndexById.set(bean.id, nextIndex);
        beanIndexByKey.set(bean.normalizedKey, nextIndex);
      }
    }
    draft.importBatches.push({
      id: randomUUID(),
      batchKey: preview.batchKey,
      sourceFileNames: preview.fileNames,
      fileHashes: preview.fileHashes,
      counts: preview.summary,
      conflictResolutions: resolutions,
      skippedBeanKeys: [...submittedSkips].sort(),
      createdAt: preview.createdAt,
      committedAt,
    });
    return { commit: true, value: { alreadyImported: false } };
  });
  return {
    data: transaction.data,
    alreadyImported: transaction.value.alreadyImported,
    backupName: transaction.backup?.name ?? null,
  };
}
