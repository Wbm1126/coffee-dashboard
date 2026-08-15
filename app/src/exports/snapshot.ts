import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoffeeData } from '../domain/schema.js';
import { IdSchema } from '../domain/schema.js';
import type { ExportReport } from './report-model.js';

export interface ExportSnapshot {
  id: string;
  dataRevision: number;
  generatedAt: string;
  beanIds: string[];
  filters: Record<string, string>;
  sort: { field: string; direction: 'asc' | 'desc' };
}

const ExportSnapshotSchema = z.object({
  id: IdSchema,
  dataRevision: z.number().int().nonnegative(),
  generatedAt: z.string().datetime({ offset: true }),
  beanIds: z.array(IdSchema).min(1),
  filters: z.record(z.string(), z.string()),
  sort: z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }),
});

const ExportReportBeanSchema = z.object({
  id: IdSchema,
  brand: z.string(),
  name: z.string(),
  roast: z.string(),
  process: z.string(),
  flavorNotes: z.array(z.string()),
  price: z.string(),
  americano: z.string(),
  milk: z.string(),
  assessment: z.string(),
  sources: z.array(z.string()),
});

export const StoredExportSnapshotSchema = ExportSnapshotSchema.extend({
  reportBeans: z.array(ExportReportBeanSchema),
});

export type StoredExportSnapshot = z.infer<typeof StoredExportSnapshotSchema>;

export function parseExportSnapshot(value: unknown): ExportSnapshot | null {
  const parsed = ExportSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseStoredExportSnapshot(value: unknown): StoredExportSnapshot | null {
  const parsed = StoredExportSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function storeExportReport(report: ExportReport): StoredExportSnapshot {
  return StoredExportSnapshotSchema.parse({ ...report.snapshot, reportBeans: report.beans });
}

export function restoreExportReport(stored: StoredExportSnapshot): ExportReport {
  const { reportBeans, ...snapshot } = stored;
  return { snapshot, beans: reportBeans };
}

export function createExportSnapshot(data: CoffeeData, input: { beanIds: string[]; filters?: Record<string, string>; sort?: { field: string; direction: 'asc' | 'desc' } }): ExportSnapshot {
  const existing = new Set(data.beans.filter((bean) => !bean.archivedAt).map((bean) => bean.id));
  const beanIds = [...new Set(input.beanIds)].filter((id) => existing.has(id));
  if (!beanIds.length) throw new Error('export_scope_empty');
  return { id: randomUUID(), dataRevision: data.dataRevision, generatedAt: new Date().toISOString(), beanIds, filters: input.filters ?? {}, sort: input.sort ?? { field: 'name', direction: 'asc' } };
}
