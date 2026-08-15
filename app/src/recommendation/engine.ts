import type {
  CoffeeData,
  PreferenceProfile,
  RecommendationFactor,
  RecommendationItem,
  RecommendationSnapshot,
} from '../domain/schema.js';
import {
  learnedFlavorNotes,
  normalizeRecommendationText,
  normalizedPreferenceNotes,
  projectRecommendationFeatures,
  type BeanRecommendationFeatures,
} from './features.js';
import { FACTOR_LABELS, RECOMMENDATION_RULES, RECOMMENDATION_RULE_VERSION, type RecommendationFactorKey } from './rules.js';

export interface RecommendationGenerationOptions {
  id: string;
  generatedAt: string;
  dataRevision: number;
}

const round = (value: number) => Math.round(value * 100) / 100;
const mean = (values: number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const scoreToUnit = (score: number) => (score - 1) / 4;

interface NormalizedPreferenceContext {
  preferredNotes: string[];
  avoidedNotes: string[];
  roastLevels: Set<string>;
}

interface FactorInput {
  key: RecommendationFactorKey;
  unitScore: number;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

function factor(input: FactorInput): RecommendationFactor {
  const weight = RECOMMENDATION_RULES.weights[input.key];
  return {
    key: input.key,
    label: FACTOR_LABELS[input.key],
    weight,
    contribution: round(Math.max(0, Math.min(1, input.unitScore)) * weight),
    evidence: input.evidence,
    confidence: input.confidence,
  };
}

function explicitFactor(feature: BeanRecommendationFeatures, track: 'worth_trying' | 'repurchase', missing: string[]): RecommendationFactor {
  if (track === 'worth_trying') {
    missing.push('尚无这支豆的个人评价或回购判断');
    return factor({ key: 'explicit', unitScore: 0.5, evidence: '未饮用候选没有个人评分，按中性值处理', confidence: 'low' });
  }
  const scores = [...feature.americanoScores, ...feature.milkScores];
  const reviewScore = mean(scores.map(scoreToUnit));
  const repurchaseScore = feature.assessmentRepurchase === 'yes' ? 1
    : feature.assessmentRepurchase === 'price_dependent' ? 0.62 : null;
  if (reviewScore == null) missing.push('缺少个人评分');
  if (repurchaseScore == null) missing.push('缺少回购判断');
  const known = [reviewScore, repurchaseScore].filter((value): value is number => value !== null);
  const unitScore = mean(known) ?? 0.5;
  const evidence = [
    reviewScore == null ? null : `个人评分均值 ${round(mean(scores)!)} / 5`,
    feature.assessmentRepurchase === 'yes' ? '明确选择“会回购”' : feature.assessmentRepurchase === 'price_dependent' ? '明确选择“看价格”' : null,
  ].filter(Boolean).join('；') || '个人评价信息不足，按中性值处理';
  return factor({ key: 'explicit', unitScore, evidence, confidence: known.length === 2 ? 'high' : known.length === 1 ? 'medium' : 'low' });
}

function brewFactor(feature: BeanRecommendationFeatures, profile: PreferenceProfile, normalized: NormalizedPreferenceContext, missing: string[]): { factor: RecommendationFactor; conflict: boolean } {
  const americano = mean(feature.americanoScores);
  const milk = mean(feature.milkScores);
  const conflict = profile.brewMode === 'balanced' && americano != null && milk != null && Math.abs(americano - milk) >= 2;
  if (conflict) missing.push('美式与奶咖评价信号冲突');

  let unitScore: number | null = null;
  let evidence = '';
  if (profile.brewMode === 'americano' && americano != null) {
    unitScore = scoreToUnit(americano); evidence = `美式个人评分均值 ${round(americano)} / 5`;
  } else if (profile.brewMode === 'milk' && milk != null) {
    unitScore = scoreToUnit(milk); evidence = `奶咖个人评分均值 ${round(milk)} / 5`;
  } else if (profile.brewMode === 'balanced' && (americano != null || milk != null)) {
    unitScore = mean([americano, milk].filter((value): value is number => value !== null))!;
    unitScore = scoreToUnit(unitScore);
    evidence = americano != null && milk != null
      ? `美式 ${round(americano)} / 5、奶咖 ${round(milk)} / 5，分别保留后综合`
      : `仅有${americano != null ? '美式' : '奶咖'}个人评分 ${round(americano ?? milk!)} / 5`;
  }

  if (unitScore == null) {
    const signal = profile.brewMode === 'americano' ? feature.americanoProductSignal
      : profile.brewMode === 'milk' ? feature.milkProductSignal
        : feature.americanoProductSignal && feature.milkProductSignal;
    if (signal) {
      unitScore = 0.78;
      evidence = `商品资料明确提及${profile.brewMode === 'americano' ? '美式' : profile.brewMode === 'milk' ? '奶咖' : '美式与奶咖'}适配`;
    } else if (profile.roastLevels.length > 0 && feature.bean.roastLevel) {
      const roastMatch = normalized.roastLevels.has(normalizeRecommendationText(feature.bean.roastLevel));
      unitScore = roastMatch ? 0.68 : 0.32;
      evidence = roastMatch
        ? `匹配显式烘焙偏好“${feature.bean.roastLevel}”，仅作为冲煮适配的辅助信号`
        : `烘焙度“${feature.bean.roastLevel}”未匹配显式偏好`;
    } else {
      unitScore = 0.5;
      evidence = '缺少目标冲煮方式的个人评分或明确商品描述，按中性值处理';
      missing.push('缺少目标冲煮方式的适配证据');
    }
  }
  return { factor: factor({ key: 'brew', unitScore, evidence, confidence: conflict ? 'low' : americano != null || milk != null ? 'high' : unitScore > 0.5 ? 'medium' : 'low' }), conflict };
}

function flavorFactor(feature: BeanRecommendationFeatures, profile: PreferenceProfile, normalized: NormalizedPreferenceContext, missing: string[]): RecommendationFactor {
  const candidate = new Set(feature.candidateFlavorNotes.map(normalizeRecommendationText));
  const matches = normalized.preferredNotes.filter((note) => candidate.has(note));
  const avoidedMatches = normalized.avoidedNotes.filter((note) => candidate.has(note));
  let unitScore = normalized.preferredNotes.length > 0 ? matches.length / normalized.preferredNotes.length : 0.5;
  const evidence: string[] = [];
  if (normalized.preferredNotes.length > 0) evidence.push(matches.length > 0 ? `命中偏好风味：${matches.join('、')}` : '未命中已维护的偏好风味');
  else {
    evidence.push('没有可比较的显式或高分历史风味，按中性值处理');
    missing.push('缺少可比较的风味偏好');
  }
  if (avoidedMatches.length > 0) {
    unitScore *= 0.2;
    evidence.push(`出现避开的风味：${avoidedMatches.join('、')}`);
  }

  if (profile.acidityPreference !== 'any') {
    if (feature.acidSignal === null) {
      missing.push('缺少明确酸感描述');
      evidence.push('酸感未知，未按低分处理');
    } else {
      const target = profile.acidityPreference === 'low' ? 'low' : profile.acidityPreference === 'high' ? 'high' : null;
      const acidScore = target === null ? 0.7 : feature.acidSignal === target ? (feature.acidEvidenceKind === 'explicit' ? 1 : 0.65) : 0;
      unitScore = (unitScore + acidScore) / 2;
      evidence.push(feature.acidEvidence!);
      if (feature.acidEvidenceKind === 'roast_inference') missing.push('酸感仅由烘焙度弱推断');
    }
  }
  return factor({ key: 'flavor', unitScore, evidence: evidence.join('；'), confidence: candidate.size > 0 && feature.acidEvidenceKind !== 'roast_inference' ? 'medium' : 'low' });
}

function priceFactor(feature: BeanRecommendationFeatures, profile: PreferenceProfile, missing: string[]): RecommendationFactor {
  if (feature.pricePer100g == null) {
    missing.push('缺少每 100g 价格');
    return factor({ key: 'price', unitScore: 0.5, evidence: '价格未知，按中性值处理而非最低值', confidence: 'low' });
  }
  if (profile.maxPricePer100g == null) {
    missing.push('尚未设置每 100g 预算');
    return factor({ key: 'price', unitScore: 0.5, evidence: `当前价格约 ¥${round(feature.pricePer100g)} / 100g；未设置预算`, confidence: 'medium' });
  }
  const within = feature.pricePer100g <= profile.maxPricePer100g;
  return factor({ key: 'price', unitScore: within ? 1 : profile.maxPricePer100g / feature.pricePer100g,
    evidence: `约 ¥${round(feature.pricePer100g)} / 100g，${within ? '在' : '高于'} ¥${round(profile.maxPricePer100g)} 预算`, confidence: 'high' });
}

function interestFactor(feature: BeanRecommendationFeatures): RecommendationFactor {
  const unitScore = feature.followed ? 1 : feature.purchased ? 0.8 : 0;
  const evidence = feature.followed && feature.purchased ? '已关注且有购买记录'
    : feature.followed ? '已加入关注' : feature.purchased ? '已有购买记录' : '尚无关注或购买弱信号';
  return factor({ key: 'interest', unitScore, evidence, confidence: unitScore > 0 ? 'high' : 'low' });
}

function buildItem(feature: BeanRecommendationFeatures, track: 'worth_trying' | 'repurchase', profile: PreferenceProfile, normalized: NormalizedPreferenceContext): RecommendationItem {
  const missingData: string[] = [];
  const explicit = explicitFactor(feature, track, missingData);
  const brew = brewFactor(feature, profile, normalized, missingData);
  const allFactors = [
    explicit,
    brew.factor,
    flavorFactor(feature, profile, normalized, missingData),
    priceFactor(feature, profile, missingData),
    interestFactor(feature),
  ];
  const factors = [...allFactors].sort((left, right) => right.contribution - left.contribution || left.key.localeCompare(right.key)).slice(0, 3);
  const known = allFactors.filter((entry) => entry.confidence !== 'low').length;
  return {
    beanId: feature.bean.id,
    score: round(allFactors.reduce((sum, entry) => sum + entry.contribution, 0)),
    confidence: brew.conflict || known < 2 ? 'low' : known >= 4 ? 'high' : 'medium',
    factors,
    allFactors,
    missingData: [...new Set(missingData)],
  };
}

function rank(items: RecommendationItem[], byId: Map<string, BeanRecommendationFeatures>, coldStart: boolean): RecommendationItem[] {
  return items.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (coldStart) {
      const editorDifference = byId.get(right.beanId)!.editorialTieBreak - byId.get(left.beanId)!.editorialTieBreak;
      if (editorDifference !== 0) return editorDifference;
    }
    const keyDifference = byId.get(left.beanId)!.bean.normalizedKey.localeCompare(byId.get(right.beanId)!.bean.normalizedKey, 'zh-CN');
    return keyDifference || left.beanId.localeCompare(right.beanId);
  });
}

