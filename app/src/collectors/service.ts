import { parseProductMetadata, ProductMetadataError } from './parse/metadata.js';
import { parseDuckDuckGoResults } from './search/duckduckgo.js';
import { createSafeUrlFetcher, type SafeHtmlResult } from './url-policy.js';
import { CHAT_TIMEOUT_MS, LlmError, buildChatInit, chatFromResponse, extractFieldsWithLlm, readLlmConfig, searchWithLlm, type ChatFn, type LlmConfig } from './llm.js';
import type { CollectionCandidate, SearchCandidate } from './types.js';

export interface CollectionService {
  /** 搜索候选：配置了 LLM 时走 LLM 搜索，否则回退 DuckDuckGo。 */
  search(query: string): Promise<{ candidates: SearchCandidate[]; provider: 'llm' | 'duckduckgo' }>;
  parse(url: string): Promise<CollectionCandidate>;
  /** U4 第三层：对粘贴文本/解析失败页面做 LLM 字段抽取；未配置或失败返回 null（不阻塞手工路径）。 */
  extractFromText(text: string, sourceKind: 'search' | 'user'): Promise<CollectionCandidate | null>;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12_000);
}

export function createCollectionService(options: {
  fetchHtml?: (url: string) => Promise<SafeHtmlResult>;
  chat?: ChatFn;
  llmConfig?: LlmConfig | null;
} = {}): CollectionService {
  const fetchHtml = options.fetchHtml ?? createSafeUrlFetcher().fetchHtml;
  const chat = options.chat;
  // LLM 配置惰性解析一次：来自 git 忽略的 app/.llm.json；没有则完全不用 LLM。
  // 测试环境默认封闭：除非显式注入 llmConfig，否则不读取开发者本机的真实配置。
  let llmConfigPromise: Promise<LlmConfig | null> | undefined;
  const llm = () => {
    if (options.llmConfig !== undefined) return Promise.resolve(options.llmConfig);
    if (process.env.NODE_ENV === 'test') return Promise.resolve(null);
    llmConfigPromise ??= readLlmConfig();
    return llmConfigPromise;
  };
  const chatOrDefault: ChatFn = async (config, request) => {
    if (chat) return chat(config, request);
    const init = buildChatInit(config, request);
    let response: Response;
    try {
      response = await fetch(new URL(config.endpoint), { ...init, signal: AbortSignal.timeout(request.timeoutMs ?? CHAT_TIMEOUT_MS) });
    } catch (error) {
      if ((error as Error | undefined)?.name === 'TimeoutError') {
        throw new LlmError('timeout', 'LLM 请求超时。');
      }
      throw new LlmError('bad_response', 'LLM 请求失败（网络或服务异常）。');
    }
    return chatFromResponse(response);
  };

  return {
    async search(query) {
      const config = await llm();
      if (config) {
        try {
          return { candidates: await searchWithLlm(chatOrDefault, config, query), provider: 'llm' };
        } catch (error) {
          // 降级前留下日志，避免 LLM 配置/网络问题在线上不可诊断。
          console.warn('[collect] LLM 搜索失败，已降级 DuckDuckGo：', error instanceof Error ? error.message : error);
        }
      }
      const endpoint = new URL('https://html.duckduckgo.com/html/');
      endpoint.searchParams.set('q', query);
      const page = await fetchHtml(endpoint.toString());
      return { candidates: parseDuckDuckGoResults(page.html), provider: 'duckduckgo' };
    },
    async parse(url) {
      const page = await fetchHtml(url);
      try {
        return parseProductMetadata({ url: page.finalUrl, html: page.html, capturedAt: new Date().toISOString() });
      } catch (error) {
        // 第一/二层（结构化+规则）没有结果时，第三层 LLM 理解页面正文（配置了才启用）。
        // 第三层自身失败不得覆盖原始解析错误，保持 422 手工降级语义。
        const config = await llm();
        if (error instanceof ProductMetadataError && config) {
          try {
            const candidate = await extractFieldsWithLlm(chatOrDefault, config, {
              text: stripHtmlTags(page.html),
              sourceKind: 'search',
              capturedAt: new Date().toISOString(),
              sourceUrl: page.finalUrl,
            });
            if (candidate) return candidate;
          } catch (llmError) {
            console.warn('[collect] LLM 页面抽取失败，维持原始解析错误：', llmError instanceof Error ? llmError.message : llmError);
          }
        }
        throw error;
      }
    },
    async extractFromText(text, sourceKind) {
      const config = await llm();
      if (!config) return null;
      try {
        return await extractFieldsWithLlm(chatOrDefault, config, { text, sourceKind, capturedAt: new Date().toISOString() });
      } catch (error) {
        // LLM 理解失败不阻塞：返回 null，调用方退手工预填。
        console.warn('[collect] LLM 文本理解失败，已退手工预填：', error instanceof Error ? error.message : error);
        return null;
      }
    },
  };
}
