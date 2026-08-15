import { reviewedScore } from '../domain/review-completeness.js';
import type { CoffeeBean, CoffeeData, PreferenceProfile } from '../domain/schema.js';

export interface BeanRecommendationFeatures {
  bean: CoffeeBean;
  tried: boolean;
  followed: boolean;
  purchased: boolean;
  assessmentRepurchase: 'yes' | 'price_dependent' | 'no' | null;
  americanoScores: number[];
  milkScores: number[];
  personalFlavorNotes: string[];
  candidateFlavorNotes: string[];
  pricePer100g: number | null;
  acidSignal: 'low' | 'high' | null;
  acidEvidence: string | null;
  acidEvidenceKind: 'explicit' | 'roast_inference' | null;
  americanoProductSignal: boolean;
  milkProductSignal: boolean;
  editorialTieBreak: number;
}

export const normalizeRecommendationText = (value: string) => value.trim().toLocaleLowerCase('zh-CN');
const unique = (values: string[]) => [...new Set(values.map(normalizeRecommendationText).filter(Boolean))];

function productText(bean: CoffeeBean): string {
  const facts = bean.importedFacts;
  return [
    ...bean.flavorNotes,
    bean.roastLevel,
    facts?.officialFlavorDescription,
    facts?.americanoPerformance,
    facts?.milkPerformance,
    ...(facts?.suitableScenes ?? []),
  ].filter((value): value is string => Boolean(value)).join(' · ');
}

function acidFeature(bean: CoffeeBean, personalText: string): Pick<BeanRecommendationFeatures, 'acidSignal' | 'acidEvidence' | 'acidEvidenceKind'> {
  const lowTokens = ['低酸', '不酸', '酸度低', '柔和酸'];
  const highTokens = ['高酸', '明亮酸', '果酸', '尖酸', '活泼酸'];
  const personalLow = lowTokens.find((token) => personalText.includes(token));
  if (personalLow) return { acidSignal: 'low', acidEvidence: `个人饮用评价明确写有“${personalLow}”`, acidEvidenceKind: 'explicit' };
  const personalHigh = highTokens.find((token) => personalText.includes(token));
  if (personalHigh) return { acidSignal: 'high', acidEvidence: `个人饮用评价明确写有“${personalHigh}”`, acidEvidenceKind: 'explicit' };
  const text = productText(bean);
  const low = lowTokens.find((token) => text.includes(token));
  if (low) return { acidSignal: 'low', acidEvidence: `商品文字明确写有“${low}”`, acidEvidenceKind: 'explicit' };
  const high = highTokens.find((token) => text.includes(token));
  if (high) return { acidSignal: 'high', acidEvidence: `商品文字明确写有“${high}”`, acidEvidenceKind: 'explicit' };
  const roast = bean.roastLevel ?? '';
  if (/中深|深烘/.test(roast)) return { acidSignal: 'low', acidEvidence: `仅以“${roast}”作为低酸弱信号，并非实测酸感`, acidEvidenceKind: 'roast_inference' };
  if (/浅烘/.test(roast)) return { acidSignal: 'high', acidEvidence: `仅以“${roast}”作为较高酸感弱信号，并非实测酸感`, acidEvidenceKind: 'roast_inference' };
  return { acidSignal: null, acidEvidence: null, acidEvidenceKind: null };
}

function referencePricePer100g(bean: CoffeeBean): number | null {
  const facts = bean.importedFacts;
  if (facts?.pricePerGram != null) return facts.pricePerGram * 100;
  if (facts?.referencePrice && facts.packageGrams) return facts.referencePrice.amount / facts.packageGrams * 100;
  return null;
}

function editorialRank(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.toUpperCase();
  if (/A\+|强烈|首选/.test(normalized)) return 4;
  if (/\bA\b|推荐/.test(normalized)) return 3;
  if (/B\+/.test(normalized)) return 2;
  if (/\bB\b/.test(normalized)) return 1;
  return 0;
}

