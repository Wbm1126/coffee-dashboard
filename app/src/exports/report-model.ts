import type { CoffeeData } from '../domain/schema.js';
import type { ExportSnapshot } from './snapshot.js';

export interface ExportReport { snapshot: ExportSnapshot; beans: Array<{ id: string; brand: string; name: string; roast: string; process: string; flavorNotes: string[]; price: string; americano: string; milk: string; assessment: string; sources: string[] }> }
const unknown = '未知';
export function buildExportReport(data: CoffeeData, snapshot: ExportSnapshot): ExportReport {
  const brands = new Map(data.brands.map((brand) => [brand.id, brand.name]));
  const beans = new Map(data.beans.map((bean) => [bean.id, bean]));
  const assessments = new Map(data.assessments.map((assessment) => [assessment.beanId, assessment]));
  const drinks = new Map<string, CoffeeData['drinkingRecords']>();
  const sources = new Map<string, string[]>();
  for (const record of data.drinkingRecords) {
    const grouped = drinks.get(record.beanId);
    if (grouped) grouped.push(record);
    else drinks.set(record.beanId, [record]);
  }
  for (const source of data.productSources) {
    const grouped = sources.get(source.beanId);
    if (grouped) grouped.push(source.url);
    else sources.set(source.beanId, [source.url]);
  }
  return { snapshot, beans: snapshot.beanIds.map((id) => {
    const bean = beans.get(id);
    if (!bean) throw new Error('export_snapshot_missing_bean');
    const assessment = assessments.get(id);
    const review = (key: 'americanoReview' | 'milkReview') => (drinks.get(id) ?? []).filter((record) => !record.deletedAt && record[key]?.state === 'reviewed').map((record) => `${record[key]!.score ?? unknown} 分${record[key]!.note ? `：${record[key]!.note}` : ''}`).join('；') || unknown;
    return { id, brand: bean.brandId ? brands.get(bean.brandId) ?? unknown : unknown, name: bean.name, roast: bean.roastLevel ?? unknown, process: bean.process ?? unknown, flavorNotes: bean.flavorNotes, price: bean.importedFacts?.referencePrice ? `${bean.importedFacts.referencePrice.amount} ${bean.importedFacts.referencePrice.currency}` : unknown, americano: review('americanoReview'), milk: review('milkReview'), assessment: assessment ? [assessment.grade, assessment.repurchase, assessment.summary].filter(Boolean).join(' · ') || unknown : unknown, sources: sources.get(id) ?? [] };
  }) };
}
