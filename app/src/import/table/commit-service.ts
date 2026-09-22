import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrandSchema, CoffeeData } from '../../domain/schema.js';
import type { ImportConflictChoice } from '../../domain/import-contract.js';
import type { JsonRepository } from '../../storage/json-repository.js';
import { normalizeName } from '../xlsx/normalizers.js';
import type { RecognizedTableItem, TableConflict } from './generic-matcher.js';
import type { TablePreview } from './preview-service.js';

export const TABLE_DUPLICATE_DECISION_SCHEMA = z.enum(['import_as_new', 'merge', 'skip']);
export type TableDuplicateDecision = z.infer<typeof TABLE_DUPLICATE_DECISION_SCHEMA>;

export type ConflictResolutions = Record<string, ImportConflictChoice>;
export type DuplicateDecisions = Record<string, TableDuplicateDecision>;

export class UnresolvedTableConflictError extends Error {
  constructor(readonly conflictIds: string[]) {
    super(`仍有 ${conflictIds.length} 项导入冲突未处理。`);
    this.name = 'UnresolvedTableConflictError';
  }
}

export class UnresolvedTableDuplicateError extends Error {
  constructor(readonly beanKeys: string[]) {
    super(`仍有 ${beanKeys.length} 项可能重复的记录未决定处理方式。`);
    this.name = 'UnresolvedTableDuplicateError';
  }
}

export class UnresolvedTableSkipError extends Error {
  constructor(readonly beanKeys: string[]) {
    super(`仍有 ${beanKeys.length} 项无法识别的记录未确认跳过。`);
    this.name = 'UnresolvedTableSkipError';
  }
}

export class InvalidTableResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTableResolutionError';
  }
}

export interface CommitTableResult {
  data: Awaited<ReturnType<JsonRepository['read']>>;
  alreadyImported: boolean;
  backupName: string | null;
  beansWritten: number;
  evaluationsWritten: number;
}

type Brand = z.infer<typeof BrandSchema>;
type BeanEntity = CoffeeData['beans'][number];

function applyConflictFieldValue(bean: BeanEntity, field: TableConflict['field'], value: unknown): void {
  const facts = bean.importedFacts;
  switch (field) {
    case 'roastLevel': bean.roastLevel = (value as string | null) ?? null; break;
    case 'process': bean.process = (value as string | null) ?? null; break;
    case 'flavorNotes': bean.flavorNotes = (value as string[]) ?? []; break;
    case 'legacyStatusRaw': bean.legacyStatusRaw = (value as string | null) ?? null; break;
    case 'legacyPersonalScoreRaw': bean.legacyPersonalScoreRaw = (value as string | null) ?? null; break;
    case 'overallScoreRaw': if (facts) facts.overallScoreRaw = (value as string | null) ?? null; break;
    case 'preferenceMatchRaw': if (facts) facts.preferenceMatchRaw = (value as string | null) ?? null; break;
    case 'recommendationRaw': if (facts) facts.recommendationRaw = (value as string | null) ?? null; break;
    case 'referencePrice': if (facts) facts.referencePrice = (value as { amount: number; currency: string } | null) ?? null; break;
    case 'pricePerGram': if (facts) facts.pricePerGram = (value as number | null) ?? null; break;
    case 'packageGrams': if (facts) facts.packageGrams = (value as number | null) ?? null; break;
    case 'originOrVariety': if (facts) facts.originOrVariety = (value as string | null) ?? null; break;
    case 'officialFlavorDescription': if (facts) facts.officialFlavorDescription = (value as string | null) ?? null; break;
    case 'americanoPerformance': if (facts) facts.americanoPerformance = (value as string | null) ?? null; break;
    case 'milkPerformance': if (facts) facts.milkPerformance = (value as string | null) ?? null; break;
    case 'suitableScenes': if (facts) facts.suitableScenes = (value as string[]) ?? []; break;
    case 'legacyNote': if (facts) facts.legacyNote = (value as string | null) ?? null; break;
    case 'legacyScoreBasisRaw': if (facts) facts.legacyScoreBasisRaw = (value as string | null) ?? null; break;
    default: {
      const exhaustive: never = field;
      throw new InvalidTableResolutionError(`未知冲突字段：${String(exhaustive)}`);
    }
  }
}

