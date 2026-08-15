import { randomUUID } from 'node:crypto';
import { BrandSchema, CoffeeBeanSchema, type CoffeeBean, type CoffeeData } from '../../domain/schema.js';
import type { CompleteWorkbookRow, SelectionWorkbookRow, SourceCell, WorkbookRows } from './field-map.js';
import {
  normalizeName,
  normalizeNumber,
  normalizeRoastLevel,
  normalizeSpecification,
  normalizeStatus,
  normalizeText,
  splitList,
  type LegacyStatus,
} from './normalizers.js';
import type { ImportConflictChoice } from '../../domain/import-contract.js';
import { beanIdentityKey } from '../../domain/bean-identity.js';

export type ImportConflictField =
  | 'roastLevel'
  | 'process'
  | 'flavorNotes'
  | 'legacyStatusRaw'
  | 'legacyPersonalScoreRaw'
  | 'overallScoreRaw'
  | 'preferenceMatchRaw'
  | 'recommendationRaw'
  | 'referencePrice'
  | 'pricePerGram'
  | 'packageGrams'
  | 'originOrVariety'
  | 'officialFlavorDescription'
  | 'americanoPerformance'
  | 'milkPerformance'
  | 'suitableScenes'
  | 'legacyNote'
  | 'legacyScoreBasisRaw';

export interface ImportConflict {
  id: string;
  beanKey: string;
  beanName: string;
  field: ImportConflictField;
  completeValue: string;
  selectionValue: string;
  completeLocation: string;
  selectionLocation: string;
  existingValue?: string;
  availableChoices: ImportConflictChoice[];
  choiceValues: Partial<Record<ImportConflictChoice, unknown>>;
}

export type ImportCategory = 'new' | 'auto_merge' | 'confirm' | 'skip' | 'unrecognized';

interface ImportItemBase {
  beanKey: string;
  brandName: string;
  beanName: string;
  legacyStatus: LegacyStatus;
}

export interface RecognizedImportItem extends ImportItemBase {
  category: Exclude<ImportCategory, 'unrecognized'>;
  bean: CoffeeBean;
}

export interface UnrecognizedImportItem extends ImportItemBase {
  category: 'unrecognized';
  bean: null;
  reason: 'missing_pair' | 'duplicate_complete' | 'duplicate_selection' | 'duplicate_both';
}

export type ImportItem = RecognizedImportItem | UnrecognizedImportItem;

export interface MatchResult {
  items: ImportItem[];
  conflicts: ImportConflict[];
  summary: {
    beans: number;
    brands: number;
    untried: number;
    drank: number;
    drinking: number;
    legacyScores: number;
  };
}

function keyFor(brand: SourceCell, name: SourceCell) {
  return beanIdentityKey(brand.displayedText, name.displayedText);
}

function evidence(sourceId: string, capturedAt: string, cell: SourceCell) {
  return {
    sourceKind: 'excel' as const,
    sourceId,
    capturedAt,
    rawValue: cell.rawValue,
    displayedText: cell.displayedText,
    numberFormat: cell.numberFormat,
    location: cell.location,
  };
}

function pairRows(rows: WorkbookRows) {
  const group = <T extends CompleteWorkbookRow | SelectionWorkbookRow>(sourceRows: T[]) => {
    const result = new Map<string, T[]>();
    for (const row of sourceRows) {
      const key = keyFor(row.brand, row.name);
      const grouped = result.get(key);
      if (grouped) grouped.push(row);
      else result.set(key, [row]);
    }
    return result;
  };
  const complete = group(rows.complete);
  const selection = group(rows.selection);
  return { complete, selection, keys: [...new Set([...complete.keys(), ...selection.keys()])] };
}

function text(cell: SourceCell | undefined) {
  return normalizeText(cell?.displayedText);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) <= 1e-9;
  if (Array.isArray(left) && Array.isArray(right)) {
    return normalizeName(left.join('')) === normalizeName(right.join(''));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object' && 'amount' in left && 'amount' in right) {
    return sameValue((left as { amount: unknown }).amount, (right as { amount: unknown }).amount);
  }
  return normalizeName(String(left ?? '')) === normalizeName(String(right ?? ''));
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join('、');
  if (value && typeof value === 'object' && 'amount' in value) return String((value as { amount: unknown }).amount);
  return String(value ?? '');
}

interface ConflictCandidate {
  field: ImportConflictField;
  complete?: { value: unknown; cell: SourceCell };
  selection?: { value: unknown; cell: SourceCell };
  existing?: unknown;
}

