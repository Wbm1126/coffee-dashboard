import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import { ComparisonView } from '../../src/client/features/comparison/ComparisonView.js';
import { buildGalleryItems } from '../../src/client/features/gallery/gallery-model.js';

describe('comparison view', () => {
  it('adds verifiable facts while keeping required unsourced dimensions unknown', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-07T08:00:00+08:00'));
    data.beans = [{
      id: '00000000-0000-4000-8000-000000000201', brandId: null, name: '山谷豆', normalizedKey: '山谷豆', roastLevel: '中烘焙', process: '水洗',
      flavorNotes: ['柑橘', '坚果'], followedAt: null, archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null,
      importedFacts: { overallScoreRaw: null, preferenceMatchRaw: null, recommendationRaw: null, referencePrice: null, pricePerGram: null,
        packageGrams: null, originOrVariety: '哥伦比亚', officialFlavorDescription: null, americanoPerformance: null, milkPerformance: null,
        suitableScenes: [], legacyNote: null, legacyScoreBasisRaw: null }, provenance: {}, createdAt: data.updatedAt, updatedAt: data.updatedAt,
    }, {
      id: '00000000-0000-4000-8000-000000000202', brandId: null, name: '未知豆', normalizedKey: '未知豆', roastLevel: null, process: null,
      flavorNotes: [], followedAt: null, archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null,
      provenance: {}, createdAt: data.updatedAt, updatedAt: data.updatedAt,
    }];
    const html = renderToStaticMarkup(createElement(ComparisonView, { items: buildGalleryItems(data), onRemove: vi.fn(), onOpen: vi.fn(),
      onFollow: vi.fn(), onPurchase: vi.fn(), busyBeanId: null }));

    expect(html).toContain('处理法');
    expect(html).toContain('产地 / 品种');
    expect(html).toContain('风味标签');
    expect(html).toContain('水洗');
    expect(html).toContain('哥伦比亚');
    expect(html).toContain('柑橘、坚果');
    expect(html).toContain('未知');
    for (const label of ['甜感', '酸感', '风味强度']) {
      expect(html).toContain(`<th scope="row">${label}</th><td><span class="unknown-value">未知</span></td>`);
    }
  });
});