function applyConflictResolutions(
  beans: Map<string, BeanEntity>,
  conflicts: TableConflict[],
  resolutions: ConflictResolutions,
): void {
  for (const conflict of conflicts) {
    const bean = beans.get(conflict.beanKey);
    if (!bean) continue;
    const choice = resolutions[conflict.id];
    if (!conflict.availableChoices.includes(choice)) {
      throw new InvalidTableResolutionError(`冲突 ${conflict.id} 不支持所选决议。`);
    }
    applyConflictFieldValue(bean, conflict.field, conflict.choiceValues[choice === 'existing' ? 'existing' : 'incoming']);
  }
}

export async function commitTablePreview(
  repository: JsonRepository,
  preview: TablePreview,
  resolutions: ConflictResolutions,
  duplicateDecisions: DuplicateDecisions,
  skippedBeanKeys: string[] = [],
  mergeTargets: Record<string, string> = {},
): Promise<CommitTableResult> {
  const conflictById = new Map(preview.conflicts.map((conflict) => [conflict.id, conflict]));
  if (Object.keys(resolutions).some((id) => !conflictById.has(id))) {
    throw new InvalidTableResolutionError('提交中包含不属于当前预览的冲突决议。');
  }
  const unresolvedConflicts = preview.conflicts.filter((conflict) => !resolutions[conflict.id]);
  if (unresolvedConflicts.length > 0) {
    throw new UnresolvedTableConflictError(unresolvedConflicts.map((conflict) => conflict.id));
  }

  const duplicateItems = preview.items.filter((item): item is RecognizedTableItem => item.category === 'possible_duplicate');
  if (duplicateItems.some((item) => !duplicateDecisions[item.beanKey])) {
    throw new UnresolvedTableDuplicateError(
      duplicateItems.filter((item) => !duplicateDecisions[item.beanKey]).map((item) => item.beanKey),
    );
  }
  // 重复决策只接受 possible_duplicate 条目自身的键；指向候选目标的键是客户端错误，快速失败。
  const duplicateKeys = new Set(duplicateItems.map((item) => item.beanKey));
  for (const beanKey of Object.keys(duplicateDecisions)) {
    if (!duplicateKeys.has(beanKey)) throw new InvalidTableResolutionError(`重复决策 ${beanKey} 不属于当前预览的重复项。`);
  }
  const unrecognizedKeys = new Set(preview.items.filter((item) => item.category === 'unrecognized').map((item) => item.beanKey));
  const submittedSkips = new Set(skippedBeanKeys);
  if ([...submittedSkips].some((key) => !unrecognizedKeys.has(key))) {
    throw new InvalidTableResolutionError('提交中包含不属于当前预览的跳过项。');
  }
  const unresolvedSkips = [...unrecognizedKeys].filter((key) => !submittedSkips.has(key));
  if (unresolvedSkips.length > 0) throw new UnresolvedTableSkipError(unresolvedSkips);

  const committedAt = new Date().toISOString();
  const transaction = await repository.transact(preview.baseRevision, 'before-table-import', (draft) => {
    if (draft.importBatches.some((batch) => batch.batchKey === preview.batchKey)) {
      return { commit: false, value: { alreadyImported: true, beansWritten: 0, evaluationsWritten: 0 } };
    }

    const brandByName = new Map(draft.brands.map((brand) => [normalizeName(brand.name), brand]));
    const beanIndexByKey = new Map(draft.beans.map((bean, index) => [bean.normalizedKey, index]));
    // 预览豆已按 incoming 优先构好；这里先按用户决议回填冲突字段，再落库。
    const resolvedBeans = new Map<string, BeanEntity>(
      preview.items
        .filter((item): item is RecognizedTableItem => item.bean !== null)
        .map((item) => [item.beanKey, structuredClone(item.bean)]),
    );
    applyConflictResolutions(resolvedBeans, preview.conflicts, resolutions);
    let beansWritten = 0;
    let evaluationsWritten = 0;

    for (const item of preview.items) {
      if (item.category === 'unrecognized') continue;
      const decision = item.category === 'possible_duplicate' ? duplicateDecisions[item.beanKey] : undefined;
      if (decision === 'skip') continue;
      // merge：并入目标豆（默认第一个候选），只填空字段，不覆盖已有值；import_as_new：作为新豆入库。
      const requestedTarget = mergeTargets?.[item.beanKey];
      const mergeTargetKey = decision === 'merge'
        ? (requestedTarget && item.duplicateTargets?.some((target) => target.beanKey === requestedTarget)
          ? requestedTarget
          : item.duplicateTargets?.[0]?.beanKey)
        : undefined;
      const targetKey = mergeTargetKey ?? item.beanKey;
      const targetIndex = beanIndexByKey.get(targetKey) ?? -1;
      // 仅新豆需要创建品牌；并入已有豆时保留原品牌，避免孤儿品牌记录。
      const becomesNewBean = targetIndex < 0;

      let brand = brandByName.get(normalizeName(item.brandName));
      if (!brand && becomesNewBean) {
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

      let bean: BeanEntity;
      const resolvedBean = resolvedBeans.get(item.beanKey)!;
      if (targetIndex >= 0) {
        bean = draft.beans[targetIndex]!;
        // 只填空：库内已有值永不被同层级历史导入覆盖；用户显式选择 incoming 的冲突字段除外。
        bean.roastLevel = bean.roastLevel ?? resolvedBean.roastLevel;
        bean.process = bean.process ?? resolvedBean.process;
        bean.flavorNotes = bean.flavorNotes.length > 0 ? bean.flavorNotes : resolvedBean.flavorNotes;
        bean.legacyStatusRaw = bean.legacyStatusRaw ?? resolvedBean.legacyStatusRaw;
        bean.legacyPersonalScoreRaw = bean.legacyPersonalScoreRaw ?? resolvedBean.legacyPersonalScoreRaw;
        if (!bean.importedFacts && resolvedBean.importedFacts) {
          bean.importedFacts = structuredClone(resolvedBean.importedFacts);
        }
        const facts = bean.importedFacts;
        const incoming = resolvedBean.importedFacts;
        if (facts && incoming) {
          for (const key of Object.keys(incoming) as Array<keyof typeof incoming>) {
            const current = facts[key];
            const fill = incoming[key];
            const isEmpty = current === null || current === undefined || (Array.isArray(current) && current.length === 0);
            if (isEmpty && fill !== null && fill !== undefined) {
              (facts as Record<string, unknown>)[key] = structuredClone(fill);
            }
          }
        }
        for (const conflict of preview.conflicts) {
          if (conflict.beanKey === item.beanKey && resolutions[conflict.id] === 'incoming') {
            applyConflictFieldValue(bean, conflict.field, conflict.choiceValues.incoming);
          }
        }
        for (const [field, entries] of Object.entries(resolvedBean.provenance)) {
          bean.provenance[field] = [...(bean.provenance[field] ?? []), ...(entries ?? [])];
        }
        bean.updatedAt = committedAt;
        draft.beans[targetIndex] = bean;
      } else {
        bean = structuredClone(resolvedBean);
        bean.brandId = brand!.id;
        draft.beans.push(bean);
        beanIndexByKey.set(bean.normalizedKey, draft.beans.length - 1);
      }
      beansWritten += 1;

      const evaluations = item.evaluations;
      for (const candidate of evaluations) {
        // 同豆同分的 legacy_import 评价不重复入库；字母等级（overallScore=null）不去重，
        // 否则一条 null 评分会永久挡掉同豆后续不同评语的评价行。
        if (
          candidate.overallScore !== null
          && draft.beanEvaluations.some(
            (evaluation) => evaluation.beanId === bean.id
              && evaluation.source === 'legacy_import'
              && evaluation.overallScore === candidate.overallScore,
          )
        ) continue;
        draft.beanEvaluations.push({
          id: randomUUID(),
          beanId: bean.id,
          source: 'legacy_import',
          evaluatedOn: null,
          brewMethod: null,
          americanoReview: null,
          milkReview: null,
          overallScore: candidate.overallScore,
          flavorNotes: [],
          pros: null,
          cons: null,
          summary: candidate.summaryText,
          repurchase: null,
          sourceRecordId: null,
          createdAt: committedAt,
          updatedAt: committedAt,
        });
        evaluationsWritten += 1;
      }
    }

    draft.importBatches.push({
      id: randomUUID(),
      batchKey: preview.batchKey,
      sourceFileNames: { complete: preview.fileName, selection: preview.sheetName },
      fileHashes: { complete: preview.fileHash, selection: preview.batchKey.slice(0, 64) },
      counts: {
        beans: preview.summary.beans,
        brands: preview.summary.brands,
        untried: preview.summary.untried,
        drank: preview.summary.drank,
        drinking: preview.summary.drinking,
        legacyScores: preview.summary.legacyScores,
      },
      conflictResolutions: resolutions,
      skippedBeanKeys: [...submittedSkips].sort(),
      createdAt: preview.createdAt,
      committedAt,
    });
    return { commit: true, value: { alreadyImported: false, beansWritten, evaluationsWritten } };
  });

  return {
    data: transaction.data,
    alreadyImported: transaction.value.alreadyImported,
    backupName: transaction.backup?.name ?? null,
    beansWritten: transaction.value.beansWritten,
    evaluationsWritten: transaction.value.evaluationsWritten,
  };
}
