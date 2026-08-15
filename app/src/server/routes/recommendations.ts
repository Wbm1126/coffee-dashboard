import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { expireRecommendations } from '../../domain/commands.js';
import { PreferenceProfileSchema, RecommendationSnapshotSchema } from '../../domain/schema.js';
import { generateRecommendationSnapshot } from '../../recommendation/engine.js';
import { RECOMMENDATION_RULE_VERSION } from '../../recommendation/rules.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';

const RevisionBody = z.object({ expectedRevision: z.number().int().nonnegative() });
const SavePreferenceBody = PreferenceProfileSchema.omit({ updatedAt: true }).extend({
  expectedRevision: z.number().int().nonnegative(),
});

const conflict = (reply: FastifyReply, error: RevisionConflictError, subject: '偏好' | '推荐') => reply.code(409).send({
  error: 'revision_conflict', expected: error.expected, actual: error.actual,
  message: `数据已更新；${subject}没有${subject === '偏好' ? '保存' : '刷新'}。当前输入仍保留，请刷新本地数据后重试。`,
});

function latestSnapshot(data: Awaited<ReturnType<JsonRepository['read']>>) {
  for (let index = data.recommendationSnapshots.length - 1; index >= 0; index -= 1) {
    const parsed = RecommendationSnapshotSchema.safeParse(data.recommendationSnapshots[index]);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function registerRecommendationRoutes(app: FastifyInstance, repository: JsonRepository): void {
  app.get('/api/recommendations', async () => {
    const data = await repository.read();
    const snapshot = latestSnapshot(data);
    const stale = snapshot === null
      || snapshot.staleAt !== null
      || snapshot.dataRevision !== data.dataRevision
      || snapshot.ruleVersion !== RECOMMENDATION_RULE_VERSION;
    return { dataRevision: data.dataRevision, preferenceProfile: data.preferenceProfile, snapshot, stale };
  });

  app.put('/api/recommendations/preferences', async (request, reply) => {
    const parsed = SavePreferenceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'invalid_preference_profile',
        message: '偏好没有保存。请检查冲煮方式、风味文字和每 100g 预算后重试。',
        details: parsed.error.issues,
      });
    }
    try {
      const now = new Date().toISOString();
      const data = await repository.mutate(parsed.data.expectedRevision, (draft, nextRevision) => {
        draft.preferenceProfile = {
          brewMode: parsed.data.brewMode,
          acidityPreference: parsed.data.acidityPreference,
          roastLevels: parsed.data.roastLevels,
          flavorNotes: parsed.data.flavorNotes,
          avoidedFlavorNotes: parsed.data.avoidedFlavorNotes,
          maxPricePer100g: parsed.data.maxPricePer100g,
          updatedAt: now,
        };
        expireRecommendations(draft, now, nextRevision);
      });
      return { dataRevision: data.dataRevision, preferenceProfile: data.preferenceProfile };
    } catch (error) {
      if (error instanceof RevisionConflictError) return conflict(reply, error, '偏好');
      throw error;
    }
  });

  app.post('/api/recommendations/refresh', async (request, reply) => {
    const parsed = RevisionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_revision', message: '推荐没有刷新。请先刷新本地数据后重试。' });
    }
    try {
      let snapshot: ReturnType<typeof generateRecommendationSnapshot> | null = null;
      const data = await repository.mutate(parsed.data.expectedRevision, (draft, nextRevision) => {
        const generatedAt = new Date().toISOString();
        snapshot = generateRecommendationSnapshot(draft, {
          id: randomUUID(),
          generatedAt,
          dataRevision: nextRevision,
        });
        draft.recommendationSnapshots = [snapshot];
      });
      return { dataRevision: data.dataRevision, snapshot: snapshot! };
    } catch (error) {
      if (error instanceof RevisionConflictError) return conflict(reply, error, '推荐');
      throw error;
    }
  });
}
