import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

export default async function globalSetup() {
  const expectedParent = resolve('test-results');
  const dataDirectory = resolve(expectedParent, `e2e-data-${process.pid}`);
  if (!dataDirectory.startsWith(`${expectedParent}\\`)) {
    throw new Error('拒绝使用 test-results 之外的端到端测试目录。');
  }
  await rm(dataDirectory, { recursive: true, force: true });
  await mkdir(dataDirectory, { recursive: true });

  const api = await buildApp({
    repository: new JsonRepository(dataDirectory),
    serveStatic: false,
    allowedOrigins: ['http://127.0.0.1:5194'],
  });
  await api.listen({ host: '127.0.0.1', port: 4194 });

  process.env.COFFEE_DASHBOARD_PORT = '4194';
  process.env.COFFEE_DASHBOARD_CLIENT_PORT = '5194';
  const client = await createServer({
    configFile: resolve('vite.config.ts'),
    server: { host: '127.0.0.1', port: 5194, strictPort: true },
  });
  await client.listen();

  return async () => {
    try {
      await client.close();
    } finally {
      try {
        await api.close();
      } finally {
        await rm(dataDirectory, { recursive: true, force: true });
      }
    }
  };
}
