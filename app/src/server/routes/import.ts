import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ImportConflictChoiceSchema } from '../../domain/import-contract.js';
import {
  commitImportPreview,
  InvalidImportResolutionError,
  UnresolvedImportConflictError,
  UnresolvedImportItemError,
} from '../../import/xlsx/commit-service.js';
import { createImportPreview, type ImportPreview } from '../../import/xlsx/preview-service.js';
import { WorkbookImportError } from '../../import/xlsx/workbook-reader.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';

const UploadSchema = z.object({
  name: z.string().min(1).max(260).refine((name) => name.toLowerCase().endsWith('.xlsx'), '只接受 .xlsx 文件'),
  base64: z.string().min(1),
});

const PreviewBodySchema = z.object({ complete: UploadSchema, selection: UploadSchema });
const CommitBodySchema = z.object({
  previewId: z.string().length(64),
  expectedRevision: z.number().int().nonnegative(),
  resolutions: z.record(z.string(), ImportConflictChoiceSchema),
  skippedBeanKeys: z.array(z.string().min(1)).default([]),
});

const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_PREVIEWS = 3;

function decodeUpload(upload: z.infer<typeof UploadSchema>) {
  const bytes = Buffer.from(upload.base64, 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== upload.base64.replace(/\s|=+$/g, '')) {
    throw new WorkbookImportError('base64_invalid', '上传内容不是有效的 Base64 文件。');
  }
  return { name: upload.name, bytes };
}

export function registerImportRoutes(app: FastifyInstance, repository: JsonRepository): void {
  const previews = new Map<string, { preview: ImportPreview; expiresAt: number }>();

  const pruneExpiredPreviews = () => {
    const now = Date.now();
    for (const [id, entry] of previews) if (entry.expiresAt <= now) previews.delete(id);
  };

  const makeRoomForPreview = () => {
    pruneExpiredPreviews();
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
  };

  app.post('/api/import/preview', { bodyLimit: 72 * 1024 * 1024 }, async (request, reply) => {
    const parsed = PreviewBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_upload', message: '请同时选择两份有效的 .xlsx 文件；数据未写入。', details: parsed.error.issues });
    try {
      const existing = await repository.read();
      const preview = await createImportPreview({
        complete: decodeUpload(parsed.data.complete),
        selection: decodeUpload(parsed.data.selection),
        existing,
      });
      makeRoomForPreview();
      previews.set(preview.id, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
      return reply.code(200).send({
        id: preview.id,
        baseRevision: preview.baseRevision,
        summary: preview.summary,
        categories: preview.categories,
        conflicts: preview.conflicts.map((conflict) => ({
          id: conflict.id,
          beanKey: conflict.beanKey,
          beanName: conflict.beanName,
          field: conflict.field,
          completeValue: conflict.completeValue,
          selectionValue: conflict.selectionValue,
          completeLocation: conflict.completeLocation,
          selectionLocation: conflict.selectionLocation,
          existingValue: conflict.existingValue,
          availableChoices: conflict.availableChoices,
        })),
        unrecognized: preview.items
          .filter((item) => item.category === 'unrecognized')
          .map(({ beanKey, brandName, beanName, reason }) => ({ beanKey, brandName, beanName, reason })),
      });
    } catch (error) {
      if (error instanceof WorkbookImportError) return reply.code(422).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post('/api/import/commit', async (request, reply) => {
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
      const result = await commitImportPreview(repository, preview, parsed.data.resolutions, parsed.data.skippedBeanKeys);
      previews.delete(preview.id);
      return reply.code(200).send({
        alreadyImported: result.alreadyImported,
        backupName: result.backupName,
        dataRevision: result.data.dataRevision,
        beans: result.data.beans.length,
        brands: result.data.brands.length,
      });
    } catch (error) {
      if (error instanceof UnresolvedImportConflictError) return reply.code(409).send({ error: 'conflicts_unresolved', message: error.message, conflictIds: error.conflictIds });
      if (error instanceof UnresolvedImportItemError) return reply.code(409).send({ error: 'items_unresolved', message: error.message, beanKeys: error.beanKeys });
      if (error instanceof InvalidImportResolutionError) return reply.code(422).send({ error: 'invalid_resolution', message: `${error.message}数据未写入。` });
      if (error instanceof RevisionConflictError) return reply.code(409).send({ error: 'revision_conflict', message: '看板数据已变更，请重新生成预览；数据未写入。', expected: error.expected, actual: error.actual });
      throw error;
    }
  });
}
