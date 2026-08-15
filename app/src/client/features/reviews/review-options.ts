import type { BrewMethod, Repurchase, Review } from '../../../domain/schema';

type SelectOption<T extends string> = {
  value: T;
  label: string;
};

type ReviewStateOption = {
  value: Review['state'];
  label: string;
};

export const REVIEW_STATE_OPTIONS = [
  { value: 'unreviewed', label: '稍后评价' },
  { value: 'reviewed', label: '已评价' },
  { value: 'not_applicable', label: '不适用' },
] as const satisfies readonly ReviewStateOption[];

export const REVIEW_STATE_LABELS: Readonly<Record<Review['state'], string>> = {
  unreviewed: '未评价',
  reviewed: '已评价',
  not_applicable: '不适用',
};

export const REVIEW_SCORE_MAX = 5;

export const REVIEW_SCORE_OPTIONS = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1] as const;

export const BREW_METHOD_OPTIONS = [
  { value: 'americano', label: '美式' },
  { value: 'milk', label: '奶咖' },
  { value: 'espresso', label: '浓缩' },
  { value: 'other', label: '其他' },
] as const satisfies readonly SelectOption<BrewMethod>[];

export const GRADE_OPTIONS = [
  { value: 'S', label: 'S · 私藏级' },
  { value: 'A', label: 'A · 很喜欢' },
  { value: 'B', label: 'B · 会再喝' },
  { value: 'C', label: 'C · 不太适合' },
] as const satisfies readonly SelectOption<string>[];

export const REPURCHASE_OPTIONS = [
  { value: 'yes', label: '会回购' },
  { value: 'price_dependent', label: '看价格' },
  { value: 'no', label: '不会回购' },
] as const satisfies readonly SelectOption<Repurchase>[];
