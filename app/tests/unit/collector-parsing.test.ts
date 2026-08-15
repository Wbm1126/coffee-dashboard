import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseProductMetadata, ProductMetadataError } from '../../src/collectors/parse/metadata.js';
import { parseDuckDuckGoResults } from '../../src/collectors/search/duckduckgo.js';

const NOW = '2026-08-15T08:00:00.000Z';

describe('collector parsers', () => {
  it('extracts JSON-LD, Open Graph and labelled static product fields with no live request', async () => {
    const html = await readFile(new URL('../fixtures/collectors/product-jsonld.html', import.meta.url), 'utf8');
    expect(parseProductMetadata({ url: 'https://shop.example.com/bean-a', html, capturedAt: NOW })).toMatchObject({
      sourceKind: 'search', fields: { brandName: '山谷咖啡', beanName: '日晒拼配', process: '日晒', flavorNotes: ['黑巧克力', '焦糖'], referencePrice: { amount: 68, currency: 'CNY' } },
    });
  });

  it('parses labelled origins and numeric schema.org prices without inventing an official source', () => {
    const parsed = parseProductMetadata({
      url: 'https://merchant.example.com/bean', capturedAt: NOW,
      html: '<script type="application/ld+json">{"@type":"Product","name":"埃塞豆","offers":{"price":72,"priceCurrency":"CNY"}}</script><p>产地：埃塞俄比亚</p>',
    });
    expect(parsed).toMatchObject({ sourceKind: 'search', fields: { beanName: '埃塞豆', originOrVariety: '埃塞俄比亚', referencePrice: { amount: 72, currency: 'CNY' } } });
  });

  it('returns multiple search candidates and treats changed or dynamic-only pages as manual-fallback inputs', async () => {
    const html = await readFile(new URL('../fixtures/collectors/duckduckgo-results.html', import.meta.url), 'utf8');
    expect(parseDuckDuckGoResults(html)).toHaveLength(2);
    expect(parseDuckDuckGoResults('<main><article>页面结构已经变化</article></main>')).toEqual([]);
    expect(() => parseProductMetadata({ url: 'https://shop.example.com/app', html: '<div id="app"></div>', capturedAt: NOW })).toThrow(ProductMetadataError);
  });
});
