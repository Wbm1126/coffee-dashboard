import { normalizeBeanIdentity, normalizeIdentityText } from '../../domain/bean-identity.js';
import { normalizeLegacyStatus, type LegacyStatus } from '../../domain/legacy-status.js';

export type { LegacyStatus } from '../../domain/legacy-status.js';

export function normalizeText(value: unknown): string | null {
  return normalizeIdentityText(value);
}

export function normalizeName(value: unknown): string {
  return normalizeBeanIdentity(value);
}

export function normalizeNumber(
  value: unknown,
  displayedText = normalizeText(value) ?? '',
): { value: number | null; displayedText: string } {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[,¥￥]/g, ''));
  return {
    value: Number.isFinite(numeric) ? Number(numeric.toPrecision(12)) : null,
    displayedText,
  };
}

export function normalizeSpecification(
  value: unknown,
  displayedText = normalizeText(value) ?? '',
): { grams: number | null; displayedText: string } {
  const match = (normalizeText(value) ?? '').match(/-?\d+(?:\.\d+)?/);
  const grams = match ? Number.parseFloat(match[0]) : null;
  return { grams: grams !== null && Number.isFinite(grams) && grams > 0 ? grams : null, displayedText };
}

export function normalizeRoastLevel(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  return text
    .replace(/中深度烘焙/g, '中深烘焙')
    .replace(/中度烘焙/g, '中烘焙')
    .replace(/中浅度烘焙/g, '中浅烘焙')
    .replace(/深度烘焙/g, '深烘焙')
    .replace(/浅度烘焙/g, '浅烘焙');
}

export function normalizeStatus(value: unknown): LegacyStatus {
  return normalizeLegacyStatus(value);
}

export function splitList(value: unknown): string[] {
  const text = normalizeText(value);
  if (!text) return [];
  return [...new Set(text.split(/[、，,;；/\n]+/).map((item) => item.trim()).filter(Boolean))];
}
