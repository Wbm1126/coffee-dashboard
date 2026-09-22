import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { beanIdentityKey } from '../../domain/bean-identity.js';
import { findOrCreateActiveBrand } from '../../domain/brand.js';
import { finishFactMutation, purgeDrinkingRecord, restoreDrinkingRecord, trashDrinkingRecord } from '../../domain/commands.js';
import { assertPurchaseItemMatchesBean, drinkingImpact } from '../../domain/drinking.js';
import { RECORD_NOT_FOUND_CODES, RecordCommandError } from '../../domain/record-command-error.js';
import { buildCatchUpQueue, isDrinkingRecordReviewComplete } from '../../domain/review-completeness.js';
import { createUnreviewedReview } from '../../domain/review-defaults.js';
import {
  BrandSchema,
  BrewMethodSchema,
  CoffeeBeanSchema,
  IdSchema,
  LocalDateSchema,
  RepurchaseSchema,
  ReviewSchema,
  type CoffeeData,
  type DrinkingRecord,
} from '../../domain/schema.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';
import { optionalText } from '../validation.js';

const QuickBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  items: z.array(z.object({
    brandName: BrandSchema.shape.name,
    beanName: CoffeeBeanSchema.shape.name,
    drankOn: LocalDateSchema,
    brewMethod: BrewMethodSchema,
  })).min(1).max(30),
});

const AssessmentSchema = z.object({
  grade: optionalText(40),
  repurchase: RepurchaseSchema.nullable(),
  summary: optionalText(8_000),
});

const SaveBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  beanId: IdSchema,
  purchaseItemId: IdSchema.nullable().default(null),
  drinkingRecordId: IdSchema.nullable(),
  drankOn: LocalDateSchema,
  brewMethod: BrewMethodSchema,
  extractionNote: optionalText(4_000),
  feeling: optionalText(8_000),
  americanoReview: ReviewSchema,
  milkReview: ReviewSchema,
  isDraft: z.boolean(),
  assessment: AssessmentSchema.nullable(),
}).superRefine((body, context) => {
  if (body.isDraft) return;
  for (const field of ['americanoReview', 'milkReview'] as const) {
    if (body[field].state === 'reviewed' && body[field].score === null) {
      context.addIssue({
        code: 'custom',
        path: [field, 'score'],
        message: '已评价维度必须填写 1–5 分评分。',
      });
    }
  }
});

function sendRevisionConflict(reply: FastifyReply, error: RevisionConflictError) {
  return reply.code(409).send({
    error: 'revision_conflict',
    message: '看板数据已在其他页面更新。当前表单仍会保留，请刷新数据后重试。',
    expected: error.expected,
    actual: error.actual,
  });
}

