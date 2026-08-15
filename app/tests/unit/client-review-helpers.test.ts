import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLocalDate } from '../../src/client/local-date.js';
import { BREW_METHOD_OPTIONS, GRADE_OPTIONS, REPURCHASE_OPTIONS, REVIEW_SCORE_OPTIONS, REVIEW_STATE_OPTIONS } from '../../src/client/features/reviews/review-options.js';

describe('client review helpers', () => {
  let originalTimezone: string | undefined;

  beforeEach(() => {
    originalTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
  });

  afterEach(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  it('formats the local calendar day instead of the UTC day', () => {
    expect(formatLocalDate(new Date('2026-08-05T16:30:00.000Z'))).toBe('2026-08-06');
  });

  it('keeps review labels and the half-point score scale centralized', () => {
    expect(REVIEW_STATE_OPTIONS).toEqual([
      { value: 'unreviewed', label: '稍后评价' },
      { value: 'reviewed', label: '已评价' },
      { value: 'not_applicable', label: '不适用' },
    ]);
    expect(REVIEW_SCORE_OPTIONS).toEqual([5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1]);
    expect(BREW_METHOD_OPTIONS.map((option) => option.value)).toEqual(['americano', 'milk', 'espresso', 'other']);
    expect(GRADE_OPTIONS.map((option) => option.value)).toEqual(['S', 'A', 'B', 'C']);
    expect(REPURCHASE_OPTIONS.map((option) => option.value)).toEqual(['yes', 'price_dependent', 'no']);
  });
});
