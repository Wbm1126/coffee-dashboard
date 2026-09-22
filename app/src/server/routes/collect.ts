import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createCollectionService, type CollectionService } from '../../collectors/service.js';
import { buildCollectionMergePreview } from '../../collectors/merge-preview.js';
import { ProductMetadataError } from '../../collectors/parse/metadata.js';
import { SafeUrlFetchError, validateExternalUrl, validateSourceUrl } from '../../collectors/url-policy.js';
import { COLLECTION_FIELD_KEYS, CollectionCandidateSchema, CollectionFieldsSchema } from '../../collectors/types.js';
import { beanIdentityKey } from '../../domain/bean-identity.js';
import { findOrCreateActiveBrand } from '../../domain/brand.js';
import { finishFactMutation } from '../../domain/commands.js';
import { IdSchema, type CoffeeData } from '../../domain/schema.js';
import { sha256 } from '../../lib/sha256.js';
import { RevisionConflictError, type JsonRepository } from '../../storage/json-repository.js';

const SearchBodySchema = z.object({ query: z.string().trim().min(2).max(160) });
const ParseBodySchema = z.object({ url: z.string().trim().min(1).max(2_000) });
const ConfirmBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operationKey: IdSchema.optional(),
  action: z.enum(['create', 'merge', 'cancel']),
  beanId: IdSchema.nullable().optional(),
  candidate: CollectionCandidateSchema,
  acceptedFields: CollectionFieldsSchema,
}).superRefine((value, context) => {
  if (value.action === 'merge' && !value.beanId) context.addIssue({ code: 'custom', path: ['beanId'], message: '合并时必须选择已有咖啡豆。' });
  if (value.action !== 'cancel' && !value.operationKey) context.addIssue({ code: 'custom', path: ['operationKey'], message: '确认保存需要稳定的操作标识。' });
  if (value.action === 'create' && (!value.acceptedFields.brandName || !value.acceptedFields.beanName)) {
    context.addIssue({ code: 'custom', path: ['acceptedFields'], message: '新建咖啡豆至少需要品牌和豆名。' });
  }
});

function sourceProvenance(sourceKind: 'official' | 'search' | 'user', sourceId: string, capturedAt: string, value: unknown) {
  return { sourceKind, sourceId, capturedAt, rawValue: value, displayedText: Array.isArray(value) ? value.join('、') : typeof value === 'object' && value ? JSON.stringify(value) : String(value) };
}

function blankImportedFacts() {
  return {
    overallScoreRaw: null, preferenceMatchRaw: null, recommendationRaw: null, referencePrice: null, pricePerGram: null,
    packageGrams: null, originOrVariety: null, officialFlavorDescription: null, americanoPerformance: null, milkPerformance: null,
    suitableScenes: [], legacyNote: null, legacyScoreBasisRaw: null,
  };
}

function appendUserProvenance(data: CoffeeData, beanId: string, key: string, sourceId: string, now: string, value: unknown) {
  const bean = data.beans.find((item) => item.id === beanId)!;
  bean.provenance[key] = [...(bean.provenance[key] ?? []), sourceProvenance('user', sourceId, now, value)];
}

function applyAcceptedFields(data: CoffeeData, beanId: string, fields: z.infer<typeof CollectionFieldsSchema>, sourceId: string, now: string) {
  const bean = data.beans.find((item) => item.id === beanId)!;
  if (fields.brandName) {
    const brand = findOrCreateActiveBrand(data, fields.brandName, now);
    bean.brandId = brand.id;
  }
  if (fields.beanName) bean.name = fields.beanName;
  if (fields.roastLevel !== undefined) bean.roastLevel = fields.roastLevel;
  if (fields.process !== undefined) bean.process = fields.process;
  if (fields.flavorNotes !== undefined) bean.flavorNotes = fields.flavorNotes;
  if (fields.originOrVariety !== undefined || fields.officialFlavorDescription !== undefined || fields.referencePrice !== undefined || fields.packageGrams !== undefined) {
    bean.importedFacts ??= blankImportedFacts();
    if (fields.originOrVariety !== undefined) bean.importedFacts.originOrVariety = fields.originOrVariety;
    if (fields.officialFlavorDescription !== undefined) bean.importedFacts.officialFlavorDescription = fields.officialFlavorDescription;
    if (fields.referencePrice !== undefined) bean.importedFacts.referencePrice = fields.referencePrice;
    if (fields.packageGrams !== undefined) bean.importedFacts.packageGrams = fields.packageGrams;
  }
  const brand = data.brands.find((item) => item.id === bean.brandId);
  if (brand) bean.normalizedKey = beanIdentityKey(brand.name, bean.name);
  for (const key of COLLECTION_FIELD_KEYS) if (fields[key] !== undefined) appendUserProvenance(data, bean.id, key, sourceId, now, fields[key]);
  bean.followedAt ??= now;
  bean.updatedAt = now;
}

