// OpenAI 兼容 Chat Completions 最小客户端（国内可达的智谱 GLM 等均适用）。
// 认证完全由 git 忽略的本地配置文件 app/.llm.json 提供（含完整请求头），
// 代码不接触、不构造任何密钥字符串；未配置时返回 null，采集流程自动降级为规则解析/手工路径。
// 配置示例见 app/.llm.example.json（占位符，无可用凭据）。

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extractJsonBlock } from '../lib/json-extract.js';
import { COLLECTION_FIELD_KEYS, CollectionFieldsSchema, SearchCandidateSchema, type CollectionCandidate, type SearchCandidate } from './types.js';

// 调参常量集中在此，避免提示词与代码双份维护。
const MAX_LLM_CANDIDATES = 5;
const LLM_TEMPERATURE = 0.2;
const SEARCH_TIMEOUT_MS = 45_000;
const EXTRACT_TIMEOUT_MS = 45_000;
/** 默认 chat 网络预算：供 service.ts 的默认 ChatFn 使用。 */
export const CHAT_TIMEOUT_MS = 30_000;

export class LlmError extends Error {
  constructor(public readonly code: 'not_configured' | 'http_status' | 'bad_response' | 'timeout', message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmConfig {
  /** 完整的 chat/completions 端点，例如智谱：https://open.bigmodel.cn/api/paas/v4/chat/completions */
  endpoint: string;
  model: string;
  /** 完整请求头（含认证）。由本地配置文件提供，代码原样透传，不做任何加工。 */
  headers: Record<string, string>;
}

// 修复 OCR critical：本文件位于 src/collectors/，向上两级才是 app/（dist 运行时同理）。
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function readLlmConfig(): Promise<LlmConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(appDir, '.llm.json'), 'utf8')) as Record<string, unknown>;
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
    if (!/^https:\/\//i.test(endpoint)) return null;
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : 'glm-4-flash';
    const headers = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
      ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>)
        .filter(([key, value]) => typeof key === 'string' && key.length > 0 && typeof value === 'string')
        .map(([key, value]) => [key, value as string]))
      : {};
    if (Object.keys(headers).length === 0) return null;
    return { endpoint, model, headers };
  } catch {
    return null;
  }
}

export interface ChatRequest {
  system: string;
  user: string;
  timeoutMs?: number;
}

export type ChatFn = (config: LlmConfig, request: ChatRequest) => Promise<string>;

interface ChatRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

const SEARCH_PROMPT = (query: string) => `你是咖啡豆商品搜索助手。只输出 JSON 数组，不要输出任何解释文字。数组元素形如 {"title":"商品标题","url":"商品页链接","snippet":"一句话摘要"}，最多 ${MAX_LLM_CANDIDATES} 条，url 必须是 http(s) 完整链接。搜索关键词：${query}`;

// LLM 输出用宽松校验：剥离多余字段而不是整条丢弃（SearchCandidateSchema 是 strict，模型常附加 source 等字段）。
const LlmSearchItemSchema = z.object(SearchCandidateSchema.shape);

export async function searchWithLlm(chat: ChatFn, config: LlmConfig, query: string): Promise<SearchCandidate[]> {
  const content = await chat(config, { system: SEARCH_PROMPT(query), user: '请开始搜索。', timeoutMs: SEARCH_TIMEOUT_MS });
  const parsed = extractJsonBlock(content);
  if (!Array.isArray(parsed)) throw new LlmError('bad_response', 'LLM 搜索结果不是数组。');
  const candidates: SearchCandidate[] = [];
  for (const item of parsed) {
    const checked = LlmSearchItemSchema.safeParse(item);
    if (!checked.success) continue;
    if (!/^https?:\/\//i.test(checked.data.url)) continue;
    candidates.push(checked.data);
    if (candidates.length >= MAX_LLM_CANDIDATES) break;
  }
  // 合法条目为 0 视为 bad_response：让上层自动降级 DuckDuckGo，而不是静默返回空数组。
  if (candidates.length === 0) throw new LlmError('bad_response', 'LLM 搜索没有返回可用候选。');
  return candidates;
}

const EXTRACT_SYSTEM = '你是咖啡豆商品信息抽取助手。从给定文本中提取咖啡豆字段，只输出一个 JSON 对象：{"brandName":"品牌","beanName":"豆名","roastLevel":"烘焙度","process":"处理法","flavorNotes":["风味1","风味2"],"originOrVariety":"产地或豆种","officialFlavorDescription":"官方风味描述原文","referencePrice":{"amount":数字,"currency":"CNY"},"packageGrams":数字}。文本中没有的字段一律省略；不得编造、不得推测。只输出 JSON。';

export interface LlmExtractionInput {
  text: string;
  /** 文本来源：商品页面原文用 search，用户粘贴内容用 user（决定 provenance 的 sourceKind）。 */
  sourceKind: 'search' | 'user';
  capturedAt: string;
  sourceUrl?: string;
}

export async function extractFieldsWithLlm(chat: ChatFn, config: LlmConfig, input: LlmExtractionInput): Promise<CollectionCandidate | null> {
  const content = await chat(config, { system: EXTRACT_SYSTEM, user: input.text, timeoutMs: EXTRACT_TIMEOUT_MS });
  const parsed = extractJsonBlock(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // 逐字段校验：LLM 单个字段越界只丢弃该字段，不牵连其余有效内容。
  const cleaned: Record<string, unknown> = {};
  const partialSchema = CollectionFieldsSchema.partial();
  for (const key of COLLECTION_FIELD_KEYS) {
    if (!(key in record)) continue;
    const single = partialSchema.safeParse({ [key]: record[key] });
    if (single.success) Object.assign(cleaned, single.data);
  }
  const checked = CollectionFieldsSchema.safeParse(cleaned);
  if (!checked.success || !checked.data.beanName) return null;
  const fields = checked.data;
  return {
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    title: `${fields.brandName ? `${fields.brandName} · ` : ''}${fields.beanName}`,
    capturedAt: input.capturedAt,
    sourceKind: input.sourceKind,
    fields,
  };
}

// 纯函数：构造请求头与报文（不含任何网络逻辑，便于单测）。认证头原样来自本地配置。
export function buildChatInit(config: LlmConfig, request: ChatRequest): ChatRequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: LLM_TEMPERATURE,
    }),
  };
}

// 默认 ChatFn：解析响应 JSON，取出首个回复文本。网络细节由调用方的 fetch 完成。
export async function chatFromResponse(response: Response): Promise<string> {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as { error?: { message?: string }; message?: string };
      detail = body.error?.message ?? body.message ?? '';
    } catch { /* 保留空详情 */ }
    throw new LlmError('http_status', `LLM 返回 ${response.status}：${detail || '无详细信息'}`);
  }
  const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LlmError('bad_response', 'LLM 返回了空内容或非 JSON 内容。');
  }
  return content;
}
