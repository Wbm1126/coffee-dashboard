import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRepository } from '../storage/json-repository.js';
import { buildApp } from './app.js';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const coffeeRoot = resolve(sourceDir, '..', '..', '..');
const appRoot = resolve(coffeeRoot, 'app');
const repository = new JsonRepository(resolve(process.env.COFFEE_DASHBOARD_DATA_DIR ?? resolve(coffeeRoot, 'data')));
const port = Number.parseInt(process.env.COFFEE_DASHBOARD_PORT ?? '4173', 10);
const clientPort = Number.parseInt(process.env.COFFEE_DASHBOARD_CLIENT_PORT ?? '5173', 10);
const devOrigins =
  process.env.NODE_ENV === 'development'
    ? [`http://127.0.0.1:${clientPort}`, `http://localhost:${clientPort}`]
    : [];

const app = await buildApp({
  repository,
  staticRoot: resolve(appRoot, 'dist', 'client'),
  allowedOrigins: devOrigins,
});

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`豆迹已启动：http://127.0.0.1:${port}\n`);

const close = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);