function sourceFields(candidate: z.infer<typeof CollectionCandidateSchema>) {
  if (!candidate.sourceUrl) return {};
  return Object.fromEntries(Object.entries(candidate.fields).map(([key, value]) => [key, sourceProvenance(candidate.sourceKind, candidate.sourceUrl!, candidate.capturedAt, value)]));
}

type ConfirmInput = z.infer<typeof ConfirmBodySchema> & { action: 'create' | 'merge'; operationKey: string };

function confirmationRequestHash(input: ConfirmInput): string {
  return sha256(Buffer.from(JSON.stringify({
    action: input.action,
    beanId: input.beanId ?? null,
    candidate: input.candidate,
    acceptedFields: input.acceptedFields,
  }), 'utf8'));
}

function findCompletedOperation(data: CoffeeData, operationKey: string) {
  return data.collectionOperations?.find((operation) => operation.key === operationKey);
}

function replayCompletedOperation(reply: FastifyReply, input: ConfirmInput, requestHash: string, data: CoffeeData) {
  const completed = findCompletedOperation(data, input.operationKey);
  if (!completed) return null;
  if (completed.requestHash !== requestHash || completed.action !== input.action) {
    return reply.code(409).send({ error: 'operation_key_reused', message: '这次确认的操作标识已用于不同内容；数据未写入，请重新开始本次确认。' });
  }
  return reply.code(completed.action === 'create' ? 201 : 200).send({
    dataRevision: completed.dataRevision,
    beanId: completed.beanId,
    action: completed.action,
    replayed: true,
  });
}

function collectionError(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof SafeUrlFetchError) {
    const status = error.code === 'http_status' && error.statusCode === 429 ? 429 : 422;
    return reply.code(status).send({ error: error.code, message: `${error.message} 原始链接和输入内容已保留，可改为手工填写。` });
  }
  if (error instanceof ProductMetadataError) return reply.code(422).send({ error: error.code, message: `${error.message} 原始链接和输入内容已保留，可改为手工填写。` });
  return reply.code(502).send({ error: 'collector_unavailable', message: `${fallback} 请稍后重试，或直接手工填写。` });
}

