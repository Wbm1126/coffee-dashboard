import type { CollectionCandidate, CollectionFields } from '../types.js';

export class ProductMetadataError extends Error {
  constructor(public readonly code: 'no_product_fields' | 'invalid_product_page', message: string) {
    super(message);
    this.name = 'ProductMetadataError';
  }
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function metaIndex(html: string): Map<string, string> {
  const entries = new Map<string, string>();
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metas) {
    const key = /(?:property|name)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || entries.has(key)) continue;
    const content = /content\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? /content\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    const value = stripHtml(content);
    if (value) entries.set(key, value);
  }
  return entries;
}

function title(html: string): string | undefined {
  return stripHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
}

function findProduct(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) { const product = findProduct(item); if (product) return product; }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const type = record['@type'];
  if ((typeof type === 'string' && type.toLowerCase() === 'product') || (Array.isArray(type) && type.some((entry) => String(entry).toLowerCase() === 'product'))) return record;
  for (const child of Object.values(record)) { const product = findProduct(child); if (product) return product; }
  return undefined;
}

function jsonLdProduct(html: string): Record<string, unknown> | undefined {
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const product = findProduct(JSON.parse(match[1]) as unknown);
      if (product) return product;
    } catch {
      // A malformed publisher block must not prevent Open Graph fallback.
    }
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? stripHtml(value) : undefined;
}

function brandName(value: unknown): string | undefined {
  if (typeof value === 'string') return stripHtml(value);
  if (value && typeof value === 'object') return text((value as Record<string, unknown>).name);
  return undefined;
}

function offer(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return value.find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined;
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function labelledText(html: string, label: string): string | undefined {
  const expression = new RegExp(`(?:${label})\\s*[：:]\\s*([^<\\n。；;]{1,160})`, 'i');
  return stripHtml(expression.exec(html)?.[1]);
}

function flavorNotes(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const notes = value.split(/[、,，/／|｜]/).map((item) => item.trim()).filter(Boolean).slice(0, 24);
  return notes.length ? notes : undefined;
}

export function parseProductMetadata(input: { url: string; html: string; capturedAt: string }): CollectionCandidate {
  const product = jsonLdProduct(input.html);
  const meta = metaIndex(input.html);
  const productName = text(product?.name) ?? meta.get('og:title') ?? title(input.html);
  const description = text(product?.description) ?? meta.get('og:description') ?? meta.get('description');
  const offers = offer(product?.offers);
  const rawPrice = text(offers?.price);
  const amount = rawPrice === undefined ? undefined : Number(rawPrice.replace(/[^\d.]/g, ''));
  const fields: CollectionFields = {
    brandName: brandName(product?.brand),
    beanName: productName,
    roastLevel: labelledText(input.html, '烘焙度?') ?? /((?:浅|中浅|中|中深|深)烘焙)/.exec(input.html)?.[1],
    process: labelledText(input.html, '处理法?'),
    flavorNotes: flavorNotes(labelledText(input.html, '风味')),
    originOrVariety: labelledText(input.html, '产地|品种'),
    officialFlavorDescription: description,
    referencePrice: Number.isFinite(amount) && amount! >= 0 ? { amount: amount!, currency: (text(offers?.priceCurrency) ?? 'CNY').slice(0, 3).toUpperCase() } : undefined,
  };
  if (!fields.beanName) throw new ProductMetadataError('no_product_fields', '页面没有可确认的商品名称，请改用手工录入。');
  return {
    sourceUrl: input.url,
    title: productName!,
    capturedAt: input.capturedAt,
    // Generic metadata extraction cannot establish that a host is an official
    // brand/store. Reserve `official` for a future explicit adapter.
    sourceKind: 'search',
    fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as CollectionFields,
  };
}
