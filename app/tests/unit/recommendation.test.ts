import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData, type CoffeeData } from '../../src/domain/schema.js';
import { generateRecommendationSnapshot } from '../../src/recommendation/engine.js';
import { RECOMMENDATION_RULE_VERSION } from '../../src/recommendation/rules.js';

const NOW = '2026-08-07T12:00:00.000+08:00';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000009999';
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function fixture(): CoffeeData {
  const data = createEmptyCoffeeData(new Date(NOW));
  data.dataRevision = 7;
  data.brands.push({ id: uuid(1), name: '本地烘焙社', aliases: [], archivedAt: null, createdAt: NOW, updatedAt: NOW });
  return data;
}

function addBean(data: CoffeeData, index: number, input: {
  name: string;
  roast?: string | null;
  flavorNotes?: string[];
  followed?: boolean;
  recommendationRaw?: string | null;
  pricePer100g?: number | null;
  americanoPerformance?: string | null;
  milkPerformance?: string | null;
  description?: string | null;
  draft?: boolean;
  archived?: boolean;
}) {
  const packageGrams = input.pricePer100g == null ? null : 100;
  const bean = {
    id: uuid(100 + index), brandId: data.brands[0]!.id, name: input.name,
    normalizedKey: `本地烘焙社\u0000${input.name}`, roastLevel: input.roast ?? null, process: null,
    flavorNotes: input.flavorNotes ?? [], followedAt: input.followed ? NOW : null,
    archivedAt: input.archived ? NOW : null, isDraft: input.draft ?? false,
    legacyStatusRaw: null, legacyPersonalScoreRaw: null,
    importedFacts: {
      overallScoreRaw: null, preferenceMatchRaw: null, recommendationRaw: input.recommendationRaw ?? null,
      referencePrice: input.pricePer100g == null ? null : { amount: input.pricePer100g, currency: 'CNY' },
      pricePerGram: input.pricePer100g == null ? null : input.pricePer100g / 100,
      packageGrams, originOrVariety: null, officialFlavorDescription: input.description ?? null,
      americanoPerformance: input.americanoPerformance ?? null, milkPerformance: input.milkPerformance ?? null,
      suitableScenes: [], legacyNote: null, legacyScoreBasisRaw: null,
    },
    provenance: {}, createdAt: NOW, updatedAt: NOW,
  };
  data.beans.push(bean);
  return bean;
}

function addExperience(data: CoffeeData, beanId: string, index: number, input: {
  americano?: number | null;
  milk?: number | null;
  repurchase?: 'yes' | 'price_dependent' | 'no' | null;
  flavorNotes?: string[];
}) {
  const recordId = uuid(300 + index);
  data.drinkingRecords.push({
    id: recordId, beanId, purchaseItemId: null, drankOn: '2026-08-07', brewMethod: input.milk != null ? 'milk' : 'americano',
    extractionNote: null, feeling: null,
    americanoReview: input.americano == null ? null : { state: 'reviewed', score: input.americano, flavorNotes: input.flavorNotes ?? [], pros: null, cons: null, note: null },
    milkReview: input.milk == null ? null : { state: 'reviewed', score: input.milk, flavorNotes: input.flavorNotes ?? [], pros: null, cons: null, note: null },
    draftAssessment: null, isDraft: false, deletedAt: null, createdAt: NOW, updatedAt: NOW,
  });
  data.assessments.push({ id: uuid(500 + index), beanId, grade: null, repurchase: input.repurchase ?? null,
    summary: null, basedOnDrinkingIds: [recordId], updatedAt: NOW });
}

function generate(data: CoffeeData) {
  return generateRecommendationSnapshot(data, { id: SNAPSHOT_ID, generatedAt: NOW, dataRevision: data.dataRevision });
}