export function registerDrinkingRoutes(app: FastifyInstance, repository: JsonRepository): void {
  app.get('/api/catch-up', async (_request, reply) => {
    const inspection = await repository.inspect();
    if (inspection.mode !== 'ready') return reply.code(503).send(inspection);
    return reply.send({ dataRevision: inspection.data.dataRevision, ...buildCatchUpQueue(inspection.data) });
  });

  app.post('/api/catch-up/quick', async (request, reply) => {
    const parsed = QuickBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_quick_entry', message: '请检查品牌、豆名和饮用日期；数据未写入。', details: parsed.error.issues });
    const created: Array<{ beanId: string; drinkingRecordId: string }> = [];
    try {
      const data = await repository.mutate(parsed.data.expectedRevision, (draft, nextRevision) => {
        const now = new Date().toISOString();
        const beansByKey = new Map(draft.beans
          .filter((bean) => !bean.archivedAt)
          .map((bean) => [bean.normalizedKey, bean]));
        for (const item of parsed.data.items) {
          const brand = findOrCreateActiveBrand(draft, item.brandName, now);
          const normalizedKey = beanIdentityKey(brand.name, item.beanName);
          let bean = beansByKey.get(normalizedKey);
          if (!bean) {
            bean = {
              id: randomUUID(), brandId: brand.id, name: item.beanName, normalizedKey,
              roastLevel: null, process: null, flavorNotes: [], followedAt: null, archivedAt: null,
              isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {},
              createdAt: now, updatedAt: now,
            };
            draft.beans.push(bean);
            beansByKey.set(normalizedKey, bean);
          }
          const drinkingRecordId = randomUUID();
          draft.drinkingRecords.push({
            id: drinkingRecordId, beanId: bean.id, purchaseItemId: null, drankOn: item.drankOn,
            brewMethod: item.brewMethod, extractionNote: null, brewParams: null, feeling: null,
            americanoReview: createUnreviewedReview(), milkReview: createUnreviewedReview(), draftAssessment: null, isDraft: false,
            deletedAt: null, createdAt: now, updatedAt: now,
          });
          created.push({ beanId: bean.id, drinkingRecordId });
        }
        finishFactMutation(draft, now, nextRevision);
      });
      return reply.code(201).send({ dataRevision: data.dataRevision, created: created.length, items: created });
    } catch (error) {
      if (error instanceof RevisionConflictError) return sendRevisionConflict(reply, error);
      throw error;
    }
  });

  app.post('/api/drinking/save', async (request, reply) => {
    const parsed = SaveBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_drinking_record', message: '评价内容未通过校验，数据未写入。', details: parsed.error.issues });
    let savedRecord: DrinkingRecord | null = null;
    try {
      const data = await repository.mutate(parsed.data.expectedRevision, (draft, nextRevision) => {
        let record = parsed.data.drinkingRecordId === null
          ? undefined
          : draft.drinkingRecords.find((candidate) => candidate.id === parsed.data.drinkingRecordId && !candidate.deletedAt);
        if (parsed.data.drinkingRecordId !== null && !record) throw new Error('drinking_record_not_found');
        const bean = draft.beans.find((candidate) => candidate.id === parsed.data.beanId);
        const keepsArchivedBean = record?.beanId === bean?.id;
        if (!bean || (bean.archivedAt && !keepsArchivedBean)) throw new Error('bean_not_found');
        const now = new Date().toISOString();
        const previousBeanId = record?.beanId ?? null;
        assertPurchaseItemMatchesBean(draft, parsed.data.purchaseItemId, bean.id);
        if (!record) {
          record = {
            id: randomUUID(), beanId: bean.id, purchaseItemId: parsed.data.purchaseItemId, drankOn: parsed.data.drankOn,
            brewMethod: parsed.data.brewMethod, extractionNote: null, brewParams: null, feeling: null,
            americanoReview: createUnreviewedReview(), milkReview: createUnreviewedReview(),
            draftAssessment: null, isDraft: parsed.data.isDraft,
            deletedAt: null, createdAt: now, updatedAt: now,
          };
          draft.drinkingRecords.push(record);
        }
        Object.assign(record, {
          beanId: bean.id,
          purchaseItemId: parsed.data.purchaseItemId,
          drankOn: parsed.data.drankOn,
          brewMethod: parsed.data.brewMethod,
          extractionNote: parsed.data.extractionNote,
          feeling: parsed.data.feeling,
          americanoReview: parsed.data.americanoReview,
          milkReview: parsed.data.milkReview,
          draftAssessment: parsed.data.isDraft ? parsed.data.assessment : null,
          isDraft: parsed.data.isDraft,
          updatedAt: now,
        });
        savedRecord = structuredClone(record);

        if (previousBeanId !== null && previousBeanId !== bean.id) {
          const previousAssessment = draft.assessments.find((candidate) => candidate.beanId === previousBeanId);
          if (previousAssessment) {
            previousAssessment.basedOnDrinkingIds = previousAssessment.basedOnDrinkingIds.filter((id) => id !== record.id);
            previousAssessment.updatedAt = now;
          }
        }

        if (!parsed.data.isDraft && parsed.data.assessment) {
          let assessment = draft.assessments.find((candidate) => candidate.beanId === bean.id);
          if (!assessment) {
            assessment = { id: randomUUID(), beanId: bean.id, grade: null, repurchase: null, summary: null, basedOnDrinkingIds: [], updatedAt: now };
            draft.assessments.push(assessment);
          }
          assessment.grade = parsed.data.assessment.grade;
          assessment.repurchase = parsed.data.assessment.repurchase;
          assessment.summary = parsed.data.assessment.summary;
          assessment.basedOnDrinkingIds = [...new Set([...assessment.basedOnDrinkingIds, record.id])];
          assessment.updatedAt = now;
        }
        finishFactMutation(draft, now, nextRevision);
      });
      return reply.send({
        dataRevision: data.dataRevision,
        drinkingRecordId: savedRecord!.id,
        reviewComplete: !savedRecord!.isDraft && isDrinkingRecordReviewComplete(savedRecord!),
      });
    } catch (error) {
      if (error instanceof RevisionConflictError) return sendRevisionConflict(reply, error);
      if (error instanceof RecordCommandError) {
        const status = error.code === 'purchase_item_bean_mismatch' ? 422 : 404;
        return reply.code(status).send({ error: error.code, ...error.details, message: '饮用记录与购买项无法关联；数据未写入。' });
      }
      if (error instanceof Error && ['bean_not_found', 'drinking_record_not_found'].includes(error.message)) {
        return reply.code(404).send({ error: error.message, message: '找不到对应的咖啡豆或饮用记录；数据未写入。' });
      }
      throw error;
    }
  });

  app.get('/api/drinking/:id/trash-impact', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'drinking_record_not_found' });
    const impact = drinkingImpact(await repository.read(), id.data);
    return impact ? reply.send(impact) : reply.code(404).send({ error: 'drinking_record_not_found' });
  });

  const revisionBody = z.object({ expectedRevision: z.number().int().nonnegative() });
  app.post('/api/drinking/:id/trash', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id); const body = revisionBody.safeParse(request.body);
    if (!id.success || !body.success) return reply.code(422).send({ error: 'invalid_request' });
    return mutateTrash(repository, reply, body.data.expectedRevision, (draft, now, nextRevision) => trashDrinkingRecord(draft, id.data, now, nextRevision), 'trashed');
  });
  app.post('/api/drinking/:id/restore', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id); const body = revisionBody.safeParse(request.body);
    if (!id.success || !body.success) return reply.code(422).send({ error: 'invalid_request' });
    return mutateTrash(repository, reply, body.data.expectedRevision, (draft, now, nextRevision) => restoreDrinkingRecord(draft, id.data, now, nextRevision), 'restored');
  });
  app.delete('/api/drinking/:id', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id);
    const body = revisionBody.extend({ confirmPermanent: z.literal(true) }).safeParse(request.body);
    if (!id.success || !body.success) return reply.code(422).send({ error: 'explicit_confirmation_required' });
    return mutateTrash(repository, reply, body.data.expectedRevision, (draft, now, nextRevision) => purgeDrinkingRecord(draft, id.data, now, nextRevision), 'permanently_deleted');
  });
}

