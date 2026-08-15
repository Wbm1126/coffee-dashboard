import { IMPORT_COMPRESSED_BYTES_LIMIT } from '../../domain/import-limits.js';

export const WORKBOOK_LIMITS = {
  compressedBytes: IMPORT_COMPRESSED_BYTES_LIMIT,
  expandedBytes: 100 * 1024 * 1024,
  zipEntries: 100,
  sheets: 20,
  nonEmptyCellsPerSheet: 100_000,
  stringBytes: 64 * 1024,
  timeoutMs: 15_000,
} as const;

export class WorkbookImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkbookImportError';
  }
}