export function generateRecommendationSnapshot(data: CoffeeData, options: RecommendationGenerationOptions): RecommendationSnapshot {
  const projected = projectRecommendationFeatures(data);
  const byId = new Map(projected.map((feature) => [feature.bean.id, feature]));
  const preferredNotes = normalizedPreferenceNotes(data.preferenceProfile, learnedFlavorNotes(projected));
  const normalized: NormalizedPreferenceContext = {
    preferredNotes,
    avoidedNotes: data.preferenceProfile.avoidedFlavorNotes.map(normalizeRecommendationText),
    roastLevels: new Set(data.preferenceProfile.roastLevels.map(normalizeRecommendationText)),
  };
  const historyScoreCount = projected.reduce((count, feature) => count + feature.americanoScores.length + feature.milkScores.length, 0);
  const exclusions: RecommendationSnapshot['exclusions'] = [];
  const worthTrying: RecommendationItem[] = [];
  const repurchase: RecommendationItem[] = [];

  for (const feature of projected) {
    if (feature.bean.isDraft || feature.bean.archivedAt) {
      const reason = feature.bean.isDraft ? 'draft' : 'archived';
      exclusions.push({ beanId: feature.bean.id, track: 'worth_trying', reason });
      exclusions.push({ beanId: feature.bean.id, track: 'repurchase', reason });
      continue;
    }
    if (feature.tried) {
      exclusions.push({ beanId: feature.bean.id, track: 'worth_trying', reason: 'already_tried' });
      if (feature.assessmentRepurchase === 'no') {
        exclusions.push({ beanId: feature.bean.id, track: 'repurchase', reason: 'explicit_no_repurchase' });
      } else {
        repurchase.push(buildItem(feature, 'repurchase', data.preferenceProfile, normalized));
      }
    } else {
      worthTrying.push(buildItem(feature, 'worth_trying', data.preferenceProfile, normalized));
      exclusions.push({ beanId: feature.bean.id, track: 'repurchase', reason: 'not_tried' });
    }
  }

  return {
    id: options.id,
    dataRevision: options.dataRevision,
    ruleVersion: RECOMMENDATION_RULE_VERSION,
    generatedAt: options.generatedAt,
    staleAt: null,
    staleBecauseRevision: null,
    worthTrying: rank(worthTrying, byId, historyScoreCount === 0),
    repurchase: rank(repurchase, byId, historyScoreCount === 0),
    exclusions,
  };
}