export function registerCollectionRoutes(app: FastifyInstance, repository: JsonRepository, service: CollectionService = createCollectionService()): void {
  app.post('/api/collect/search', async (request, reply) => {
    const parsed = SearchBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_query', message: '请输入至少两个字符的品牌或豆名。' });
    try {
      const { candidates, provider } = await service.search(parsed.data.query);
      return reply.send({ query: parsed.data.query, candidates, provider: provider === 'llm' ? 'LLM 搜索' : 'DuckDuckGo HTML' });
    } catch (error) {
      return collectionError(reply, error, '搜索暂时不可用。');
    }
  });

  app.post('/api/collect/parse', async (request, reply) => {
    const parsed = ParseBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_url', message: '请输入有效的商品链接。' });
    try {
      const safeUrl = validateExternalUrl(parsed.data.url);
      const candidate = await service.parse(safeUrl.toString());
      return reply.send({ candidate, preview: buildCollectionMergePreview(await repository.read(), candidate) });
    } catch (error) {
      return collectionError(reply, error, '商品页面暂时无法解析。');
    }
  });

  // U3 统一入口：单输入框（链接 / 品牌+豆名 / 粘贴文本）由服务端自动编排搜索与解析。
  // 自动化失败永远返回 200 + kind:'manual'（带身份预填），绝不阻塞用户手工创建。
  const AutoBodySchema = z.object({ input: z.string().trim().min(1).max(4_000) });

  const nonEmptyLines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  function extractIdentityHint(input: string): { brandName?: string; beanName?: string; officialFlavorDescription?: string } {
    // 预填值必须落在 CollectionFieldsSchema 的约束内（品牌 160 / 豆名 240），避免保存时被校验打回。
    const first = nonEmptyLines(input)[0] ?? '';
    const parts = first.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return { brandName: parts[0]!.slice(0, 160), beanName: parts.slice(1).join(' ').slice(0, 240) };
    if (parts.length === 1) return { beanName: parts[0]!.slice(0, 240) };
    return {};
  }

  app.post('/api/collect/auto', async (request, reply) => {
    const parsed = AutoBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_input', message: '请输入商品链接、品牌加豆名，或一段商品介绍。' });
    const input = parsed.data.input;
    const data = await repository.read();
    const manual = (reason: string, fields: Record<string, string> = {}) => reply.send({ kind: 'manual', fields, reason });

    if (/^https?:\/\//i.test(input)) {
      try {
        const candidate = await service.parse(input);
        return reply.send({ kind: 'candidate', candidate, preview: buildCollectionMergePreview(data, candidate) });
      } catch (error) {
        // URL 不参与身份预填（否则链接会被塞进豆名）；失败同样降级为手工，不阻塞创建。
        if (error instanceof SafeUrlFetchError || error instanceof ProductMetadataError) {
          return manual(`${error.message} 请核对品牌和豆名后手工保存。`);
        }
        return manual('链接暂时无法解析；请核对品牌和豆名后手工保存。');
      }
    }

    // 多行输入视为粘贴文本：U4 起由 LLM 直接理解整段文本（未配置 LLM 时退手工预填）。
    const lines = nonEmptyLines(input);
    if (lines.length >= 2) {
      try {
        const candidate = await service.extractFromText(input, 'user');
        if (candidate) {
          return reply.send({ kind: 'candidate', candidate, preview: buildCollectionMergePreview(data, candidate), searchMatched: 'LLM 文本理解' });
        }
      } catch (error) {
        request.log.warn({ err: error }, 'collect/auto text extraction failed');
      }
      return manual('未配置 LLM 或理解失败；已按第一行预填品牌和豆名，完整文本已粘进官方描述，请核对后保存。', { ...extractIdentityHint(input), officialFlavorDescription: input });
    }

    const query = lines[0] ?? input;
    const queryCheck = SearchBodySchema.safeParse({ query });
    if (!queryCheck.success) return manual('输入不适合作为搜索关键词；已按输入预填，请核对后保存。', extractIdentityHint(input));
    try {
      const { candidates } = await service.search(queryCheck.data.query);
      if (candidates.length === 0) return manual('没有搜索到可用候选；已按输入预填，请核对后保存。', extractIdentityHint(input));
      const candidate = await service.parse(candidates[0]!.url);
      return reply.send({ kind: 'candidate', candidate, preview: buildCollectionMergePreview(data, candidate), searchMatched: candidates[0]!.title });
    } catch (error) {
      request.log.warn({ err: error }, 'collect/auto search failed');
      if (error instanceof SafeUrlFetchError || error instanceof ProductMetadataError) {
        return manual(`${error.message} 已按输入预填，请核对后保存。`, extractIdentityHint(input));
      }
      return manual('搜索服务暂时不可用；已按输入预填，请核对后保存。', extractIdentityHint(input));
    }
  });

  app.post('/api/collect/confirm', async (request, reply) => {
    const parsed = ConfirmBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_collection_confirmation', message: '确认内容无效，数据未写入。', details: parsed.error.issues });
    if (parsed.data.action === 'cancel') return reply.send({ cancelled: true });
    const input = parsed.data as ConfirmInput;
    const requestHash = confirmationRequestHash(input);
    try {
      if (input.candidate.sourceUrl) {
        if (input.candidate.sourceKind === 'user') validateSourceUrl(input.candidate.sourceUrl);
        else validateExternalUrl(input.candidate.sourceUrl);
      }
      const replay = replayCompletedOperation(reply, input, requestHash, await repository.read());
      if (replay) return replay;
      let savedBeanId: string | null = null;
      const data = await repository.mutate(input.expectedRevision, (draft, nextRevision) => {
        const now = new Date().toISOString();
        let bean = input.action === 'merge'
          ? draft.beans.find((item) => item.id === input.beanId && !item.archivedAt)
          : undefined;
        if (input.action === 'merge' && !bean) throw new Error('bean_not_found');
        if (!bean) {
          const brand = findOrCreateActiveBrand(draft, input.acceptedFields.brandName!, now);
          bean = {
            id: randomUUID(), brandId: brand.id, name: input.acceptedFields.beanName!, normalizedKey: beanIdentityKey(brand.name, input.acceptedFields.beanName!),
            roastLevel: null, process: null, flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null,
            provenance: {}, createdAt: now, updatedAt: now,
          };
          draft.beans.push(bean);
        }
        const sourceId = input.candidate.sourceUrl ? `collection:${input.candidate.sourceUrl}` : 'collection:manual';
        applyAcceptedFields(draft, bean.id, input.acceptedFields, sourceId, now);
        if (input.candidate.sourceUrl) {
          draft.productSources.push({ id: randomUUID(), beanId: bean.id, url: input.candidate.sourceUrl, title: input.candidate.title, imageUrl: null, localImagePath: null, imageSource: null, capturedAt: input.candidate.capturedAt, fields: sourceFields(input.candidate) });
        }
        savedBeanId = bean.id;
        draft.collectionOperations ??= [];
        draft.collectionOperations.push({ key: input.operationKey, requestHash, action: input.action, beanId: bean.id, dataRevision: nextRevision, completedAt: now });
        finishFactMutation(draft, now, nextRevision);
      });
      return reply.code(input.action === 'create' ? 201 : 200).send({ dataRevision: data.dataRevision, beanId: savedBeanId, action: input.action, replayed: false });
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        const replay = replayCompletedOperation(reply, input, requestHash, await repository.read());
        if (replay) return replay;
        return reply.code(409).send({ error: 'revision_conflict', expected: error.expected, actual: error.actual, message: '本地数据已经更新；采集结果尚未保存。请刷新后检查并重试。' });
      }
      if (error instanceof Error && error.message === 'bean_not_found') return reply.code(404).send({ error: 'bean_not_found', message: '要合并的咖啡豆已不存在或已归档；采集结果尚未保存。' });
      if (error instanceof SafeUrlFetchError) return collectionError(reply, error, '商品链接未通过安全校验。');
      throw error;
    }
  });
}
