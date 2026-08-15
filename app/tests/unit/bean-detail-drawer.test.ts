import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import { BeanDetailDrawer } from '../../src/client/features/beans/BeanDetailDrawer.js';
import { buildGalleryItems } from '../../src/client/features/gallery/gallery-model.js';

describe('bean detail drawer', () => {
  it('shows the purchase item source behind a drinking record', () => {
    const data = createEmptyCoffeeData(new Date('2026-08-07T08:00:00+08:00'));
    const beanId = '00000000-0000-4000-8000-000000000201';
    const purchaseId = '00000000-0000-4000-8000-000000000301';
    const purchaseItemId = '00000000-0000-4000-8000-000000000302';
    data.beans = [{ id: beanId, brandId: null, name: '可追溯豆', normalizedKey: '可追溯豆', roastLevel: null, process: null, flavorNotes: [], followedAt: null,
      archivedAt: null, isDraft: false, legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {}, createdAt: data.updatedAt, updatedAt: data.updatedAt }];
    data.purchases = [{ id: purchaseId, purchasedOn: '2026-08-01', channel: '门店', note: null, shipping: null, discount: null, itemIds: [purchaseItemId],
      deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt }];
    data.purchaseItems = [{ id: purchaseItemId, purchaseId, beanId, quantity: 1, packageGrams: 250, paid: { amount: 88, currency: 'CNY' }, bagStatus: 'drinking' }];
    data.drinkingRecords = [{ id: '00000000-0000-4000-8000-000000000401', beanId, purchaseItemId, drankOn: '2026-08-07', brewMethod: 'americano',
      extractionNote: null, feeling: null, americanoReview: { state: 'reviewed', score: 4, flavorNotes: [], pros: null, cons: null, note: null },
      milkReview: null, draftAssessment: null, isDraft: false, deletedAt: null, createdAt: data.updatedAt, updatedAt: data.updatedAt }];
    const item = buildGalleryItems(data)[0]!;

    const html = renderToStaticMarkup(createElement(BeanDetailDrawer, { item, returnFocusTo: null, dataRevision: data.dataRevision, csrfToken: 'test',
      onDataChanged: vi.fn(), onLifecycleCompleted: vi.fn(), onClose: vi.fn(), onFollow: vi.fn(),
      onPurchase: vi.fn(), followBusy: false, followDisabled: false }));

    expect(html).toContain('购买来源');
    expect(html).toContain('2026-08-01');
    expect(html).toContain('门店');
    expect(html).toContain('250g');
    expect(html).toContain('¥88');
    expect(html).toContain('查看归档或删除影响');
  });
});
