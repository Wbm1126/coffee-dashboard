import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildExportReport } from '../../exports/report-model.js';
import { renderMarkdown } from '../../exports/markdown.js';
import { renderPdf } from '../../exports/pdf.js';
import {
  createExportSnapshot,
  parseExportSnapshot,
  parseStoredExportSnapshot,
  restoreExportReport,
  storeExportReport,
  type ExportSnapshot,
} from '../../exports/snapshot.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';
import { IdSchema } from '../../domain/schema.js';
const Body = z.object({ expectedRevision: z.number().int().nonnegative(), beanIds: z.array(IdSchema).min(1), filters: z.record(z.string(), z.string()).optional(), sort: z.object({ field: z.string(), direction: z.enum(['asc','desc']) }).optional(), formats: z.array(z.enum(['markdown','pdf'])).min(1).max(2), snapshotId: IdSchema.optional() });
const artifactWrites = new Map<string, Promise<void>>();

async function atomicWrite(dir: string, name: string, bytes: string | Buffer) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  const previous = artifactWrites.get(target) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes);
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  });
  artifactWrites.set(target, current);
  try {
    await current;
    return target;
  } finally {
    if (artifactWrites.get(target) === current) artifactWrites.delete(target);
  }
}
export function registerExportRoutes(app: FastifyInstance, repository: JsonRepository): void {
  app.post('/api/exports', async (request, reply) => {
    const parsed = Body.safeParse(request.body); if (!parsed.success) return reply.code(422).send({ error: 'invalid_export' });
    let prepared: { snapshot: ExportSnapshot; dataRevision: number } | null = null;
    try {
      const result = await repository.transact(parsed.data.expectedRevision, 'export-snapshot', (draft) => {
        const oldIndex = parsed.data.snapshotId
          ? draft.exportSnapshots.findIndex((item) => typeof item === 'object' && item !== null && (item as { id?: string }).id === parsed.data.snapshotId)
          : -1;
        const old = oldIndex >= 0 ? draft.exportSnapshots[oldIndex] : undefined;
        const stored = parseStoredExportSnapshot(old);
        if (stored) {
          const report = restoreExportReport(stored);
          return { commit: false, value: { snapshot: report.snapshot, report } };
        }

        const legacy = parseExportSnapshot(old);
        if (legacy) {
          // The legacy export transaction itself advanced the revision once after
          // recording the pre-commit revision in the snapshot. Any larger gap may
          // contain changed report facts and therefore cannot be reconstructed.
          if (draft.dataRevision > legacy.dataRevision + 1) throw new LegacyExportSnapshotError();
          const report = buildExportReport(draft, legacy);
          draft.exportSnapshots[oldIndex] = storeExportReport(report);
          return { commit: true, value: { snapshot: legacy, report } };
        }

        const snapshot = createExportSnapshot(draft, parsed.data);
        const report = buildExportReport(draft, snapshot);
        draft.exportSnapshots.push(storeExportReport(report));
        return { commit: true, value: { snapshot, report } };
      });
      prepared = { snapshot: result.value.snapshot, dataRevision: result.data.dataRevision };
      const outDir = join(repository.dataDir, 'exports'); const artifacts: Record<string, string> = {};
      if (parsed.data.formats.includes('markdown')) { await atomicWrite(outDir, `${result.value.snapshot.id}.md`, renderMarkdown(result.value.report)); artifacts.markdown = `/api/exports/${result.value.snapshot.id}.md`; }
      if (parsed.data.formats.includes('pdf')) { await atomicWrite(outDir, `${result.value.snapshot.id}.pdf`, await renderPdf(result.value.report)); artifacts.pdf = `/api/exports/${result.value.snapshot.id}.pdf`; }
      return reply.send({ snapshot: result.value.snapshot, dataRevision: result.data.dataRevision, artifacts });
    } catch (error) { if (error instanceof RevisionConflictError) return reply.code(409).send({ error: 'revision_conflict' }); if (error instanceof LegacyExportSnapshotError) return reply.code(409).send({ error: 'legacy_export_snapshot', message: '旧版快照未保存完整报告且数据已变更，请创建新快照。' }); return reply.code(500).send({ error: 'export_failed', message: '导出未完整生成；快照可用于重试。', ...(prepared ?? {}) }); }
  });
  app.get('/api/exports/:snapshotId.:extension', async (request, reply) => {
    const parsed = z.object({ snapshotId: IdSchema, extension: z.enum(['md', 'pdf']) }).safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'export_not_found' });
    const file = join(repository.dataDir, 'exports', `${parsed.data.snapshotId}.${parsed.data.extension}`);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'export_not_found' });
      throw error;
    }
    reply.header('Content-Type', parsed.data.extension === 'pdf' ? 'application/pdf' : 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="coffee-report-${parsed.data.snapshotId}.${parsed.data.extension}"`);
    return reply.send(bytes);
  });
}

class LegacyExportSnapshotError extends Error {}
