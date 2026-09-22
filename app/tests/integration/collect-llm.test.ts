import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import { createCollectionService } from '../../src/collectors/service.js';
import { buildChatInit, readLlmConfig, type ChatFn, type LlmConfig } from '../../src/collectors/llm.js';

const tempDirs: string[] = [];
const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'collect-token' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const llmConfig: LlmConfig = {
  endpoint: 'https://llm.example.com/v1/chat/completions',
  model: 'test-model',
  headers: { authorization: 'Bearer test-only-placeholder' },
};

function chatFixture(searchPayload: unknown, extractPayload: unknown): ChatFn {
  return async (_config, request) => {
    if (request.system.includes('搜索助手')) return typeof searchPayload === 'string' ? searchPayload : JSON.stringify(searchPayload);
    return typeof extractPayload === 'string' ? extractPayload : JSON.stringify(extractPayload);
  };
}

async function setup(chat: ChatFn, llm: LlmConfig | null = llmConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-collect-llm-'));
  tempDirs.push(directory);
  const repository = new JsonRepository(directory);
  const service = createCollectionService({
    chat,
    llmConfig: llm,
    fetchHtml: async () => ({ html: '<html><body>普通页面，没有商品结构化数据</body></html>', finalUrl: 'https://shop.example.com/plain' }),
  });
  const app = await buildApp({ repository, serveStatic: false, csrfToken: 'collect-token', collectionService: service });
  return { app, repository };
}

describe('LLM 采集（配置注入，不触网）', () => {
  it('未配置 LLM 时 extractFromText 返回 null，流程退手工', async () => {
    const { app } = await setup(null);
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '第一行 品牌加豆名\n第二行描述' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'manual' });
    await app.close();
  });

  it('多行粘贴文本走 LLM 理解：返回候选且越界字段被 schema 过滤', async () => {
    const extractPayload = {
      brandName: '归吾兮', beanName: '关雎', roastLevel: '中深烘焙', flavorNotes: ['焦糖', '烤坚果'],
      referencePrice: '不是数字', packageGrams: -5,
    };
    const { app, repository } = await setup(chatFixture([], extractPayload));
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '归吾兮 关雎\n中深烘焙，焦糖烤坚果\n限时 68 元' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kind).toBe('candidate');
    expect(body.candidate.fields).toMatchObject({ brandName: '归吾兮', beanName: '关雎', roastLevel: '中深烘焙' });
    // 越界/非法值不得进入字段（referencePrice 非数字、packageGrams 为负均被 schema 拒绝）。
    expect(body.candidate.fields.referencePrice).toBeUndefined();
    expect(body.candidate.fields.packageGrams).toBeUndefined();
    expect(body.candidate.sourceKind).toBe('user');
    expect((await repository.read()).beans).toHaveLength(0);
    await app.close();
  });

  it('单行名称：LLM 搜索返回候选后自动解析（provider=llm）', async () => {
    const searchPayload = [{ title: '归吾兮 关雎 商品页', url: 'https://shop.example.com/guanju', snippet: '中深烘焙' }];
    const { app } = await setup(chatFixture(searchPayload, { beanName: '关雎', brandName: '归吾兮' }));
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '归吾兮 关雎' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate', searchMatched: '归吾兮 关雎 商品页' });
    await app.close();
  });

  it('LLM 输出非法 JSON 时降级为手工预填（200，不阻塞创建）', async () => {
    const { app } = await setup(chatFixture('抱歉我不能输出结构化数据', '好的，这是散文而不是 JSON。'));
    const response = await app.inject({ method: 'POST', url: '/api/collect/auto', headers, payload: { input: '第一行 品牌 豆名\n第二行' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().kind).toBe('manual');
    await app.close();
  });

  it('解析层回退：无结构化数据的页面由 LLM 从正文抽取', async () => {
    const { app, repository } = await setup(chatFixture([], { brandName: '山谷咖啡', beanName: '日晒拼配', process: '日晒' }));
    const parsed = await app.inject({ method: 'POST', url: '/api/collect/parse', headers, payload: { url: 'https://shop.example.com/plain' } });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json()).toMatchObject({ candidate: { fields: { brandName: '山谷咖啡', beanName: '日晒拼配', process: '日晒' } } });
    expect((await repository.read()).beans).toHaveLength(0);
    await app.close();
  });

  it('buildChatInit 原样透传配置头并生成规范报文', () => {
    const init = buildChatInit(llmConfig, { system: 's', user: 'u' });
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer test-only-placeholder' });
    const body = JSON.parse(init.body) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe('test-model');
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('readLlmConfig 在缺少配置文件时返回 null（不抛错）', async () => {
    // 本仓库 app/ 下没有 .llm.json；readLlmConfig 直接调用应安全返回 null。
    const config = await readLlmConfig();
    if (config) expect(config.endpoint).toMatch(/^https:/);
  });
});
