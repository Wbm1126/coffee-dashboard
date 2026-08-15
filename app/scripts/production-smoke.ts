import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配生产冒烟测试端口。');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

const dataDir = await mkdtemp(resolve(tmpdir(), 'coffee-production-smoke-'));
const port = await freePort();
const child = spawn(process.execPath, ['dist/server/start.js'], {
  cwd: resolve('.'),
  env: { ...process.env, NODE_ENV: 'production', COFFEE_DASHBOARD_DATA_DIR: dataDir, COFFEE_DASHBOARD_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += String(chunk); });
child.stderr.on('data', (chunk) => { output += String(chunk); });

try {
  const deadline = Date.now() + 15_000;
  let health: Response | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`生产服务提前退出 (${child.exitCode})：${output}`);
    try {
      health = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (health.ok) break;
    } catch {
      // The service may still be binding the local port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!health?.ok) throw new Error(`生产服务未在期限内就绪：${output}`);
  const healthBody = await health.json() as { ok?: boolean; mode?: string };
  if (!healthBody.ok || healthBody.mode !== 'ready') throw new Error(`生产健康检查异常：${JSON.stringify(healthBody)}`);

  const home = await fetch(`http://127.0.0.1:${port}/`);
  const html = await home.text();
  if (!home.ok || !home.headers.get('content-type')?.includes('text/html') || !html.includes('<div id="root">')) {
    throw new Error('生产静态页面未正确提供。');
  }
  await access(resolve(dataDir, 'coffee-data.json'));
  await access(resolve(dataDir, 'coffee-data.revision.json'));
  process.stdout.write(`Production smoke passed on 127.0.0.1:${port}\n`);
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(dataDir, { recursive: true, force: true });
}
