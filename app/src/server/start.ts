import { resolve } from 'node:path';
import { appRoot, resolveDataDir } from './data-dir.js';
import { JsonRepository } from '../storage/json-repository.js';
import { buildApp } from './app.js';
import { ADMIN_USERNAME } from './auth.js';

const { dataDir } = await resolveDataDir();
const port = Number.parseInt(process.env.COFFEE_DASHBOARD_PORT ?? '4173', 10);
const clientPort = Number.parseInt(process.env.COFFEE_DASHBOARD_CLIENT_PORT ?? '5173', 10);
const devOrigins =
  process.env.NODE_ENV === 'development'
    ? [`http://127.0.0.1:${clientPort}`, `http://localhost:${clientPort}`]
    : [];
// 反向代理部署时经 nginx 传入的 Host 非回环，需显式放行；未设置时保持仅回环可用。
// 配置项与请求侧同样去掉尾部端口后再比对。
const allowedHosts = (process.env.COFFEE_DASHBOARD_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().replace(/:\d{1,5}$/, ''))
  .filter(Boolean);

const adminPassword = process.env.COFFEE_DASHBOARD_ADMIN_PASSWORD?.trim();

const app = await buildApp({
  repository: new JsonRepository(dataDir),
  staticRoot: resolve(appRoot, 'dist', 'client'),
  allowedOrigins: devOrigins,
  allowedHosts,
  // 设置了管理密码即进入强制模式（访客只读）；未设置保持本地单用户。
  adminAuth: adminPassword ? { username: ADMIN_USERNAME, password: adminPassword } : undefined,
});

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`豆迹已启动：http://127.0.0.1:${port}\n数据目录: ${dataDir}\n`);

const close = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);
