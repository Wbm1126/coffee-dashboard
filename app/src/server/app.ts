import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { JsonRepository } from '../storage/json-repository.js';
import { installLocalSecurity } from './local-security.js';
import { registerImportRoutes } from './routes/import.js';
import { registerTableImportRoutes } from './routes/table-import.js';
import { registerDrinkingRoutes } from './routes/drinking.js';
import { registerPurchaseRoutes } from './routes/purchases.js';
import { registerBeanRoutes } from './routes/beans.js';
import { registerRecommendationRoutes } from './routes/recommendations.js';
import { registerCollectionRoutes } from './routes/collect.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerImageRoutes } from '../collectors/image-cache.js';
import type { CollectionService } from '../collectors/service.js';

export interface BuildAppOptions {
  repository: JsonRepository;
  staticRoot?: string;
  serveStatic?: boolean;
  allowedOrigins?: string[];
  csrfToken?: string;
  collectionService?: CollectionService;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_000_000,
  });
  const csrfToken = installLocalSecurity(app, {
    allowedOrigins: options.allowedOrigins,
    csrfToken: options.csrfToken,
  });

  const initialInspection = await options.repository.initialize();

  app.get('/api/health', async () => ({
    ok: true,
    mode: initialInspection.mode,
  }));

  app.get('/api/session', async () => ({ csrfToken }));

  app.get('/api/snapshot', async (_request, reply) => {
    const inspection = await options.repository.inspect();
    if (inspection.mode === 'ready') return inspection;
    return reply.code(503).send(inspection);
  });

  app.get('/api/recovery', async () => options.repository.inspect());

  app.post('/api/recovery/restore', async (request, reply) => {
    const parsed = z.object({ backupName: z.string().min(1).max(300) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_backup_name' });
    }
    const inspection = await options.repository.restoreBackup(parsed.data.backupName);
    return reply.code(200).send(inspection);
  });

  registerImportRoutes(app, options.repository);
  registerTableImportRoutes(app, options.repository);
  registerDrinkingRoutes(app, options.repository);
  registerPurchaseRoutes(app, options.repository);
  registerBeanRoutes(app, options.repository);
  registerRecommendationRoutes(app, options.repository);
  registerCollectionRoutes(app, options.repository, options.collectionService);
  registerExportRoutes(app, options.repository);
  registerImageRoutes(app, options.repository.dataDir);

  if (options.serveStatic !== false && options.staticRoot && existsSync(options.staticRoot)) {
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
