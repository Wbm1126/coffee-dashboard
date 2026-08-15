import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SafeUrlFetchError,
  createSafeUrlFetcher,
  directTransport,
  validateExternalUrl,
  type SafeFetchTransport,
} from '../../src/collectors/url-policy.js';

const publicAddress = [{ address: '93.184.216.34', family: 4 }];
const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((cause) => cause ? reject(cause) : resolve());
  })));
});

describe('collector URL policy', () => {
  it.each([
    'file:///C:/coffee-data.json',
    'ftp://example.com/bean',
    'https://user:password@example.com/bean',
    'http://localhost/bean',
    'http://127.0.0.1/bean',
    'http://[::1]/bean',
    'http://10.0.0.8/bean',
    'http://169.254.10.8/bean',
    'http://172.20.0.8/bean',
    'http://192.168.0.8/bean',
    'http://240.0.0.8/bean',
    'http://[fe80::8]/bean',
    'http://[fec0::8]/bean',
    'http://[::ffff:127.0.0.1]/bean',
    'http://[::127.0.0.1]/bean',
    'http://[::c0a8:1]/bean',
    'http://[64:ff9b::127.0.0.1]/bean',
    'https://example.com:22/bean',
  ])('rejects unsafe input %s before any request', (input) => {
    expect(() => validateExternalUrl(input)).toThrow(SafeUrlFetchError);
  });

  it('pins a verified public DNS address to the transport and refuses private DNS answers', async () => {
    const calls: Array<{ url: string; address: string }> = [];
    const transport: SafeFetchTransport = async ({ url, address }) => {
      calls.push({ url: url.toString(), address: address.address });
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<title>公开商品</title>' };
    };
    const fetcher = createSafeUrlFetcher({ lookup: async () => publicAddress, transport });
    await expect(fetcher.fetchHtml('https://example.com/bean')).resolves.toMatchObject({ finalUrl: 'https://example.com/bean' });
    expect(calls).toEqual([{ url: 'https://example.com/bean', address: '93.184.216.34' }]);

    const privateDns = createSafeUrlFetcher({ lookup: async () => [{ address: '10.0.0.8', family: 4 }], transport });
    await expect(privateDns.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'dns_not_public' });

    const mixedDns = createSafeUrlFetcher({ lookup: async () => [...publicAddress, { address: '172.16.0.8', family: 4 }], transport });
    await expect(mixedDns.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'dns_not_public' });

    const compatibleIpv6 = createSafeUrlFetcher({ lookup: async () => [{ address: '::127.0.0.1', family: 6 }], transport });
    await expect(compatibleIpv6.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'dns_not_public' });

    const reservedIpv4 = createSafeUrlFetcher({ lookup: async () => [{ address: '240.0.0.8', family: 4 }], transport });
    await expect(reservedIpv4.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'dns_not_public' });

    const siteLocalIpv6 = createSafeUrlFetcher({ lookup: async () => [{ address: 'fec0::8', family: 6 }], transport });
    await expect(siteLocalIpv6.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'dns_not_public' });
  });

  it('revalidates every redirect, rejects non-HTML and bounds response bytes', async () => {
    const redirectTransport: SafeFetchTransport = async ({ url }) => {
      if (url.hostname === 'example.com') {
        return { statusCode: 302, headers: { location: 'http://internal.example/private' }, body: '' };
      }
      return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<p>never</p>' };
    };
    const redirectFetcher = createSafeUrlFetcher({
      lookup: async (hostname) => hostname === 'internal.example'
        ? [{ address: '192.168.1.10', family: 4 }]
        : publicAddress,
      transport: redirectTransport,
    });
    await expect(redirectFetcher.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'dns_not_public' });

    const binaryFetcher = createSafeUrlFetcher({
      lookup: async () => publicAddress,
      transport: async () => ({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: 'not html' }),
    });
    await expect(binaryFetcher.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'content_type_not_html' });

    const largeFetcher = createSafeUrlFetcher({
      maxBytes: 12,
      lookup: async () => publicAddress,
      transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<p>this body is too long</p>' }),
    });
    await expect(largeFetcher.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'response_too_large' });

    const fileRedirect = createSafeUrlFetcher({
      lookup: async () => publicAddress,
      transport: async () => ({ statusCode: 302, headers: { location: 'file:///C:/coffee-data.json' }, body: '' }),
    });
    await expect(fileRedirect.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'url_protocol_not_allowed' });
  });

  it('uses one total deadline for stalled DNS and slow transports', async () => {
    const neverResolves = createSafeUrlFetcher({
      timeoutMs: 10,
      lookup: async () => new Promise(() => undefined),
    });
    await expect(neverResolves.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'request_timeout' });

    const slowTransport = createSafeUrlFetcher({
      timeoutMs: 10,
      lookup: async () => publicAddress,
      transport: async () => new Promise(() => undefined),
    });
    await expect(slowTransport.fetchHtml('https://example.com/bean')).rejects.toMatchObject({ code: 'request_timeout' });
  });

  it('rejects a truncated successful response immediately instead of waiting for the timeout', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-length': '128',
        'content-type': 'text/html; charset=utf-8',
      });
      response.flushHeaders();
      response.write('<p>partial');
      setImmediate(() => response.socket?.destroy());
    });
    openServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server.');

    const startedAt = Date.now();
    await expect(directTransport({
      url: new URL(`http://example.com:${address.port}/bean`),
      address: { address: '127.0.0.1', family: 4 },
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })).rejects.toMatchObject({ code: 'request_failed' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
