import { describe, expect, it } from 'vitest';
import { buildCollectionMergePreview } from '../../src/collectors/merge-preview.js';
import type { CoffeeData } from '../../src/domain/schema.js';

const NOW = '2026-08-15T08:00:00.000Z';
const brandId = '00000000-0000-4000-8000-000000000001';
const beanId = '00000000-0000-4000-8000-000000000002';

function fixture(): CoffeeData {
  return {
    schemaVersion: 1, dataRevision: 3, updatedAt: NOW,
    brands: [{ id: brandId, name: '旧品牌', aliases: [], archivedAt: null, createdAt: NOW, updatedAt: NOW }],
    beans: [{ id: beanId, brandId, name: '日晒拼配', normalizedKey: '旧品牌::日晒拼配', roastLevel: '中烘焙', process: '水洗', flavorNotes: [], followedAt: NOW, archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {
      roastLevel: [{ sourceKind: 'user', sourceId: 'manual', capturedAt: NOW, displayedText: '中烘焙' }],
    }, createdAt: NOW, updatedAt: NOW }],
    productSources: [], purchases: [], purchaseItems: [], drinkingRecords: [], assessments: [],
    preferenceProfile: { brewMode: 'any', acidityPreference: 'any', roastLevels: [], flavorNotes: [], avoidedFlavorNotes: [], maxPricePer100g: null, updatedAt: NOW },
    recommendationSnapshots: [], importBatches: [], exportSnapshots: [],
  };
}

describe('collection merge preview', () => {
  it('finds the duplicate and defaults to preserving a user-confirmed field', () => {
    const preview = buildCollectionMergePreview(fixture(), {
      sourceUrl: 'https://example.com/product', title: '日晒拼配', capturedAt: NOW, sourceKind: 'official',
      fields: { brandName: '旧品牌', beanName: '日晒拼配', roastLevel: '深烘焙', flavorNotes: ['黑巧克力'] },
    });
    expect(preview.duplicateBeans).toEqual([{ id: beanId, name: '日晒拼配', brandName: '旧品牌' }]);
    expect(preview.fields.find((field) => field.key === 'roastLevel')).toMatchObject({ currentValue: '中烘焙', proposedValue: '深烘焙', defaultDecision: 'keep_existing' });
    expect(preview.fields.find((field) => field.key === 'flavorNotes')).toMatchObject({ defaultDecision: 'accept_candidate' });
  });
});
