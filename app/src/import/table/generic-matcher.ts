import { randomUUID } from 'node:crypto';
import {
  BrandSchema,
  CoffeeBeanSchema,
  type CoffeeBean,
  type CoffeeData,
} from '../../domain/schema.js';
import { beanIdentityKey } from '../../domain/bean-identity.js';
import type { ImportConflictChoice } from '../../domain/import-contract.js';
import {
  normalizeName,
  normalizeNumber,
  normalizeRoastLevel,
  normalizeSpecification,
  normalizeStatus,
  normalizeText,
  splitList,
  type LegacyStatus,
} from '../xlsx/normalizers.js';
import type { SourceCell } from './table-document.js';
import type { TableField, TableMapping } from './field-map.js';

export type TableImportCategory = 'new' | 'merge' | 'possible_duplicate' | 'conflict' | 'unrecognized';

export type TableConflictField =
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

export interface TableConflict {
  id: string;
  beanKey: string;
  beanName: string;
  field: TableConflictField;
  incomingValue: string;
  existingValue: string;
  incomingLocation: string;
  availableChoices: ImportConflictChoice[];
  // 类型化决议值：提交时按用户选择回填，避免从展示字符串还原失真。
  choiceValues: { incoming: unknown; existing: unknown };
}

export interface TableEvaluationCandidate {
  rowNumber: number;
  overallScore: number | null;
  personalScoreRaw: string | null;
  status: LegacyStatus;
  summaryText: string | null;
}

export interface RecognizedTableItem {
  beanKey: string;
  brandName: string;
  beanName: string;
  category: Exclude<TableImportCategory, 'unrecognized'>;
  bean: CoffeeBean;
  evaluations: TableEvaluationCandidate[];
  duplicateTargets?: Array<{ beanKey: string; brandName: string; beanName: string }>;
}

export interface UnrecognizedTableItem {
  beanKey: string;
  brandName: string;
  beanName: string;
  category: 'unrecognized';
  bean: null;
  evaluations: TableEvaluationCandidate[];
  reason: 'missing_identity';
}

export type TableItem = RecognizedTableItem | UnrecognizedTableItem;

export interface TableMatchResult {
  items: TableItem[];
  conflicts: TableConflict[];
  summary: {
    beans: number;
    brands: number;
    evaluations: number;
    untried: number;
    drank: number;
    drinking: number;
    legacyScores: number;
  };
}

function text(cell: SourceCell | undefined): string | null {
  return normalizeText(cell?.displayedText);
}

function cellAt(row: SourceCell[], mapping: TableMapping, field: TableField): SourceCell | undefined {
  const column = mapping.fields[field];
  return column ? row[column - 1] : undefined;
}

// 解析评分：数值或数字文本（1–5，0.5 步长）或 ⭐/★ 星数；其余形式保持 raw，不伪造数值。
function parseScore(cell: SourceCell | undefined): number | null {
  if (!cell) return null;
  const numeric = normalizeNumber(cell.rawValue, cell.displayedText).value;
  if (numeric !== null) {
    return numeric >= 1 && numeric <= 5 && (numeric * 2) % 1 === 0 ? numeric : null;
  }
  const stars = (cell.displayedText.match(/[⭐★]/g) ?? []).length;
  return stars >= 1 && stars <= 5 ? stars : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) <= 1e-9;
  if (Array.isArray(left) && Array.isArray(right)) {
    return normalizeName(left.join('')) === normalizeName(right.join(''));
  }
  if (left && right && typeof left === 'object' && 'amount' in left && typeof right === 'object' && 'amount' in right) {
    return sameValue((left as { amount: unknown }).amount, (right as { amount: unknown }).amount);
  }
  return normalizeName(String(left ?? '')) === normalizeName(String(right ?? ''));
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join('、');
  return String(value ?? '');
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

interface BeanFacts {
  bean: CoffeeBean;
  conflicts: TableConflict[];
  evaluations: TableEvaluationCandidate[];
  status: LegacyStatus;
}

