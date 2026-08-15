import { parseProductMetadata } from './parse/metadata.js';
import { parseDuckDuckGoResults } from './search/duckduckgo.js';
import { createSafeUrlFetcher, type SafeHtmlResult } from './url-policy.js';
import type { CollectionCandidate, SearchCandidate } from './types.js';

export interface CollectionService {
  search(query: string): Promise<SearchCandidate[]>;
  parse(url: string): Promise<CollectionCandidate>;
}

export function createCollectionService(options: { fetchHtml?: (url: string) => Promise<SafeHtmlResult> } = {}): CollectionService {
  const fetchHtml = options.fetchHtml ?? createSafeUrlFetcher().fetchHtml;
  return {
    async search(query) {
      const endpoint = new URL('https://html.duckduckgo.com/html/');
      endpoint.searchParams.set('q', query);
      const page = await fetchHtml(endpoint.toString());
      return parseDuckDuckGoResults(page.html);
    },
    async parse(url) {
      const page = await fetchHtml(url);
      return parseProductMetadata({ url: page.finalUrl, html: page.html, capturedAt: new Date().toISOString() });
    },
  };
}
