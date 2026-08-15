import type { ExportReport } from './report-model.js';
const inline = (value: string) => value.replace(/([\\`*_{}[\]()#+.!|-])/g, '\\$1').replace(/[\r\n]+/g, ' ');
export function renderMarkdown(report: ExportReport): string {
  const { snapshot } = report;
  const filters = Object.entries(snapshot.filters).filter(([, value]) => value).map(([key, value]) => `${inline(key)}：${inline(value)}`).join('；') || '无';
  return [`# 豆迹咖啡豆评价报告`, '', `- 生成时间：${snapshot.generatedAt}`, `- 数据版本：${snapshot.dataRevision}`, `- 快照标识：${snapshot.id}`, `- 筛选条件：${filters}`, `- 排序：${snapshot.sort.field}（${snapshot.sort.direction === 'asc' ? '升序' : '降序'}）`, '', ...report.beans.flatMap((bean, index) => [`## ${index + 1}. ${inline(bean.brand)} · ${inline(bean.name)}`, '', `- 烘焙度：${inline(bean.roast)}`, `- 处理法：${inline(bean.process)}`, `- 风味：${bean.flavorNotes.map(inline).join('、') || '未知'}`, `- 参考价：${inline(bean.price)}`, `- 美式评价：${inline(bean.americano)}`, `- 奶咖评价：${inline(bean.milk)}`, `- 综合结论：${inline(bean.assessment)}`, `- 来源：${bean.sources.map((url) => /^https?:\/\//.test(url) ? `<${url}>` : '未知').join('、') || '未知'}`, ''])].join('\n');
}
