import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoffeeData } from '../../domain/schema.js';
import { normalizeText } from '../xlsx/normalizers.js';
import { WorkbookImportError } from '../xlsx/workbook-policy.js';
import { sha256 } from '../../lib/sha256.js';
import { readTable, type SourceCell } from './table-document.js';
import { proposeMapping, resolveMapping, TABLE_FIELD_LABELS, type TableField, type TableMapping } from './field-map.js';
import { matchTableRows, type TableConflict, type TableItem } from './generic-matcher.js';

export const TABLE_UPLOAD_SCHEMA = z.object({
  name: z.string().min(1).max(260).refine((name) => /\.(xlsx|csv)$/i.test(name), '只接受 .xlsx 或 .csv 文件'),
  base64: z.string().min(1),
});

export const TABLE_MAPPING_OVERRIDE_SCHEMA = z.record(
  z.enum(Object.keys(TABLE_FIELD_LABELS) as Array<keyof typeof TABLE_FIELD_LABELS>),
  z.number().int().min(1).max(1_000).nullable(),
);

export interface TableUpload {
  name: string;
  bytes: Uint8Array;
}

export interface TableSheetSummary {
  name: string;
  rowCount: number;
  headerRow: number;
  headers: string[];
  mapping: { fields: Partial<Record<TableField, number>>; unmapped: string[] };
  identityReady: boolean;
}

export interface TablePreview {
  id: string;
  batchKey: string;
  baseRevision: number;
  createdAt: string;
  fileHash: string;
  fileName: string;
  sheetName: string;
  headerRow: number;
  mapping: TableMapping;
  summary: {
    beans: number;
    brands: number;
    evaluations: number;
    untried: number;
    drank: number;
    drinking: number;
    legacyScores: number;
  };
  categories: Record<'new' | 'merge' | 'possible_duplicate' | 'conflict' | 'unrecognized', number>;
  items: TableItem[];
  conflicts: TableConflict[];
}

function decodeUpload(upload: z.infer<typeof TABLE_UPLOAD_SCHEMA>): TableUpload {
  const bytes = Buffer.from(upload.base64, 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== upload.base64.replace(/\s|=+$/g, '')) {
    throw new WorkbookImportError('base64_invalid', '上传内容不是有效的 Base64 文件。');
  }
  return { name: upload.name, bytes };
}

// 表头行候选：第一个含 ≥2 个非空文本单元格的行；未找到时回退第 1 行。
function detectHeaderRow(rows: SourceCell[][]): number {
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const filled = rows[index]!.filter((cell) => normalizeText(cell.displayedText) !== null);
    if (filled.length >= 2) return index + 1;
  }
  return 1;
}

function headerCells(rows: SourceCell[][], headerRow: number): string[] {
  const cells = rows[headerRow - 1] ?? [];
  const width = cells.reduce((max, cell) => Math.max(max, cell.location.lastIndexOf('C') >= 0 ? Number(cell.location.split('C').pop()) : 0), 0);
  const headers: string[] = [];
  for (let column = 1; column <= Math.max(width, cells.length); column += 1) {
    headers.push(cells[column - 1]?.displayedText?.trim() ?? '');
  }
  return headers;
}

function dataRows(rows: SourceCell[][], headerRow: number): Array<{ rowNumber: number; cells: SourceCell[] }> {
  return rows
    .slice(headerRow)
    .map((cells, index) => ({ rowNumber: headerRow + index + 1, cells }))
    .filter((row) => row.cells.some((cell) => normalizeText(cell.displayedText) !== null));
}

// 检查阶段：列出全部工作表、表头提案与身份字段就绪情况，供 UI 选择。
export async function inspectTable(upload: TableUpload): Promise<TableSheetSummary[]> {
  const document = await readTable(upload.name, upload.bytes);
  return document.sheets.map((sheet) => {
    const headerRow = detectHeaderRow(sheet.rows);
    const headers = headerCells(sheet.rows, headerRow);
    const mapping = proposeMapping(headers);
    return {
      name: sheet.name,
      rowCount: Math.max(sheet.rowCount - headerRow, 0),
      headerRow,
      headers,
      mapping: { fields: mapping.fields, unmapped: mapping.unmapped },
      identityReady: Boolean(mapping.fields.brand && mapping.fields.beanName),
    };
  });
}

export interface CreateTablePreviewInput {
  upload: TableUpload;
  sheetName?: string;
  headerRow?: number;
  mappingOverride?: Partial<Record<TableField, number | null>>;
  existing: CoffeeData;
  now?: Date;
}

export async function createTablePreview(input: CreateTablePreviewInput): Promise<TablePreview> {
  const now = input.now ?? new Date();
  const document = await readTable(input.upload.name, input.upload.bytes);
  if (document.sheets.length === 0) throw new WorkbookImportError('sheet_missing', '文件中没有可用的工作表。');
  const sheet = input.sheetName
    ? document.sheets.find((candidate) => candidate.name === input.sheetName)
    : document.sheets.find((candidate) => proposeMapping(headerCells(candidate.rows, detectHeaderRow(candidate.rows))).fields.beanName !== undefined)
      ?? document.sheets[0];
  if (!sheet) throw new WorkbookImportError('sheet_missing', `找不到工作表“${input.sheetName ?? ''}”。`);

  const headerRow = input.headerRow ?? detectHeaderRow(sheet.rows);
  const headers = headerCells(sheet.rows, headerRow);
  let mapping: TableMapping;
  try {
    mapping = resolveMapping(headers, input.mappingOverride ?? {});
  } catch (error) {
    throw new WorkbookImportError('mapping_invalid', error instanceof RangeError ? error.message : '字段映射无效。');
  }

  const fileHash = sha256(input.upload.bytes);
  const sourceId = `${input.upload.name}:${fileHash.slice(0, 16)}`;
  const match = matchTableRows(dataRows(sheet.rows, headerRow), mapping, input.existing, sourceId, now);
  const categories = { new: 0, merge: 0, possible_duplicate: 0, conflict: 0, unrecognized: 0 };
  for (const item of match.items) categories[item.category] += 1;

  return {
    id: randomUUID().replace(/-/g, ''),
    batchKey: createHash('sha256')
      .update([fileHash, sheet.name, headerRow, JSON.stringify(mapping.fields)].join(':'))
      .digest('hex'),
    baseRevision: input.existing.dataRevision,
    createdAt: now.toISOString(),
    fileHash,
    fileName: input.upload.name,
    sheetName: sheet.name,
    headerRow,
    mapping,
    summary: match.summary,
    categories,
    items: match.items,
    conflicts: match.conflicts,
  };
}

export function decodeTableUpload(upload: z.infer<typeof TABLE_UPLOAD_SCHEMA>): TableUpload {
  return decodeUpload(upload);
}
