// U8 真实网络冒烟（子集）：DDG 搜索可达性 + 真实可达页面解析（含无商品字段的失败场景回退验证）。
import { createCollectionService } from '../src/collectors/service.js';

const service = createCollectionService();
const results: Array<{ scenario: string; ok: boolean; detail: string }> = [];

// 场景 1：DDG 关键词搜索（境内网络通常不可达——预期记录真实结果而非假定成功）。
try {
  const candidates = await service.search('乔治队长 黑猫拼配');
  results.push({ scenario: 'DDG 搜索', ok: candidates.length > 0, detail: `${candidates.length} 条候选` });
} catch (error) {
  results.push({ scenario: 'DDG 搜索', ok: false, detail: error instanceof Error ? error.message : String(error) });
}

// 场景 2：真实可达页面（无商品字段）→ 规则层抛 no_product_fields；未配 LLM 时按设计回退手工。
try {
  await service.parse('https://example.com/');
  results.push({ scenario: '无商品字段页面解析', ok: false, detail: '意外成功（example.com 不应产出候选）' });
} catch (error) {
  results.push({ scenario: '无商品字段页面解析', ok: true, detail: `按设计失败：${error instanceof Error ? error.message : error}` });
}

// 场景 3：无法抓取（不存在的公网主机）→ 安全层拒绝。
try {
  await service.parse('https://no-such-host-u8-smoke.example/bean');
  results.push({ scenario: '无法抓取', ok: false, detail: '意外成功' });
} catch (error) {
  results.push({ scenario: '无法抓取', ok: true, detail: `按设计失败：${error instanceof Error ? error.message.slice(0, 60) : error}` });
}

for (const result of results) console.log(`${result.ok ? '✓' : '×'} ${result.scenario}: ${result.detail}`);
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`\n${failed.length} 项未达预期：${failed.map((result) => result.scenario).join('、')}`);
  process.exitCode = 1;
}