async function mutateTrash(
  repository: JsonRepository,
  reply: FastifyReply,
  expectedRevision: number,
  command: (data: CoffeeData, now: string, nextRevision: number) => void,
  action: 'trashed' | 'restored' | 'permanently_deleted',
) {
  try {
    const data = await repository.mutate(expectedRevision, (draft, nextRevision) => command(draft, new Date().toISOString(), nextRevision));
    return reply.send({ dataRevision: data.dataRevision, action, undoAvailable: action === 'trashed' });
  } catch (error) {
    if (error instanceof RevisionConflictError) return sendRevisionConflict(reply, error);
    if (error instanceof RecordCommandError) {
      const status = ['restore_conflict', 'assessment_basis_conflict'].includes(error.code)
        ? 409
        : RECORD_NOT_FOUND_CODES.has(error.code) ? 404 : 422;
      return reply.code(status).send({ error: error.code, ...error.details,
        message: error.code === 'restore_conflict'
          ? '无法恢复：关联对象已经缺失，请先处理冲突。'
          : error.code === 'assessment_basis_conflict'
            ? '无法永久清除：这条饮用是个人综合评价的唯一依据。请先更正评价依据或保留该记录。'
            : '回收站操作无法完成，现有数据保持不变。' });
    }
    throw error;
  }
}
