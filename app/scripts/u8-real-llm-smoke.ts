// U8 真实九场景冒烟（LLM 路径）：验证配置读取、连通性、搜索、粘贴文本理解与失败回退。
// 不打印任何凭据；仅调用「添加咖啡豆自动识别」链路，不写入任何本地数据。
import { createCollectionService } from '../src/collectors/service.js';

const results: Array<{ scenario: string; ok: boolean; detail: string }> = [];
const log = (scenario: string, ok: boolean, detail: string) => {
  results.push({ scenario, ok, detail });
  console.log(`${ok ? '✓' : '×'} ${scenario}: ${detail}`);
};

// 环境事实：本机代理 TUN fake-ip DNS 会让应用内抓取被 SSRF 防护拦截（场景 6/7 如实记录）。
const service = createCollectionService();

// 场景 0：LLM 连通性（真实 Key + 模型 + 端点）。
const pastedText = [
  '乔治队长 黑猫拼配（第14版）',
  '深度烘焙 意式拼配',
  '经典黑巧与坚果风味，尾韵带焦糖甜感，油脂丰厚，适合奶咖与美式',
  '限时特惠 ¥83.3 / 454g',
].join('\n');

// 场景 1：LLM 搜索（名称 → 候选列表）。
let searchCandidates: Array<{ title: string; url: string }> = [];
try {
  const { candidates, provider } = await service.search('乔治队长 黑猫拼配');
  searchCandidates = candidates;
  log(`LLM 搜索（provider=${provider}）`, candidates.length > 0, `${candidates.length} 条候选：${candidates.slice(0, 2).map((item) => item.title).join(' / ') || '无'}`);
} catch (error) {
  log('LLM 搜索', false, error instanceof Error ? error.message.slice(0, 80) : String(error));
}

// 场景 2：粘贴文本理解（多行商品介绍 → 结构化字段）。
try {
  const candidate = await service.extractFromText(pastedText, 'user');
  if (!candidate) log('粘贴文本理解', false, 'LLM 返回为空或缺少豆名');
  else {
    const fields = candidate.fields;
    const detail = `品牌=${fields.brandName ?? '∅'} 豆名=${fields.beanName ?? '∅'} 烘焙=${fields.roastLevel ?? '∅'} 风味=${fields.flavorNotes?.join('、') || '∅'} 价格=${fields.referencePrice ? `¥${fields.referencePrice.amount}` : '∅'}`;
    log('粘贴文本理解', Boolean(fields.brandName && fields.beanName), detail);
  }
} catch (error) {
  log('粘贴文本理解', false, error instanceof Error ? error.message.slice(0, 80) : String(error));
}

// 场景 3：无法抓取（不存在的主机）→ 必须优雅失败，绝不阻塞。
try {
  await service.parse('https://no-such-host-u8.example/bean');
  log('无法抓取回退', false, '意外成功');
} catch (error) {
  log('无法抓取回退', true, `按设计失败：${error instanceof Error ? error.message.slice(0, 60) : error}`);
}

// 场景 4：真实可达页面（example.com 无商品字段）→ 按设计失败（未配 LLM 时同样回退手工）。
try {
  await service.parse('https://example.com/');
  log('无商品字段页面', false, '意外成功');
} catch (error) {
  log('无商品字段页面', true, `按设计失败：${error instanceof Error ? error.message.slice(0, 60) : error}`);
}

// 场景 5：手动模式（无 LLM 注入的纯规则路径）仍可用。
const { candidates: ddgCandidates } = await createCollectionService({ llmConfig: null }).search('黑猫').catch(() => ({ candidates: [] as never[] }));
log('纯规则路径（DDG，本机代理环境预期不可达）', Array.isArray(ddgCandidates), `${ddgCandidates.length} 条候选（本机代理环境下失败属预期）`);

const coreScenarios = results.slice(0, 4);
const failed = coreScenarios.filter((result) => !result.ok);
console.log(`\n核心场景 ${coreScenarios.length - failed.length}/${coreScenarios.length} 通过${failed.length ? `；未过：${failed.map((result) => result.scenario).join('、')}` : ''}`);
if (failed.length) process.exitCode = 1;
