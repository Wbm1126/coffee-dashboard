import { beanIdentityKey } from '../domain/bean-identity.js';
import type { CoffeeBean, CoffeeData } from '../domain/schema.js';
import { COLLECTION_FIELD_KEYS, type CollectionCandidate, type CollectionFieldKey } from './types.js';

export interface CollectionMergePreview {
  duplicateBeans: Array<{ id: string; name: string; brandName: string }>;
  fields: Array<{ key: CollectionFieldKey; currentValue: unknown; proposedValue: unknown; defaultDecision: 'accept_candidate' | 'keep_existing' }>;
}

function brandName(data: CoffeeData, bean: CoffeeBean): string {
  return data.brands.find((brand) => brand.id === bean.brandId)?.name ?? '未标品牌';
}

function currentValue(data: CoffeeData, bean: CoffeeBean, key: CollectionFieldKey): unknown {
  if (key === 'brandName') return brandName(data, bean);
  if (key === 'beanName') return bean.name;
  if (key === 'roastLevel' || key === 'process' || key === 'flavorNotes') return bean[key];
  return bean.importedFacts?.[key as 'originOrVariety' | 'officialFlavorDescription' | 'referencePrice' | 'packageGrams'] ?? null;
}

function present(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';
}

export function buildCollectionMergePreview(data: CoffeeData, candidate: CollectionCandidate): CollectionMergePreview {
  const proposedBrand = candidate.fields.brandName;
  const proposedBean = candidate.fields.beanName;
  const normalizedKey = proposedBrand && proposedBean ? beanIdentityKey(proposedBrand, proposedBean) : null;
  const duplicates = normalizedKey === null ? [] : data.beans
    .filter((bean) => !bean.archivedAt && bean.normalizedKey === normalizedKey)
    .map((bean) => ({ id: bean.id, name: bean.name, brandName: brandName(data, bean) }));
  const existing = duplicates[0] ? data.beans.find((bean) => bean.id === duplicates[0].id) : undefined;
  return {
    duplicateBeans: duplicates,
    fields: COLLECTION_FIELD_KEYS.filter((key) => candidate.fields[key] !== undefined).map((key) => {
      const existingValue = existing ? currentValue(data, existing, key) : null;
      return {
        key,
        currentValue: existingValue,
        proposedValue: candidate.fields[key],
        defaultDecision: present(existingValue) ? 'keep_existing' : 'accept_candidate',
      };
    }),
  };
}
