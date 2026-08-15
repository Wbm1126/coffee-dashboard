import { validateExternalUrl } from '../url-policy.js';
import type { SearchCandidate } from '../types.js';

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2]
    ?? new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag)?.[1];
}

function unwrapDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, 'https://html.duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.toString();
  } catch {
    return value;
  }
}

export function parseDuckDuckGoResults(html: string): SearchCandidate[] {
  const results: SearchCandidate[] = [];
  for (const anchor of html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (results.length === 10) break;
    const tag = anchor[0];
    const href = attribute(tag, 'href');
    if (!href) continue;
    let url: URL;
    try { url = validateExternalUrl(unwrapDuckDuckGoUrl(decodeHtml(href))); } catch { continue; }
    const following = html.slice((anchor.index ?? 0) + tag.length, (anchor.index ?? 0) + tag.length + 1_200);
    const snippetMatch = /<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(following)
      ?? /<[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(following);
    const title = decodeHtml(anchor[1]);
    if (!title) continue;
    results.push({ title: title.slice(0, 500), url: url.toString(), snippet: snippetMatch ? decodeHtml(snippetMatch[1]).slice(0, 1_000) || null : null });
  }
  return results.slice(0, 10);
}
