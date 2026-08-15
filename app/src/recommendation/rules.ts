import { z } from 'zod';
import rulesJson from './rules.v1.json' with { type: 'json' };

const RecommendationRulesSchema = z.object({
  version: z.string().min(1),
  weights: z.object({
    explicit: z.literal(45),
    brew: z.literal(20),
    flavor: z.literal(20),
    price: z.literal(10),
    interest: z.literal(5),
  }),
});

export const RECOMMENDATION_RULES = RecommendationRulesSchema.parse(rulesJson);
export const RECOMMENDATION_RULE_VERSION = RECOMMENDATION_RULES.version;
export type RecommendationFactorKey = keyof typeof RECOMMENDATION_RULES.weights;

export const FACTOR_LABELS: Record<RecommendationFactorKey, string> = {
  explicit: '个人评价与回购判断',
  brew: '冲煮适配',
  flavor: '风味相似',
  price: '价格适配',
  interest: '关注与购买',
};