function buildConflict(key: string, beanName: string, candidate: ConflictCandidate): ImportConflict | null {
  const sourcesDiffer = present(candidate.complete?.value) && present(candidate.selection?.value)
    && !sameValue(candidate.complete?.value, candidate.selection?.value);
  const preferred = present(candidate.complete?.value) ? candidate.complete?.value : candidate.selection?.value;
  const existingDiffers = present(candidate.existing) && present(preferred) && !sameValue(candidate.existing, preferred);
  if (!sourcesDiffer && !existingDiffers) return null;
  const availableChoices: ImportConflictChoice[] = [];
  const choiceValues: Partial<Record<ImportConflictChoice, unknown>> = {};
  if (present(candidate.complete?.value)) { availableChoices.push('complete'); choiceValues.complete = candidate.complete?.value; }
  if (present(candidate.selection?.value)) { availableChoices.push('selection'); choiceValues.selection = candidate.selection?.value; }
  if (present(candidate.existing)) { availableChoices.push('existing'); choiceValues.existing = candidate.existing; }
  const completeValue = displayValue(candidate.complete?.value ?? candidate.selection?.value);
  const selectionValue = displayValue(candidate.selection?.value ?? candidate.complete?.value);
  return {
    id: `${key}:${candidate.field}`,
    beanKey: key,
    beanName,
    field: candidate.field,
    completeValue,
    selectionValue,
    completeLocation: candidate.complete?.cell.location ?? '完整版无此字段',
    selectionLocation: candidate.selection?.cell.location ?? '选单无此字段',
    ...(present(candidate.existing) ? { existingValue: displayValue(candidate.existing) } : {}),
    availableChoices,
    choiceValues,
  };
}