function buildBeanFacts(
  key: string,
  brandName: string,
  beanName: string,
  row: SourceCell[],
  rowNumber: number,
  mapping: TableMapping,
  existing: CoffeeBean | undefined,
  sourceId: string,
  now: string,
): BeanFacts {
  const get = (field: TableField) => cellAt(row, mapping, field);
  const facts = existing?.importedFacts;
  const price = normalizeNumber(get('referencePrice')?.rawValue, get('referencePrice')?.displayedText ?? '').value;
  const pricePerGram = normalizeNumber(get('pricePerGram')?.rawValue, get('pricePerGram')?.displayedText ?? '').value;
  const packageGrams = normalizeSpecification(get('specification')?.rawValue, get('specification')?.displayedText ?? '').grams;
  const flavorNotes = splitList(get('flavorKeywords')?.displayedText ?? '');
  const suitableScenes = splitList(get('suitableScenes')?.displayedText ?? '');
  const status = normalizeStatus(get('status')?.displayedText ?? '');
  const score = parseScore(get('personalScore'));
  const scoreBasis = text(get('scoreBasis'));
  const evaluations: TableEvaluationCandidate[] = [];
  // 评价 = 喝过之后的记录：只有已喝/在喝的行生成 BeanEvaluation；
  // 字母等级（A+ 等）不是数值，overallScore 保持 null，原文存 summary，不伪造数字。
  if (status === 'drank' || status === 'drinking') {
    evaluations.push({
      rowNumber,
      overallScore: score,
      personalScoreRaw: text(get('personalScore')),
      status,
      summaryText: scoreBasis,
    });
  }

  const bean = CoffeeBeanSchema.parse({
    id: existing?.id ?? randomUUID(),
    brandId: existing?.brandId ?? null,
    name: existing?.name ?? beanName,
    normalizedKey: key,
    roastLevel: normalizeRoastLevel(get('roastLevel')?.displayedText ?? '') ?? existing?.roastLevel ?? null,
    process: text(get('process')) ?? existing?.process ?? null,
    flavorNotes: flavorNotes.length > 0 ? flavorNotes : existing?.flavorNotes ?? [],
    followedAt: existing?.followedAt ?? null,
    archivedAt: existing?.archivedAt ?? null,
    isDraft: existing?.isDraft ?? false,
    legacyStatusRaw: text(get('status')) ?? existing?.legacyStatusRaw ?? null,
    legacyPersonalScoreRaw: text(get('personalScore')) ?? existing?.legacyPersonalScoreRaw ?? null,
    importedFacts: {
      overallScoreRaw: text(get('overallScore')) ?? facts?.overallScoreRaw ?? null,
      preferenceMatchRaw: text(get('preferenceMatch')) ?? facts?.preferenceMatchRaw ?? null,
      recommendationRaw: text(get('recommendation')) ?? facts?.recommendationRaw ?? null,
      referencePrice: price === null ? facts?.referencePrice ?? null : { amount: price, currency: 'CNY' },
      pricePerGram: pricePerGram ?? facts?.pricePerGram ?? null,
      packageGrams: packageGrams ?? facts?.packageGrams ?? null,
      originOrVariety: text(get('originOrVariety')) ?? facts?.originOrVariety ?? null,
      officialFlavorDescription: text(get('officialFlavorDescription')) ?? facts?.officialFlavorDescription ?? null,
      americanoPerformance: text(get('americanoPerformance')) ?? facts?.americanoPerformance ?? null,
      milkPerformance: text(get('milkPerformance')) ?? facts?.milkPerformance ?? null,
      suitableScenes: suitableScenes.length > 0 ? suitableScenes : facts?.suitableScenes ?? [],
      legacyNote: text(get('note')) ?? facts?.legacyNote ?? null,
      legacyScoreBasisRaw: text(get('scoreBasis')) ?? facts?.legacyScoreBasisRaw ?? null,
    },
    provenance: structuredClone(existing?.provenance ?? {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  const provenanceSources: Array<[TableField, SourceCell | undefined]> = TABLE_PROVENANCE_FIELDS.map((field) => [field, get(field)]);
  for (const [field, cell] of provenanceSources) {
    if (!cell || !cell.displayedText.trim()) continue;
    bean.provenance[PROVENANCE_KEY[field]] = [
      ...(bean.provenance[PROVENANCE_KEY[field]] ?? []),
      evidence(sourceId, now, cell),
    ];
  }

  // 字段冲突：仅在与库内已有豆（同键）真实不一致时出现，二选一必须用户裁决。
  const conflicts: TableConflict[] = [];
  const candidates: Array<{ field: TableConflictField; incoming: unknown; existing: unknown; cell?: SourceCell }> = [
    { field: 'roastLevel', incoming: normalizeRoastLevel(get('roastLevel')?.displayedText ?? ''), existing: existing?.roastLevel, cell: get('roastLevel') },
    { field: 'process', incoming: text(get('process')), existing: existing?.process, cell: get('process') },
    { field: 'flavorNotes', incoming: flavorNotes.length > 0 ? flavorNotes : null, existing: existing?.flavorNotes, cell: get('flavorKeywords') },
    { field: 'legacyStatusRaw', incoming: text(get('status')), existing: existing?.legacyStatusRaw, cell: get('status') },
    { field: 'legacyPersonalScoreRaw', incoming: text(get('personalScore')), existing: existing?.legacyPersonalScoreRaw, cell: get('personalScore') },
    { field: 'overallScoreRaw', incoming: text(get('overallScore')), existing: facts?.overallScoreRaw, cell: get('overallScore') },
    { field: 'preferenceMatchRaw', incoming: text(get('preferenceMatch')), existing: facts?.preferenceMatchRaw, cell: get('preferenceMatch') },
    { field: 'recommendationRaw', incoming: text(get('recommendation')), existing: facts?.recommendationRaw, cell: get('recommendation') },
    { field: 'referencePrice', incoming: price === null ? null : { amount: price, currency: 'CNY' }, existing: facts?.referencePrice, cell: get('referencePrice') },
    { field: 'pricePerGram', incoming: pricePerGram, existing: facts?.pricePerGram, cell: get('pricePerGram') },
    { field: 'packageGrams', incoming: packageGrams, existing: facts?.packageGrams, cell: get('specification') },
    { field: 'originOrVariety', incoming: text(get('originOrVariety')), existing: facts?.originOrVariety, cell: get('originOrVariety') },
    { field: 'officialFlavorDescription', incoming: text(get('officialFlavorDescription')), existing: facts?.officialFlavorDescription, cell: get('officialFlavorDescription') },
    { field: 'americanoPerformance', incoming: text(get('americanoPerformance')), existing: facts?.americanoPerformance, cell: get('americanoPerformance') },
    { field: 'milkPerformance', incoming: text(get('milkPerformance')), existing: facts?.milkPerformance, cell: get('milkPerformance') },
    { field: 'suitableScenes', incoming: suitableScenes.length > 0 ? suitableScenes : null, existing: facts?.suitableScenes, cell: get('suitableScenes') },
    { field: 'legacyNote', incoming: text(get('note')), existing: facts?.legacyNote, cell: get('note') },
    { field: 'legacyScoreBasisRaw', incoming: text(get('scoreBasis')), existing: facts?.legacyScoreBasisRaw, cell: get('scoreBasis') },
  ];
  for (const candidate of candidates) {
    if (!present(candidate.incoming) || !present(candidate.existing)) continue;
    if (sameValue(candidate.incoming, candidate.existing)) continue;
    conflicts.push({
      id: `${key}:${candidate.field}`,
      beanKey: key,
      beanName,
      field: candidate.field,
      incomingValue: displayValue(candidate.incoming),
      existingValue: displayValue(candidate.existing),
      incomingLocation: candidate.cell?.location ?? '',
      availableChoices: ['incoming', 'existing'],
      choiceValues: { incoming: structuredClone(candidate.incoming), existing: structuredClone(candidate.existing) },
    });
  }

  return { bean, conflicts, evaluations, status };
}

const TABLE_PROVENANCE_FIELDS: TableField[] = [
  'brand', 'beanName', 'roastLevel', 'process', 'originOrVariety', 'specification',
  'referencePrice', 'pricePerGram', 'officialFlavorDescription', 'americanoPerformance',
  'milkPerformance', 'suitableScenes', 'flavorKeywords', 'recommendation', 'status',
  'personalScore', 'scoreBasis', 'overallScore', 'preferenceMatch', 'note',
];

const PROVENANCE_KEY: Record<TableField, string> = {
  brand: 'brandName',
  beanName: 'name',
  roastLevel: 'roastLevel',
  process: 'process',
  originOrVariety: 'originOrVariety',
  specification: 'packageGrams',
  referencePrice: 'referencePrice',
  pricePerGram: 'pricePerGram',
  officialFlavorDescription: 'officialFlavorDescription',
  americanoPerformance: 'americanoPerformance',
  milkPerformance: 'milkPerformance',
  suitableScenes: 'suitableScenes',
  flavorKeywords: 'flavorNotes',
  recommendation: 'recommendationRaw',
  status: 'legacyStatusRaw',
  personalScore: 'legacyPersonalScoreRaw',
  scoreBasis: 'legacyScoreBasisRaw',
  overallScore: 'overallScoreRaw',
  preferenceMatch: 'preferenceMatchRaw',
  note: 'legacyNote',
};

// 可能重复：键不同，但同豆名异品牌，或同品牌下名称互相包含（归一后）。
function findDuplicateTargets(
  key: string,
  brandName: string,
  beanName: string,
  existingData: CoffeeData,
): Array<{ beanKey: string; brandName: string; beanName: string }> {
  const normalizedBrand = normalizeName(brandName);
  const normalizedName = normalizeName(beanName);
  const targets: Array<{ beanKey: string; brandName: string; beanName: string }> = [];
  for (const bean of existingData.beans) {
    if (bean.normalizedKey === key) continue;
    const separator = bean.normalizedKey.indexOf('::');
    const existingBrand = separator >= 0 ? bean.normalizedKey.slice(0, separator) : '';
    const existingName = separator >= 0 ? bean.normalizedKey.slice(separator + 2) : '';
    const sameNameDifferentBrand = existingName === normalizedName && existingBrand !== normalizedBrand;
    const sameBrandSimilarName = existingBrand === normalizedBrand
      && existingName.length > 0 && normalizedName.length > 0
      && (existingName.includes(normalizedName) || normalizedName.includes(existingName));
    if (!sameNameDifferentBrand && !sameBrandSimilarName) continue;
    targets.push({
      beanKey: bean.normalizedKey,
      brandName: existingData.brands.find((brand) => brand.id === bean.brandId)?.name ?? '',
      beanName: bean.name,
    });
    if (targets.length >= 3) break;
  }
  return targets;
}

export function matchTableRows(
  rows: Array<{ rowNumber: number; cells: SourceCell[] }>,
  mapping: TableMapping,
  existingData: CoffeeData,
  sourceId: string,
  now: Date,
): TableMatchResult {
  const timestamp = now.toISOString();
  const existingByKey = new Map(existingData.beans.map((bean) => [bean.normalizedKey, bean]));
  const grouped = new Map<string, Array<{ rowNumber: number; cells: SourceCell[] }>>();
  for (const row of rows) {
    const brandName = text(cellAt(row.cells, mapping, 'brand'));
    const beanName = text(cellAt(row.cells, mapping, 'beanName'));
    if (!brandName || !beanName) {
      const key = `unrecognized:${row.rowNumber}`;
      grouped.set(key, [row]);
      continue;
    }
    const key = beanIdentityKey(brandName, beanName);
    const group = grouped.get(key);
    if (group) group.push(row);
    else grouped.set(key, [row]);
  }

  const items: TableItem[] = [];
  const conflicts: TableConflict[] = [];
  const brandNames = new Set<string>();
  const statusCounts = { untried: 0, drank: 0, drinking: 0 };
  let legacyScores = 0;

  for (const [key, group] of grouped) {
    const first = group[0]!;
    const brandName = text(cellAt(first.cells, mapping, 'brand'));
    const beanName = text(cellAt(first.cells, mapping, 'beanName'));
    if (!brandName || !beanName) {
      items.push({
        beanKey: key,
        brandName: brandName ?? '未识别品牌',
        beanName: beanName ?? '未识别产品',
        category: 'unrecognized',
        bean: null,
        evaluations: [],
        reason: 'missing_identity',
      });
      continue;
    }
    BrandSchema.parse({
      id: randomUUID(), name: brandName, aliases: [], archivedAt: null,
      createdAt: timestamp, updatedAt: timestamp,
    });
    brandNames.add(brandName);

    const existing = existingByKey.get(key);
    const facts = buildBeanFacts(key, brandName, beanName, first.cells, first.rowNumber, mapping, existing, sourceId, timestamp);
    // 同豆多行：第一行提供豆事实，其余行只贡献评价，评价不因去重丢失。
    for (const extra of group.slice(1)) {
      const extraScore = parseScore(cellAt(extra.cells, mapping, 'personalScore'));
      const extraStatus = normalizeStatus(cellAt(extra.cells, mapping, 'status')?.displayedText ?? '');
      if (extraStatus === 'drank' || extraStatus === 'drinking') {
        facts.evaluations.push({
          rowNumber: extra.rowNumber,
          overallScore: extraScore,
          personalScoreRaw: text(cellAt(extra.cells, mapping, 'personalScore')),
          status: extraStatus,
          summaryText: text(cellAt(extra.cells, mapping, 'scoreBasis')),
        });
      }
    }
    for (const evaluation of facts.evaluations) {
      if (evaluation.status !== 'unknown') statusCounts[evaluation.status] += 1;
      if (evaluation.overallScore !== null || evaluation.personalScoreRaw !== null) legacyScores += 1;
    }

    conflicts.push(...facts.conflicts);
    const duplicateTargets = existing ? undefined : findDuplicateTargets(key, brandName, beanName, existingData);
    const category: RecognizedTableItem['category'] = existing
      ? facts.conflicts.length > 0 ? 'conflict' : 'merge'
      : (duplicateTargets?.length ?? 0) > 0 ? 'possible_duplicate' : 'new';
    items.push({
      beanKey: key,
      brandName,
      beanName,
      category,
      bean: facts.bean,
      evaluations: facts.evaluations,
      ...(duplicateTargets && duplicateTargets.length > 0 ? { duplicateTargets } : {}),
    });
  }

  return {
    items,
    conflicts,
    summary: {
      beans: items.filter((item) => item.category !== 'unrecognized').length,
      brands: brandNames.size,
      evaluations: items.reduce((total, item) => total + item.evaluations.length, 0),
      ...statusCounts,
      legacyScores,
    },
  };
}
