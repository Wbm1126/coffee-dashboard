import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { finishFactMutation } from '../../domain/commands.js';
import { RECORD_NOT_FOUND_CODES, RecordCommandError } from '../../domain/record-command-error.js';
import { purchaseImpact, unitPricePer100g } from '../../domain/purchase.js';
import { IdSchema, LocalDateSchema, MoneySchema, type CoffeeData } from '../../domain/schema.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';
import { optionalText } from '../validation.js';

const SavePurchaseSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), purchaseId: IdSchema.nullable(), purchasedOn: LocalDateSchema,
  channel: optionalText(200), note: optionalText(4_000), shipping: MoneySchema.nullable(), discount: MoneySchema.nullable(),
  items: z.array(z.object({ purchaseItemId: IdSchema.nullable(), beanId: IdSchema, quantity: z.number().int().positive(),
    packageGrams: z.number().positive().nullable(), paid: MoneySchema.nullable() })).min(1).max(100)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (item.purchaseItemId === null) return;
        if (seen.has(item.purchaseItemId)) {
          context.addIssue({ code: 'custom', path: [index, 'purchaseItemId'], message: '同一购买项不能重复提交。' });
        }
        seen.add(item.purchaseItemId);
      });
    }),
});
const RevisionBody = z.object({ expectedRevision: z.number().int().nonnegative() });
const PurgeBody = RevisionBody.extend({ confirmPermanent: z.literal(true) });

function conflict(reply: FastifyReply, error: RevisionConflictError) {
  return reply.code(409).send({ error: 'revision_conflict', expected: error.expected, actual: error.actual,
    message: '数据已在其他页面更新，购买记录没有保存。请刷新后重试。' });
}

function commandError(reply: FastifyReply, error: RecordCommandError) {
  const status = error.code === 'restore_conflict' ? 409 : RECORD_NOT_FOUND_CODES.has(error.code) ? 404 : 422;
  const message = error.code === 'purchase_item_referenced'
    ? '该购买项已有饮用记录引用，不能移除或改成其他豆；请先更正关联饮用。当前输入已保留。'
    : '购买记录操作无法完成，现有数据保持不变。';
  return reply.code(status).send({ error: error.code, ...error.details, message });
}