function createBean(
  key: string,
  complete: CompleteWorkbookRow,
  selection: SelectionWorkbookRow,
  existing: CoffeeBean | undefined,
  rows: WorkbookRows,
  now: string,
): CoffeeBean {
  const completeSource = rows.fileHashes.complete;
  const selectionSource = rows.fileHashes.selection;
  const roast = normalizeRoastLevel(complete.roastLevel.displayedText) ?? normalizeRoastLevel(selection.roastLevel.displayedText);
  const price = normalizeNumber(complete.referencePrice.rawValue, complete.referencePrice.displayedText).value;
  const pricePerGram = normalizeNumber(complete.pricePerGram.rawValue, complete.pricePerGram.displayedText).value
    ?? normalizeNumber(selection.pricePerGram.rawValue, selection.pricePerGram.displayedText).value;
  const packageGrams = normalizeSpecification(complete.specification.rawValue, complete.specification.displayedText).grams
    ?? normalizeSpecification(selection.specification.rawValue, selection.specification.displayedText).grams;
  const sourceFlavorNotes = splitList(selection.flavorKeywords.displayedText);
  const sourceSuitableScenes = splitList(complete.suitableScenes.displayedText || selection.suitableScenes.displayedText);
  const existingFacts = existing?.importedFacts;
  const fields: Array<[string, SourceCell | undefined, string]> = [
    ['brandName', complete.brand, completeSource],
    ['brandName', selection.brand, selectionSource],
    ['name', complete.name, completeSource],
    ['name', selection.name, selectionSource],
    ['roastLevel', complete.roastLevel, completeSource],
    ['roastLevel', selection.roastLevel, selectionSource],
    ['process', complete.process, completeSource],
    ['process', selection.process, selectionSource],
    ['overallScoreRaw', complete.overallScore, completeSource],
    ['preferenceMatchRaw', complete.preferenceMatch, completeSource],
    ['recommendationRaw', selection.recommendation, selectionSource],
    ['legacyStatusRaw', selection.status, selectionSource],
    ['legacyPersonalScoreRaw', selection.personalScore, selectionSource],
    ['referencePrice', complete.referencePrice, completeSource],
    ['pricePerGram', complete.pricePerGram, completeSource],
    ['pricePerGram', selection.pricePerGram, selectionSource],
    ['packageGrams', complete.specification, completeSource],
    ['packageGrams', selection.specification, selectionSource],
    ['originOrVariety', complete.originOrVariety, completeSource],
    ['originOrVariety', selection.originOrVariety, selectionSource],
    ['officialFlavorDescription', complete.officialFlavorDescription, completeSource],
    ['americanoPerformance', complete.americanoPerformance, completeSource],
    ['milkPerformance', complete.milkPerformance, completeSource],
    ['suitableScenes', complete.suitableScenes, completeSource],
    ['suitableScenes', selection.suitableScenes, selectionSource],
    ['legacyNote', complete.note, completeSource],
    ['legacyScoreBasisRaw', selection.scoreBasis, selectionSource],
    ['flavorNotes', selection.flavorKeywords, selectionSource],
  ];
  const provenance = structuredClone(existing?.provenance ?? {});
  for (const [field, cell, sourceId] of fields) {
    if (!cell || !cell.displayedText.trim()) continue;
    provenance[field] = [...(provenance[field] ?? []), evidence(sourceId, now, cell)];
  }

  return CoffeeBeanSchema.parse({
    id: existing?.id ?? randomUUID(),
    brandId: existing?.brandId ?? null,
    name: existing?.name ?? text(complete.name) ?? text(selection.name) ?? key,
    normalizedKey: key,
    roastLevel: roast ?? existing?.roastLevel ?? null,
    process: text(complete.process) ?? text(selection.process) ?? existing?.process ?? null,
    flavorNotes: sourceFlavorNotes.length > 0 ? sourceFlavorNotes : existing?.flavorNotes ?? [],
    followedAt: existing?.followedAt ?? null,
    archivedAt: existing?.archivedAt ?? null,
    isDraft: existing?.isDraft ?? false,
    legacyStatusRaw: text(selection.status) ?? existing?.legacyStatusRaw ?? null,
    legacyPersonalScoreRaw: text(selection.personalScore) ?? existing?.legacyPersonalScoreRaw ?? null,
    importedFacts: {
      overallScoreRaw: text(complete.overallScore) ?? existingFacts?.overallScoreRaw ?? null,
      preferenceMatchRaw: text(complete.preferenceMatch) ?? existingFacts?.preferenceMatchRaw ?? null,
      recommendationRaw: text(selection.recommendation) ?? existingFacts?.recommendationRaw ?? null,
      referencePrice: price === null ? existingFacts?.referencePrice ?? null : { amount: price, currency: 'CNY' },
      pricePerGram: pricePerGram ?? existingFacts?.pricePerGram ?? null,
      packageGrams: packageGrams ?? existingFacts?.packageGrams ?? null,
      originOrVariety: text(complete.originOrVariety) ?? text(selection.originOrVariety) ?? existingFacts?.originOrVariety ?? null,
      officialFlavorDescription: text(complete.officialFlavorDescription) ?? existingFacts?.officialFlavorDescription ?? null,
      americanoPerformance: text(complete.americanoPerformance) ?? existingFacts?.americanoPerformance ?? null,
      milkPerformance: text(complete.milkPerformance) ?? existingFacts?.milkPerformance ?? null,
      suitableScenes: sourceSuitableScenes.length > 0 ? sourceSuitableScenes : existingFacts?.suitableScenes ?? [],
      legacyNote: text(complete.note) ?? existingFacts?.legacyNote ?? null,
      legacyScoreBasisRaw: text(selection.scoreBasis) ?? existingFacts?.legacyScoreBasisRaw ?? null,
    },
    provenance,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export function matchWorkbookRows(rows: WorkbookRows, existingData: CoffeeData, now: Date): MatchResult {
  const paired = pairRows(rows);
  const existingByKey = new Map(existingData.beans.map((bean) => [bean.normalizedKey, bean]));
  const conflicts: ImportConflict[] = [];
  const items: ImportItem[] = [];
  const brandNames = new Set<string>();
  const statusCounts = { untried: 0, drank: 0, drinking: 0 };
  let legacyScores = 0;

  for (const key of paired.keys) {
    const completeRows = paired.complete.get(key) ?? [];
    const selectionRows = paired.selection.get(key) ?? [];
    const complete = completeRows[0];
    const selection = selectionRows[0];
    if (completeRows.length !== 1 || selectionRows.length !== 1) {
      const partial = complete ?? selection;
      const reason = completeRows.length > 1 && selectionRows.length > 1
        ? 'duplicate_both'
        : completeRows.length > 1
          ? 'duplicate_complete'
          : selectionRows.length > 1
            ? 'duplicate_selection'
            : 'missing_pair';
      items.push({
        beanKey: key,
        brandName: text(partial?.brand) ?? '未识别品牌',
        beanName: text(partial?.name) ?? '未识别产品',
        category: 'unrecognized',
        legacyStatus: 'unknown',
        bean: null,
        reason,
      });
      continue;
    }
    const brandName = text(complete.brand) ?? text(selection.brand) ?? '未识别品牌';
    const beanName = text(complete.name) ?? text(selection.name) ?? '未识别产品';
    BrandSchema.parse({
      id: randomUUID(), name: brandName, aliases: [], archivedAt: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    brandNames.add(brandName);
    const completeRoast = normalizeRoastLevel(complete.roastLevel.displayedText);
    const selectionRoast = normalizeRoastLevel(selection.roastLevel.displayedText);
    const status = normalizeStatus(selection.status.displayedText);
    if (status !== 'unknown') statusCounts[status] += 1;
    if (text(selection.personalScore)) legacyScores += 1;
    const existing = existingByKey.get(key);
    const bean = createBean(key, complete, selection, existing, rows, now.toISOString());
    const completePricePerGram = normalizeNumber(complete.pricePerGram.rawValue, complete.pricePerGram.displayedText).value;
    const selectionPricePerGram = normalizeNumber(selection.pricePerGram.rawValue, selection.pricePerGram.displayedText).value;
    const completePackageGrams = normalizeSpecification(complete.specification.rawValue, complete.specification.displayedText).grams;
    const selectionPackageGrams = normalizeSpecification(selection.specification.rawValue, selection.specification.displayedText).grams;
    const imported = existing?.importedFacts;
    const conflictCandidates: ConflictCandidate[] = [
      { field: 'roastLevel', complete: { value: completeRoast, cell: complete.roastLevel }, selection: { value: selectionRoast, cell: selection.roastLevel }, existing: normalizeRoastLevel(existing?.roastLevel) },
      { field: 'process', complete: { value: text(complete.process), cell: complete.process }, selection: { value: text(selection.process), cell: selection.process }, existing: existing?.process },
      { field: 'flavorNotes', selection: { value: splitList(selection.flavorKeywords.displayedText), cell: selection.flavorKeywords }, existing: existing?.flavorNotes },
      { field: 'legacyStatusRaw', selection: { value: text(selection.status), cell: selection.status }, existing: existing?.legacyStatusRaw },
      { field: 'legacyPersonalScoreRaw', selection: { value: text(selection.personalScore), cell: selection.personalScore }, existing: existing?.legacyPersonalScoreRaw },
      { field: 'overallScoreRaw', complete: { value: text(complete.overallScore), cell: complete.overallScore }, existing: imported?.overallScoreRaw },
      { field: 'preferenceMatchRaw', complete: { value: text(complete.preferenceMatch), cell: complete.preferenceMatch }, existing: imported?.preferenceMatchRaw },
      { field: 'recommendationRaw', selection: { value: text(selection.recommendation), cell: selection.recommendation }, existing: imported?.recommendationRaw },
      { field: 'referencePrice', complete: { value: bean.importedFacts?.referencePrice, cell: complete.referencePrice }, existing: imported?.referencePrice },
      { field: 'pricePerGram', complete: { value: completePricePerGram, cell: complete.pricePerGram }, selection: { value: selectionPricePerGram, cell: selection.pricePerGram }, existing: imported?.pricePerGram },
      { field: 'packageGrams', complete: { value: completePackageGrams, cell: complete.specification }, selection: { value: selectionPackageGrams, cell: selection.specification }, existing: imported?.packageGrams },
      { field: 'originOrVariety', complete: { value: text(complete.originOrVariety), cell: complete.originOrVariety }, selection: { value: text(selection.originOrVariety), cell: selection.originOrVariety }, existing: imported?.originOrVariety },
      { field: 'officialFlavorDescription', complete: { value: text(complete.officialFlavorDescription), cell: complete.officialFlavorDescription }, existing: imported?.officialFlavorDescription },
      { field: 'americanoPerformance', complete: { value: text(complete.americanoPerformance), cell: complete.americanoPerformance }, existing: imported?.americanoPerformance },
      { field: 'milkPerformance', complete: { value: text(complete.milkPerformance), cell: complete.milkPerformance }, existing: imported?.milkPerformance },
      { field: 'suitableScenes', complete: { value: splitList(complete.suitableScenes.displayedText), cell: complete.suitableScenes }, selection: { value: splitList(selection.suitableScenes.displayedText), cell: selection.suitableScenes }, existing: imported?.suitableScenes },
      { field: 'legacyNote', complete: { value: text(complete.note), cell: complete.note }, existing: imported?.legacyNote },
      { field: 'legacyScoreBasisRaw', selection: { value: text(selection.scoreBasis), cell: selection.scoreBasis }, existing: imported?.legacyScoreBasisRaw },
    ];
    const beanConflicts = conflictCandidates
      .map((candidate) => buildConflict(key, beanName, candidate))
      .filter((conflict): conflict is ImportConflict => conflict !== null);
    conflicts.push(...beanConflicts);
    items.push({
      beanKey: key,
      brandName,
      beanName,
      category: existing ? (beanConflicts.length > 0 ? 'confirm' : 'auto_merge') : 'new',
      legacyStatus: status,
      bean,
    });
  }

  return {
    items,
    conflicts,
    summary: {
      beans: items.filter((item) => item.category !== 'unrecognized').length,
      brands: brandNames.size,
      ...statusCounts,
      legacyScores,
    },
  };
}