export function projectRecommendationFeatures(data: CoffeeData): BeanRecommendationFeatures[] {
  const activePurchases = new Set(data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id));
  const purchasedBeans = new Set(data.purchaseItems.filter((item) => activePurchases.has(item.purchaseId)).map((item) => item.beanId));
  const actualPricesByBean = new Map<string, number[]>();
  for (const item of data.purchaseItems) {
    if (!activePurchases.has(item.purchaseId) || !item.paid || !item.packageGrams) continue;
    const prices = actualPricesByBean.get(item.beanId) ?? [];
    prices.push(item.paid.amount / (item.packageGrams * item.quantity) * 100);
    actualPricesByBean.set(item.beanId, prices);
  }
  const recordsByBean = new Map<string, typeof data.drinkingRecords>();
  for (const record of data.drinkingRecords) {
    if (record.deletedAt || record.isDraft) continue;
    const current = recordsByBean.get(record.beanId) ?? [];
    current.push(record);
    recordsByBean.set(record.beanId, current);
  }
  const assessments = new Map(data.assessments.map((assessment) => [assessment.beanId, assessment]));

  return data.beans.map((bean) => {
    const records = recordsByBean.get(bean.id) ?? [];
    const americanoScores: number[] = [];
    const milkScores: number[] = [];
    const personalFlavorNotes: string[] = [];
    const personalText: string[] = [];
    for (const record of records) {
      const americano = reviewedScore(record.americanoReview);
      const milk = reviewedScore(record.milkReview);
      if (americano != null) americanoScores.push(americano);
      if (milk != null) milkScores.push(milk);
      personalFlavorNotes.push(...(record.americanoReview?.flavorNotes ?? []), ...(record.milkReview?.flavorNotes ?? []));
      personalText.push(record.feeling ?? '', record.americanoReview?.note ?? '', record.americanoReview?.pros ?? '',
        record.americanoReview?.cons ?? '', record.milkReview?.note ?? '', record.milkReview?.pros ?? '', record.milkReview?.cons ?? '');
    }
    const facts = bean.importedFacts;
    const text = productText(bean);
    const actualPrices = actualPricesByBean.get(bean.id) ?? [];
    return {
      bean,
      tried: records.length > 0,
      followed: bean.followedAt !== null,
      purchased: purchasedBeans.has(bean.id),
      assessmentRepurchase: assessments.get(bean.id)?.repurchase ?? null,
      americanoScores,
      milkScores,
      personalFlavorNotes: unique(personalFlavorNotes),
      candidateFlavorNotes: unique([...bean.flavorNotes, ...(facts?.officialFlavorDescription?.split(/[、，,;；/]/) ?? [])]),
      pricePer100g: actualPrices.at(-1) ?? referencePricePer100g(bean),
      ...acidFeature(bean, personalText.join(' · ')),
      americanoProductSignal: Boolean(facts?.americanoPerformance || facts?.suitableScenes.some((scene) => /美式|黑咖/.test(scene)) || /美式|黑咖/.test(text)),
      milkProductSignal: Boolean(facts?.milkPerformance || facts?.suitableScenes.some((scene) => /奶咖|拿铁/.test(scene)) || /奶咖|拿铁/.test(text)),
      editorialTieBreak: editorialRank(facts?.recommendationRaw),
    };
  });
}

export function learnedFlavorNotes(features: BeanRecommendationFeatures[]): string[] {
  return unique(features.flatMap((feature) => {
    const scores = [...feature.americanoScores, ...feature.milkScores];
    return scores.some((score) => score >= 4) || feature.assessmentRepurchase === 'yes'
      ? [...feature.bean.flavorNotes, ...feature.personalFlavorNotes]
      : [];
  }));
}

export function normalizedPreferenceNotes(profile: PreferenceProfile, learned: string[]): string[] {
  return unique(profile.flavorNotes.length > 0 ? profile.flavorNotes : learned);
}
