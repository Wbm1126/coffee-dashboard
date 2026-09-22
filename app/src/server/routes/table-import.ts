import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ImportConflictChoiceSchema } from '../../domain/import-contract.js';
import {
  commitTablePreview,
  InvalidTableResolutionError,
  TABLE_DUPLICATE_DECISION_SCHEMA,
  UnresolvedTableConflictError,
  UnresolvedTableDuplicateError,
  UnresolvedTableSkipError,
  type ConflictResolutions,
  type DuplicateDecisions,
} from '../../import/table/commit-service.js';
import {
  createTablePreview,
  decodeTableUpload,
  inspectTable,
  TABLE_MAPPING_OVERRIDE_SCHEMA,
  TABLE_UPLOAD_SCHEMA,
} from '../../import/table/preview-service.js';
import { WorkbookImportError } from '../../import/xlsx/workbook-policy.js';
import type { RecognizedTableItem } from '../../import/table/generic-matcher.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';

const InspectBodySchema = z.object({ file: TABLE_UPLOAD_SCHEMA });
const PreviewBodySchema = z.object({
  file: TABLE_UPLOAD_SCHEMA,
  sheetName: z.string().min(1).max(200).optional(),
  headerRow: z.number().int().min(1).max(1_000).optional(),
  mapping: TABLE_MAPPING_OVERRIDE_SCHEMA.optional(),
});
const CommitBodySchema = z.object({
  previewId: z.string().length(32),
  expectedRevision: z.number().int().nonnegative(),
  resolutions: z.record(z.string(), ImportConflictChoiceSchema),
  duplicateDecisions: z.record(z.string(), TABLE_DUPLICATE_DECISION_SCHEMA).default({}),
  skippedBeanKeys: z.array(z.string().min(1)).default([]),
  mergeTargets: z.record(z.string(), z.string().min(1)).default({}),
});

const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_PREVIEWS = 3;

function sendImportError(reply: { code: (code: number) => { send: (body: unknown) => unknown } }, error: unknown): unknown {
  if (error instanceof WorkbookImportError) return reply.code(422).send({ error: error.code, message: error.message });
  throw error;
}

export function registerTableImportRoutes(app: FastifyInstance, repository: JsonRepository): void {
  const previews = new Map<string, { preview: Awaited<ReturnType<typeof createTablePreview>>; expiresAt: number }>();

  const pruneExpiredPreviews = () => {
    const now = Date.now();
    for (const [id, entry] of previews) if (entry.expiresAt <= now) previews.delete(id);
  };

  const makeRoomForPreview = () => {
    pruneExpiredPreviews();
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
  };

  app.post('/api/import/table/inspect', { bodyLimit: 72 * 1024 * 1024 }, async (request, reply) => {
    const parsed = InspectBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_upload', message: '请上传有效的 .xlsx 或 .csv 文件；数据未写入。', details: parsed.error.issues });
    try {
      const sheets = await inspectTable(decodeTableUpload(parsed.data.file));
      return reply.code(200).send({ sheets });
    } catch (error) {
      return sendImportError(reply, error);
    }
  });

  app.post('/api/import/table/preview', { bodyLimit: 72 * 1024 * 1024 }, async (request, reply) => {
    const parsed = PreviewBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_upload', message: '上传内容无效；数据未写入。', details: parsed.error.issues });
    try {
      const existing = await repository.read();
      const preview = await createTablePreview({
        upload: decodeTableUpload(parsed.data.file),
        sheetName: parsed.data.sheetName,
        headerRow: parsed.data.headerRow,
        mappingOverride: parsed.data.mapping,
        existing,
      });
      makeRoomForPreview();
      previews.set(preview.id, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
      return reply.code(200).send({
        id: preview.id,
        baseRevision: preview.baseRevision,
        batchKey: preview.batchKey,
        fileName: preview.fileName,
        sheetName: preview.sheetName,
        headerRow: preview.headerRow,
        mapping: preview.mapping,
        summary: preview.summary,
        categories: preview.categories,
        conflicts: preview.conflicts.map((conflict) => ({
          id: conflict.id,
          beanKey: conflict.beanKey,
          beanName: conflict.beanName,
          field: conflict.field,
          incomingValue: conflict.incomingValue,
          existingValue: conflict.existingValue,
          incomingLocation: conflict.incomingLocation,
          availableChoices: conflict.availableChoices,
        })),
        duplicates: preview.items
          .filter((item): item is RecognizedTableItem => item.category === 'possible_duplicate')
          .map((item) => ({ beanKey: item.beanKey, brandName: item.brandName, beanName: item.beanName, duplicateTargets: item.duplicateTargets ?? [] })),
        unrecognized: preview.items
          .filter((item) => item.category === 'unrecognized')
          .map(({ beanKey, brandName, beanName, reason }) => ({ beanKey, brandName, beanName, reason })),
      });
    } catch (error) {
      return sendImportError(reply, error);
    }
  });

  app.post('/api/import/table/commit', async (request, reply) => {
    const parsed = CommitBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_commit', message: '提交内容无效，数据未写入。', details: parsed.error.issues });
    pruneExpiredPreviews();
    const entry = previews.get(parsed.data.previewId);
    if (!entry) return reply.code(410).send({ error: 'preview_expired', message: '导入预览已失效，请重新预览；数据未写入。' });
    const preview = entry.preview;
    if (parsed.data.expectedRevision !== preview.baseRevision) {
      return reply.code(409).send({ error: 'preview_revision_mismatch', message: '提交的数据版本与预览不一致，请重新预览；数据未写入。' });
    }
    try {
      const result = await commitTablePreview(
        repository,
        preview,
        parsed.data.resolutions as ConflictResolutions,
        parsed.data.duplicateDecisions as DuplicateDecisions,
        parsed.data.skippedBeanKeys,
        parsed.data.mergeTargets,
      );
      previews.delete(preview.id);
      return reply.code(200).send({
        alreadyImported: result.alreadyImported,
        backupName: result.backupName,
        dataRevision: result.data.dataRevision,
        beans: result.data.beans.length,
        brands: result.data.brands.length,
        beanEvaluations: result.data.beanEvaluations.length,
        beansWritten: result.beansWritten,
        evaluationsWritten: result.evaluationsWritten,
      });
    } catch (error) {
      if (error instanceof UnresolvedTableConflictError) return reply.code(409).send({ error: 'conflicts_unresolved', message: error.message, conflictIds: error.conflictIds });
      if (error instanceof UnresolvedTableDuplicateError) return reply.code(409).send({ error: 'duplicates_unresolved', message: error.message, beanKeys: error.beanKeys });
      if (error instanceof UnresolvedTableSkipError) return reply.code(409).send({ error: 'skips_unresolved', message: error.message, beanKeys: error.beanKeys });
      if (error instanceof InvalidTableResolutionError) return reply.code(422).send({ error: 'invalid_resolution', message: `${error.message}数据未写入。` });
      if (error instanceof RevisionConflictError) return reply.code(409).send({ error: 'revision_conflict', message: '看板数据已变更，请重新生成预览；数据未写入。', expected: error.expected, actual: error.actual });
      throw error;
    }
  });
}
