import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchTransportRequest {
  url: URL;
  address: ResolvedAddress;
  timeoutMs: number;
  maxBytes: number;
}

export interface SafeFetchTransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** 原始字节（资源下载用）；html 文本路径可不提供。 */
  bodyBuffer?: Buffer;
}

export type SafeFetchTransport = (request: SafeFetchTransportRequest) => Promise<SafeFetchTransportResponse>;
export type SafeLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeHtmlResult {
  html: string;
  finalUrl: string;
}

export class SafeUrlFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SafeUrlFetchError';
  }
}

const DANGEROUS_PORTS = new Set(['1', '7', '9', '19', '21', '22', '23', '25', '53', '110', '111', '135', '137', '139', '143', '389', '445', '465', '587', '631', '1433', '1521', '2049', '2375', '3306', '3389', '5432', '5900', '6379', '11211']);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1_500_000;

function error(code: string, message: string, statusCode?: number): SafeUrlFetchError {
  return new SafeUrlFetchError(code, message, statusCode);
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return (((numbers[0] << 24) >>> 0) + (numbers[1] << 16) + (numbers[2] << 8) + numbers[3]) >>> 0;
}

function inIpv4Range(value: number, base: number, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (base & mask);
}

function parseIpv6(address: string): bigint | null {
  const cleaned = normalizedHost(address);
  if (cleaned.includes('.')) {
    const lastColon = cleaned.lastIndexOf(':');
    const mapped = parseIpv4(cleaned.slice(lastColon + 1));
    if (mapped === null) return null;
    const prefix = `${cleaned.slice(0, lastColon)}:${((mapped >>> 16) & 0xffff).toString(16)}:${(mapped & 0xffff).toString(16)}`;
    return parseIpv6(prefix);
  }
  const halves = cleaned.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.length + right.length > 8 || [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

export function isPublicIp(address: string): boolean {
  const family = isIP(normalizedHost(address));
  if (family === 4) {
    const value = parseIpv4(address);
    if (value === null) return false;
    return ![
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
      [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15],
      [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
    ].some(([base, bits]) => inIpv4Range(value, base, bits));
  }
  if (family === 6) {
    const value = parseIpv6(address);
    if (value === null) return false;
    // Do not accept IPv4-compatible or IPv4-mapped IPv6 literals. Apart from
    // their obsolete/ambiguous semantics, either can conceal a private IPv4
    // destination from a caller that only examines IPv6 ranges.
    const embeddedIpv4Prefix = value >> 32n;
    if (embeddedIpv4Prefix === 0n || embeddedIpv4Prefix === 0xffffn) return false;
    // The standardized NAT64 prefixes translate their final 32 bits to IPv4.
    // Reject a private embedded destination before pinning a socket there.
    const embeddedIpv4 = value & ((1n << 32n) - 1n);
    const embeddedIpv4Text = `${Number((embeddedIpv4 >> 24n) & 255n)}.${Number((embeddedIpv4 >> 16n) & 255n)}.${Number((embeddedIpv4 >> 8n) & 255n)}.${Number(embeddedIpv4 & 255n)}`;
    if ((inIpv6Range(value, 0x0064ff9b000000000000000000000000n, 96) || inIpv6Range(value, 0x0064ff9b000100000000000000000000n, 48)) && !isPublicIp(embeddedIpv4Text)) return false;
    const blockedRanges: Array<[bigint, number]> = [
      [0n, 128], [1n, 128], [0xfc000000000000000000000000000000n, 7], [0xfec00000000000000000000000000000n, 10], [0xfe800000000000000000000000000000n, 10],
      [0xff000000000000000000000000000000n, 8], [0x20010db8000000000000000000000000n, 32],
    ];
    return !blockedRanges.some(([base, bits]) => inIpv6Range(value, base, bits));
  }
  return false;
}

export function validateSourceUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw error('url_invalid', '链接格式无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw error('url_protocol_not_allowed', '只允许 http 或 https 商品链接。');
  if (url.username || url.password) throw error('url_credentials_not_allowed', '链接不能包含账号或密码。');
  if (!url.hostname) throw error('url_host_missing', '链接缺少主机名。');
  return url;
}

export function validateExternalUrl(input: string): URL {
  const url = validateSourceUrl(input);
  if (url.port && DANGEROUS_PORTS.has(url.port)) throw error('url_port_not_allowed', '该链接使用了不安全端口。');
  const host = normalizedHost(url.hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) throw error('url_host_not_public', '不允许访问本机地址。');
  if (isIP(host) && !isPublicIp(host)) throw error('url_host_not_public', '不允许访问私网或本机地址。');
  return url;
}

function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true }).then((rows) => rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 })));
}

function withinDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error('request_timeout', '商品页面请求超时。')), Math.max(1, timeoutMs));
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause) => { clearTimeout(timer); reject(cause); },
    );
  });
}

