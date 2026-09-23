// U7 商品图片本地缓存：受限下载（SSRF 防护/2MB 上限/仅 image/*）→ 原子落盘到数据目录 images/。
// 一切失败都由调用方吞掉：图片缺失只影响陈列观感，绝不影响任何业务流程。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createSafeUrlFetcher } from './url-policy.js';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

const fetcher = createSafeUrlFetcher({ maxBytes: 2_000_000, timeoutMs: 10_000 });

export function imagesDir(dataDir: string): string {
  return join(dataDir, 'images');
}

/** 校验客户端请求的图片文件名（8 位十六进制 + 已知扩展名），防止路径穿越。 */
export function isSafeImageName(name: string): boolean {
  return /^[0-9a-f]{8}\.(jpg|png|webp|avif)$/i.test(name);
}

/** 校验并解析图片文件的绝对路径；文件名不合法时返回 null（HTTP 层据此 404）。 */
export function resolveImageFile(dataDir: string, name: string): string | null {
  if (!isSafeImageName(name)) return null;
  return join(imagesDir(dataDir), name);
}

// U7 本地图片服务：文件名先过白名单（8 位十六进制 + 已知扩展），路径解析与校验都收敛在本模块。
export function registerImageRoutes(app: FastifyInstance, dataDir: string): void {
  app.get('/api/images/:name', async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? '';
    const file = resolveImageFile(dataDir, name);
    if (!file) return reply.code(404).send({ error: 'image_not_found' });
    try {
      const bytes = await readFile(file);
      const extension = name.slice(-4).toLowerCase();
      const contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.avif' ? 'image/avif' : 'image/jpeg';
      return reply.header('content-type', contentType).header('cache-control', 'public, max-age=31536000, immutable').send(bytes);
    } catch {
      return reply.code(404).send({ error: 'image_not_found' });
    }
  });
}

export async function cacheProductImage(options: { dataDir: string; imageUrl: string }): Promise<string | null> {
  try {
    const resource = await fetcher.fetchResource(options.imageUrl, Object.keys(IMAGE_CONTENT_TYPES));
    const contentType = Object.keys(IMAGE_CONTENT_TYPES).find((type) => resource.contentType.includes(type)) ?? '';
    const extension = IMAGE_CONTENT_TYPES[contentType] ?? '.img';
    const name = `${createHash('sha256').update(resource.body).digest('hex').slice(0, 8)}${extension}`;
    if (!isSafeImageName(name)) return null;
    const dir = imagesDir(options.dataDir);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await writeFile(temporary, resource.body);
    await rename(temporary, join(dir, name));
    return name;
  } catch {
    return null;
  }
}
