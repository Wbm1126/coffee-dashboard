import { describe, expect, it } from 'vitest';
import {
  normalizeName,
  normalizeNumber,
  normalizeRoastLevel,
  normalizeSpecification,
  normalizeStatus,
} from '../../src/import/xlsx/normalizers.js';

describe('Excel import normalizers', () => {
  it('collapses spreadsheet floating point noise without losing the original display text', () => {
    expect(normalizeNumber(0.6899999999999999, '0.69')).toEqual({
      value: 0.69,
      displayedText: '0.69',
    });
  });

  it('treats numeric and suffixed gram specifications as equivalent', () => {
    expect(normalizeSpecification(227, '227')).toEqual({ grams: 227, displayedText: '227' });
    expect(normalizeSpecification('227g', '227g')).toEqual({ grams: 227, displayedText: '227g' });
  });

  it('normalizes equivalent roast labels while preserving meaningful differences', () => {
    expect(normalizeRoastLevel('中深度烘焙')).toBe('中深烘焙');
    expect(normalizeRoastLevel('中深烘焙')).toBe('中深烘焙');
    expect(normalizeRoastLevel('中烘焙')).not.toBe(normalizeRoastLevel('中浅烘焙'));
  });

  it('maps all three legacy status values without inventing dates or purchases', () => {
    expect(normalizeStatus('🆕未喝')).toBe('untried');
    expect(normalizeStatus('✅已喝')).toBe('drank');
    expect(normalizeStatus('🔥在喝')).toBe('drinking');
  });

  it('matches names across whitespace, punctuation and casing differences', () => {
    expect(normalizeName('  BLACK  CAT／黑猫 ')).toBe(normalizeName('black cat / 黑猫'));
  });
});
