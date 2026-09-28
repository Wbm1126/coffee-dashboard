import { resolve } from 'node:path';
import { appRoot, resolveDataDir } from './data-dir.js';
import { JsonRepository } from '../storage/json-repository.js';
import { buildApp } from './app.js';

const { dataDir } = await resolveDataDir();
const port = Number.parseInt(process.env.COFFEE_DASHBOARD_PORT ?? '4173', 10);
const clientPort = Number.parseInt(process.env.COFFEE_DASHBOARD_CLIENT_PORT ?? '5173', 10);
const devOrigins =
  process.env.NODE_ENV === 'development'
    ? [`http://127.0.0.1:${clientPort}`, `http://localhost:${clientPort}`]
    : [];
// 反向代理部署时经 nginx 传入的 Host 非回环，需显式放行；未设置时保持仅回环可用。
const allowedHosts = (process.env.COFFEE_DASHBOARD_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

const app = await buildApp({
  repository: new JsonRepository(dataDir),
  staticRoot: resolve(appRoot, 'dist', 'client'),
  allowedOrigins: devOrigins,
  allowedHosts,
});

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`豆迹已启动：http://127.0.0.1:${port}\n数据目录: ${dataDir}\n`);

const close = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);