export function registerPurchaseRoutes(app: FastifyInstance, repository: JsonRepository): void {
  app.post('/api/purchases/save', async (request, reply) => {
    const parsed = SavePurchaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_purchase', message: '请检查订单与全部商品行；整单未写入。', details: parsed.error.issues });
    try {
      let result: { purchaseId: string; items: Array<{ purchaseItemId: string; beanId: string; unitPricePer100g: number | null }> } | null = null;
      const data = await repository.mutate(parsed.data.expectedRevision, (draft, nextRevision) => {
        const now = new Date().toISOString();
        let purchase = parsed.data.purchaseId ? draft.purchases.find((item) => item.id === parsed.data.purchaseId && !item.deletedAt) : undefined;
        if (parsed.data.purchaseId && !purchase) throw new RecordCommandError('purchase_not_found');
        const existingPurchaseId = purchase?.id;
        const missing = parsed.data.items.filter((line) => {
          const bean = draft.beans.find((candidate) => candidate.id === line.beanId);
          if (!bean) return true;
          if (!bean.archivedAt) return false;
          if (!existingPurchaseId || !line.purchaseItemId) return true;
          const existingItem = draft.purchaseItems.find((item) => item.id === line.purchaseItemId && item.purchaseId === existingPurchaseId);
          return existingItem?.beanId !== line.beanId;
        }).map((line) => line.beanId);
        if (missing.length) throw new RecordCommandError('bean_not_found', { missingReferences: [...new Set(missing)] });
        if (!purchase) {
          purchase = { id: randomUUID(), purchasedOn: parsed.data.purchasedOn, channel: null, note: null,
            shipping: null, discount: null, itemIds: [], deletedAt: null, createdAt: now, updatedAt: now };
          draft.purchases.push(purchase);
        }
        const previousItems = draft.purchaseItems.filter((item) => item.purchaseId === purchase!.id);
        const submittedIds = new Set(parsed.data.items.map((item) => item.purchaseItemId).filter(Boolean));
        const removedIds = previousItems.filter((item) => !submittedIds.has(item.id)).map((item) => item.id);
        const referencedRemoved = removedIds.filter((id) => draft.drinkingRecords.some((record) => record.purchaseItemId === id));
        if (referencedRemoved.length) throw new RecordCommandError('purchase_item_referenced', { purchaseItemIds: referencedRemoved });
        draft.purchaseItems = draft.purchaseItems.filter((item) => item.purchaseId !== purchase!.id || !removedIds.includes(item.id));
        const savedItems = parsed.data.items.map((line) => {
          let item = line.purchaseItemId ? draft.purchaseItems.find((candidate) => candidate.id === line.purchaseItemId && candidate.purchaseId === purchase!.id) : undefined;
          if (line.purchaseItemId && !item) throw new RecordCommandError('purchase_item_not_found');
          if (!item) {
            item = { id: randomUUID(), purchaseId: purchase!.id, beanId: line.beanId, quantity: line.quantity,
              packageGrams: line.packageGrams, paid: line.paid, bagStatus: 'unopened' };
            draft.purchaseItems.push(item);
          } else {
            if (item.beanId !== line.beanId && draft.drinkingRecords.some((record) => record.purchaseItemId === item!.id)) {
              throw new RecordCommandError('purchase_item_referenced', { purchaseItemIds: [item.id] });
            }
            Object.assign(item, { beanId: line.beanId, quantity: line.quantity, packageGrams: line.packageGrams, paid: line.paid });
          }
          return { purchaseItemId: item.id, beanId: item.beanId, unitPricePer100g: unitPricePer100g(line) };
        });
        Object.assign(purchase, { purchasedOn: parsed.data.purchasedOn, channel: parsed.data.channel, note: parsed.data.note,
          shipping: parsed.data.shipping, discount: parsed.data.discount, itemIds: savedItems.map((item) => item.purchaseItemId), updatedAt: now });
        finishFactMutation(draft, now, nextRevision);
        result = { purchaseId: purchase.id, items: savedItems };
      });
      return reply.code(parsed.data.purchaseId ? 200 : 201).send({ dataRevision: data.dataRevision, ...result! });
    } catch (error) {
      if (error instanceof RevisionConflictError) return conflict(reply, error);
      if (error instanceof RecordCommandError) return commandError(reply, error);
      throw error;
    }
  });

  app.get('/api/purchases/:id/trash-impact', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'purchase_not_found' });
    const data = await repository.read();
    const impact = purchaseImpact(data, id.data);
    return impact ? reply.send(impact) : reply.code(404).send({ error: 'purchase_not_found' });
  });

  app.post('/api/purchases/:id/trash', async (request, reply) => mutateDeletedState(repository, request, reply, true));
  app.post('/api/purchases/:id/restore', async (request, reply) => mutateDeletedState(repository, request, reply, false));
  app.delete('/api/purchases/:id', async (request, reply) => {
    const body = PurgeBody.safeParse(request.body); const id = IdSchema.safeParse((request.params as { id: string }).id);
    if (!body.success || !id.success) return reply.code(422).send({ error: 'explicit_confirmation_required' });
    try {
      const data = await repository.mutate(body.data.expectedRevision, (draft, nextRevision) => {
        const purchase = draft.purchases.find((item) => item.id === id.data);
        if (!purchase) throw new RecordCommandError('purchase_not_found');
        if (!purchase.deletedAt) throw new RecordCommandError('permanent_clear_requires_trashed_record');
        const itemIds = new Set(draft.purchaseItems.filter((item) => item.purchaseId === purchase.id).map((item) => item.id));
        if (draft.drinkingRecords.some((record) => record.purchaseItemId && itemIds.has(record.purchaseItemId))) {
          throw new RecordCommandError('purchase_item_referenced');
        }
        draft.purchases = draft.purchases.filter((item) => item.id !== purchase.id);
        draft.purchaseItems = draft.purchaseItems.filter((item) => item.purchaseId !== purchase.id);
        finishFactMutation(draft, new Date().toISOString(), nextRevision);
      });
      return reply.send({ dataRevision: data.dataRevision, action: 'permanently_deleted' });
    } catch (error) {
      if (error instanceof RevisionConflictError) return conflict(reply, error);
      if (error instanceof RecordCommandError) return commandError(reply, error);
      throw error;
    }
  });
}

async function mutateDeletedState(repository: JsonRepository, request: FastifyRequest, reply: FastifyReply, deleting: boolean) {
  const body = RevisionBody.safeParse(request.body); const id = IdSchema.safeParse((request.params as { id: string }).id);
  if (!body.success || !id.success) return reply.code(422).send({ error: 'invalid_request' });
  try {
    const data = await repository.mutate(body.data.expectedRevision, (draft: CoffeeData, nextRevision) => {
      const purchase = draft.purchases.find((item) => item.id === id.data);
      if (!purchase) throw new RecordCommandError('purchase_not_found');
      if (deleting && purchase.deletedAt) throw new RecordCommandError('already_in_trash');
      if (!deleting && !purchase.deletedAt) throw new RecordCommandError('not_in_trash');
      if (!deleting) {
        const missingReferences = draft.purchaseItems.filter((item) => item.purchaseId === purchase.id)
          .map((item) => item.beanId).filter((beanId) => !draft.beans.some((bean) => bean.id === beanId));
        if (missingReferences.length) throw new RecordCommandError('restore_conflict', { missingReferences });
      }
      purchase.deletedAt = deleting ? new Date().toISOString() : null;
      purchase.updatedAt = new Date().toISOString();
      finishFactMutation(draft, purchase.updatedAt, nextRevision);
    });
    return reply.send({ dataRevision: data.dataRevision, action: deleting ? 'trashed' : 'restored', undoAvailable: deleting });
  } catch (error) {
    if (error instanceof RevisionConflictError) return conflict(reply, error);
    if (error instanceof RecordCommandError) return commandError(reply, error);
    throw error;
  }
}