function headerValue(headers: SafeFetchTransportResponse['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function directTransport({ url, address, timeoutMs, maxBytes }: SafeFetchTransportRequest): Promise<SafeFetchTransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback();
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      agent: false,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      const contentLength = Number(response.headers['content-length'] ?? 0);
      const statusCode = response.statusCode ?? 0;
      if (REDIRECT_STATUS.has(statusCode) || statusCode < 200 || statusCode >= 300) {
        response.resume();
        settle(() => resolve({ statusCode, headers: response.headers, body: '' }));
        return;
      }
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.resume();
        settle(() => reject(error('response_too_large', '商品页面过大，未读取完整内容。')));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const rejectIncompleteResponse = () => settle(() => {
        response.destroy();
        request.destroy();
        reject(error('request_failed', '无法读取完整的商品页面。'));
      });
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(() => {
            response.destroy();
            request.destroy();
            reject(error('response_too_large', '商品页面过大，未读取完整内容。'));
          });
          return;
        }
        chunks.push(chunk);
      });
      response.once('aborted', rejectIncompleteResponse);
      response.once('error', rejectIncompleteResponse);
      response.once('close', () => {
        if (!response.complete) rejectIncompleteResponse();
      });
      response.once('end', () => {
        if (!response.complete) {
          rejectIncompleteResponse();
          return;
        }
        const bodyBuffer = Buffer.concat(chunks);
        settle(() => resolve({ statusCode, headers: response.headers, body: bodyBuffer.toString('utf8'), bodyBuffer }));
      });
    });
    // `setTimeout` is an idle timeout. This separate deadline also terminates
    // a slow-drip response that never goes idle.
    const deadline = setTimeout(() => request.destroy(error('request_timeout', '商品页面请求超时。')), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(error('request_timeout', '商品页面请求超时。')));
    request.once('error', (cause) => settle(() => reject(cause instanceof SafeUrlFetchError ? cause : error('request_failed', '无法读取商品页面。'))));
    request.end();
  });
}

export function createSafeUrlFetcher(options: {
  lookup?: SafeLookup;
  transport?: SafeFetchTransport;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
} = {}) {
  const lookup = options.lookup ?? defaultLookup;
  const transport = options.transport ?? directTransport;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 4;

  // 共享的校验+DNS+重定向循环：html 走文本，资源走二进制（图片缓存用）。
  const follow = async (input: string, allowedContentTypes: readonly string[], deadlineAt: number): Promise<{ finalUrl: URL; body: Buffer; contentType: string }> => {
    let url = validateExternalUrl(input);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw error('request_timeout', '商品页面请求超时。');
      const addresses = await withinDeadline(lookup(normalizedHost(url.hostname)), remaining);
      if (!addresses.length || addresses.some((address) => !isPublicIp(address.address))) {
        throw error('dns_not_public', '链接解析到了非公网地址，已拒绝访问。');
      }
      const responseRemaining = deadlineAt - Date.now();
      if (responseRemaining <= 0) throw error('request_timeout', '商品页面请求超时。');
      const response = await withinDeadline(transport({ url, address: addresses[0], timeoutMs: responseRemaining, maxBytes }), responseRemaining);
      if (Buffer.byteLength(response.body, 'utf8') > maxBytes) throw error('response_too_large', '商品页面过大，未读取完整内容。');
      if (REDIRECT_STATUS.has(response.statusCode)) {
        const location = headerValue(response.headers, 'location');
        if (!location) throw error('redirect_missing_location', '商品页面重定向无目标地址。');
        if (redirect === maxRedirects) throw error('redirect_limit', '商品页面重定向次数过多。');
        url = validateExternalUrl(new URL(location, url).toString());
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw error('http_status', '商品页面暂时无法读取。', response.statusCode);
      const contentType = headerValue(response.headers, 'content-type')?.toLowerCase() ?? '';
      if (!allowedContentTypes.some((allowed) => contentType.includes(allowed))) throw error('content_type_not_html', '该链接不是可解析的 HTML 商品页面。');
      return { finalUrl: url, body: response.bodyBuffer ?? Buffer.from(response.body, 'utf8'), contentType };
    }
    throw error('redirect_limit', '商品页面重定向次数过多。');
  };

  return {
    async fetchHtml(input: string): Promise<SafeHtmlResult> {
      const result = await follow(input, ['text/html', 'application/xhtml+xml'], Date.now() + timeoutMs);
      return { html: result.body.toString('utf8'), finalUrl: result.finalUrl.toString() };
    },
    /** 下载受限资源（如商品图片）：二进制安全，内容类型白名单校验。 */
    async fetchResource(input: string, allowedContentTypes: readonly string[]): Promise<{ finalUrl: string; body: Buffer; contentType: string }> {
      const result = await follow(input, allowedContentTypes, Date.now() + timeoutMs);
      return { finalUrl: result.finalUrl.toString(), body: result.body, contentType: result.contentType };
    },
  };
}
