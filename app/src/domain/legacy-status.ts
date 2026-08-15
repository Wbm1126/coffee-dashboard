import { normalizeIdentityText } from './bean-identity.js';

export type LegacyStatus = 'untried' | 'drank' | 'drinking' | 'unknown';

export function normalizeLegacyStatus(value: unknown): LegacyStatus {
  const text = normalizeIdentityText(value) ?? '';
  if (text.includes('在喝')) return 'drinking';
  if (text.includes('已喝')) return 'drank';
  if (text.includes('未喝')) return 'untried';
  return 'unknown';
}
