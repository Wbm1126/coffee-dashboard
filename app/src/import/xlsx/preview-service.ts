import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import type { CoffeeData } from '../../domain/schema.js';
import { matchWorkbookRows, type ImportConflict, type ImportItem } from './matcher.js';
import { readImportWorkbooks, type WorkbookUpload, WorkbookImportError } from './workbook-reader.js';

export interface ImportPreview {
  id: string;
  batchKey: string;
  baseRevision: number;
  createdAt: string;
  fileHashes: { complete: string; selection: string };
  fileNames: { complete: string; selection: string };
  summary: {
    beans: number;
    brands: number;
    untried: number;
    drank: number;
    drinking: number;
    legacyScores: number;
  };
  categories: Record<'new' | 'auto_merge' | 'confirm' | 'skip' | 'unrecognized', number>;
  items: ImportItem[];
  conflicts: ImportConflict[];
}

export interface CreateImportPreviewInput {
  complete: WorkbookUpload | null;
  selection: WorkbookUpload | null;
  existing: CoffeeData;
  now?: Date;
}

function hashParts(parts: string[]) {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

export async function createImportPreview(input: CreateImportPreviewInput): Promise<ImportPreview> {
  const rows = await readImportWorkbooks(input.complete, input.selection);
  const now = input.now ?? new Date();
  let matched: ReturnType<typeof matchWorkbookRows>;
  try {
    matched = matchWorkbookRows(rows, input.existing, now);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new WorkbookImportError('row_invalid', `导入字段超出可接受范围（${issue?.path.join('.') || '未知字段'}），数据未写入。`);
    }
    throw error;
  }
  const batchKey = hashParts([rows.fileHashes.complete, rows.fileHashes.selection]);
  const categories = { new: 0, auto_merge: 0, confirm: 0, skip: 0, unrecognized: 0 };
  for (const item of matched.items) categories[item.category] += 1;
  return {
    id: hashParts([batchKey, String(input.existing.dataRevision), now.toISOString()]),
    batchKey,
    baseRevision: input.existing.dataRevision,
    createdAt: now.toISOString(),
    fileHashes: rows.fileHashes,
    fileNames: rows.fileNames,
    summary: matched.summary,
    categories,
    items: matched.items,
    conflicts: matched.conflicts,
  };
}