describe('offline recommendation engine', () => {
  it('returns a truthful cold-start empty state for an empty library', () => {
    const snapshot = generate(fixture());
    expect(snapshot).toMatchObject({ id: SNAPSHOT_ID, dataRevision: 7, ruleVersion: RECOMMENDATION_RULE_VERSION,
      worthTrying: [], repurchase: [], staleAt: null, staleBecauseRevision: null });
  });

  it('ranks followed-only candidates deterministically and uses editor rank only for cold-start ties', () => {
    const data = fixture();
    addBean(data, 1, { name: '编辑 B', followed: true, recommendationRaw: 'B' });
    addBean(data, 2, { name: '编辑 A', followed: true, recommendationRaw: 'A' });
    const first = generate(data);
    const second = generate(data);
    expect(first.worthTrying.map((item) => item.beanId)).toEqual([uuid(102), uuid(101)]);
    expect(second.worthTrying).toEqual(first.worthTrying);
    expect(first.worthTrying.every((item) => item.factors.length > 0 && item.factors.length <= 3)).toBe(true);
  });

  it('stops using historical editor rank once local scoring history exists', () => {
    const data = fixture();
    addBean(data, 1, { name: 'A 次选', followed: true, recommendationRaw: 'B' });
    addBean(data, 2, { name: 'B 首选', followed: true, recommendationRaw: 'A+' });
    const history = addBean(data, 3, { name: '已有评价', flavorNotes: ['可可'] });
    addExperience(data, history.id, 3, { americano: 4, repurchase: 'yes' });
    expect(generate(data).worthTrying.map((item) => item.beanId)).toEqual([uuid(101), uuid(102)]);
  });

  it('uses five local scores for repurchase ranking and excludes draft and archived beans', () => {
    const data = fixture();
    [5, 4.5, 4, 3.5, 3].forEach((score, index) => {
      const bean = addBean(data, index + 1, { name: `历史 ${index + 1}`, flavorNotes: ['巧克力'] });
      addExperience(data, bean.id, index + 1, { americano: score, repurchase: score >= 4 ? 'yes' : 'price_dependent' });
    });
    addBean(data, 8, { name: '草稿', draft: true, followed: true });
    addBean(data, 9, { name: '归档', archived: true, followed: true });
    const snapshot = generate(data);
    expect(snapshot.repurchase.map((item) => item.beanId)).toEqual([uuid(101), uuid(102), uuid(103), uuid(104), uuid(105)]);
    expect(snapshot.worthTrying.map((item) => item.beanId)).not.toContain(uuid(108));
    expect(snapshot.worthTrying.map((item) => item.beanId)).not.toContain(uuid(109));
  });

  it('honors an explicit low-acidity milk preference without presenting roast inference as fact', () => {
    const data = fixture();
    data.preferenceProfile = { ...data.preferenceProfile, brewMode: 'milk', acidityPreference: 'low',
      roastLevels: ['中深烘焙'], flavorNotes: ['巧克力'], maxPricePer100g: 80, updatedAt: NOW };
    addBean(data, 1, { name: '低酸巧克力', roast: '中深烘焙', flavorNotes: ['巧克力'], milkPerformance: '奶咖醇厚，低酸', pricePer100g: 68 });
    addBean(data, 2, { name: '明亮果酸', roast: '浅烘焙', flavorNotes: ['柑橘'], milkPerformance: '明亮果酸', pricePer100g: 68 });
    addBean(data, 3, { name: '仅烘焙弱信号', roast: '深烘焙', flavorNotes: ['坚果'], pricePer100g: 68 });
    const snapshot = generate(data);
    expect(snapshot.worthTrying[0]!.beanId).toBe(uuid(101));
    expect(snapshot.worthTrying[0]!.factors.some((factor) => factor.evidence.includes('低酸'))).toBe(true);
    expect(snapshot.worthTrying[1]!.missingData).not.toContain('酸感仅由烘焙度弱推断');
    const inferred = snapshot.worthTrying.find((item) => item.beanId === uuid(103))!;
    expect(inferred.allFactors.find((factor) => factor.key === 'flavor')?.evidence).toContain('仅以“深烘焙”作为低酸弱信号');
    expect(inferred.missingData).toContain('酸感仅由烘焙度弱推断');
  });

  it('surfaces conflicting americano and milk evidence instead of averaging it into false confidence', () => {
    const data = fixture();
    data.preferenceProfile = { ...data.preferenceProfile, brewMode: 'balanced', updatedAt: NOW };
    const bean = addBean(data, 1, { name: '冲煮冲突豆', flavorNotes: ['坚果'] });
    addExperience(data, bean.id, 1, { americano: 5, milk: 1.5, repurchase: 'price_dependent' });
    const item = generate(data).repurchase[0]!;
    expect(item.confidence).toBe('low');
    expect(item.missingData).toContain('美式与奶咖评价信号冲突');
  });

  it('lets a no-repurchase decision override high similarity and score', () => {
    const data = fixture();
    data.preferenceProfile = { ...data.preferenceProfile, flavorNotes: ['莓果'], updatedAt: NOW };
    const rejected = addBean(data, 1, { name: '不再买', flavorNotes: ['莓果'] });
    addExperience(data, rejected.id, 1, { americano: 5, repurchase: 'no', flavorNotes: ['莓果'] });
    const accepted = addBean(data, 2, { name: '会再买', flavorNotes: ['坚果'] });
    addExperience(data, accepted.id, 2, { americano: 3.5, repurchase: 'yes', flavorNotes: ['坚果'] });
    const snapshot = generate(data);
    expect(snapshot.repurchase.map((item) => item.beanId)).toEqual([accepted.id]);
    expect(snapshot.exclusions).toContainEqual(expect.objectContaining({ beanId: rejected.id, track: 'repurchase', reason: 'explicit_no_repurchase' }));
  });

  it('treats unknown price as a data gap rather than zero', () => {
    const data = fixture();
    data.preferenceProfile = { ...data.preferenceProfile, maxPricePer100g: 80, updatedAt: NOW };
    addBean(data, 1, { name: '未知价格', followed: true, pricePer100g: null });
    const item = generate(data).worthTrying[0]!;
    expect(item.missingData).toContain('缺少每 100g 价格');
    expect(item.factors.some((factor) => factor.key === 'price' && factor.evidence.includes('0'))).toBe(false);
  });

  it('keeps all factor contributions aligned with KTD6 fixed weights', () => {
    const data = fixture();
    addBean(data, 1, { name: '权重豆', followed: true, flavorNotes: ['可可'], pricePer100g: 75, milkPerformance: '适合奶咖' });
    const item = generate(data).worthTrying[0]!;
    const weights = Object.fromEntries(item.allFactors.map((factor) => [factor.key, factor.weight]));
    expect(weights).toEqual({ explicit: 45, brew: 20, flavor: 20, price: 10, interest: 5 });
    expect(item.factors).toEqual([...item.allFactors].sort((a, b) => b.contribution - a.contribution || a.key.localeCompare(b.key)).slice(0, 3));
  });
});
