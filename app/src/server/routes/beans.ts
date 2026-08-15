import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { beanDeleteImpact, finishFactMutation } from '../../domain/commands.js';
import { RecordCommandError } from '../../domain/record-command-error.js';
import { IdSchema } from '../../domain/schema.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';

const DeleteBody = z.object({ expectedRevision: z.number().int().nonnegative(), confirmPermanent: z.boolean() });
const RevisionBody = z.object({ expectedRevision: z.number().int().nonnegative() });

export function registerBeanRoutes(app: FastifyInstance, repository: JsonRepository): void {
  app.post('/api/beans/:id/follow', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id);
    const body = RevisionBody.safeParse(request.body);
    if (!id.success || !body.success) return reply.code(422).send({ error: 'invalid_request', message: '关注没有保存，请刷新后重试。' });
    try {
      const data = await repository.mutate(body.data.expectedRevision, (draft, nextRevision) => {
        const bean = draft.beans.find((candidate) => candidate.id === id.data && !candidate.archivedAt);
        if (!bean) throw new RecordCommandError('bean_not_found');
        const now = new Date().toISOString();
        bean.followedAt ??= now;
        bean.updatedAt = now;
        finishFactMutation(draft, now, nextRevision);
      });
      return reply.send({ dataRevision: data.dataRevision, followed: true });
    } catch (error) {
      if (error instanceof RevisionConflictError) return revisionConflict(reply, error, '数据已更新；关注没有保存，请刷新后重试。');
      if (error instanceof RecordCommandError) return reply.code(404).send({ error: error.code, message: '找不到这支咖啡豆，关注没有保存。' });
      throw error;
    }
  });

  app.get('/api/beans/:id/delete-impact', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'bean_not_found' });
    const impact = beanDeleteImpact(await repository.read(), id.data);
    return impact ? reply.send(impact) : reply.code(404).send({ error: 'bean_not_found' });
  });

  app.delete('/api/beans/:id', async (request, reply) => {
    const id = IdSchema.safeParse((request.params as { id: string }).id);
    const body = DeleteBody.safeParse(request.body);
    if (!id.success || !body.success || !body.data.confirmPermanent) {
      return reply.code(422).send({ error: 'explicit_confirmation_required', message: '请先查看关联影响并明确确认。' });
    }
    try {
      let action: 'archived' | 'permanently_deleted' = 'archived';
      const data = await repository.mutate(body.data.expectedRevision, (draft, nextRevision) => {
        const bean = draft.beans.find((candidate) => candidate.id === id.data);
        if (!bean) throw new RecordCommandError('bean_not_found');
        const impact = beanDeleteImpact(draft, bean.id)!;
        const now = new Date().toISOString();
        if (impact.canPermanentlyDelete) {
          draft.beans = draft.beans.filter((candidate) => candidate.id !== bean.id);
          action = 'permanently_deleted';
        } else {
          bean.archivedAt = now;
          bean.updatedAt = now;
        }
        finishFactMutation(draft, now, nextRevision);
      });
      return reply.send({ dataRevision: data.dataRevision, action });
    } catch (error) {
      if (error instanceof RevisionConflictError) return revisionConflict(reply, error, '数据已更新；咖啡豆没有归档或删除，请刷新后重试。');
      if (error instanceof RecordCommandError) return reply.code(404).send({ error: error.code });
      throw error;
    }
  });
}

function revisionConflict(reply: FastifyReply, error: RevisionConflictError, message: string) {
  return reply.code(409).send({ error: 'revision_conflict', expected: error.expected, actual: error.actual,
    message });
}
