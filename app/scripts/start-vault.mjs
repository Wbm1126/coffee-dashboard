// 按共享解析（环境变量 → app/.data-dir → 仓库 data/）启动生产服务，
// 使日常使用时应用数据落到 Syncthing 同步的 vault 数据目录。
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appRoot, resolveDataDir } from './lib/data-dir.mjs';

const serverEntry = resolve(appRoot, 'dist', 'server', 'start.js');
try {
  await access(serverEntry, constants.R_OK);
} catch {
  process.stderr.write('未找到 dist/server/start.js，请先运行 npm run build。\n');
  process.exit(1);
}

const { dataDir, source } = await resolveDataDir();
process.stdout.write(`数据目录: ${dataDir}（来源: ${source}）\n`);

const child = spawn(process.execPath, [serverEntry], {
  cwd: appRoot,
  env: { ...process.env, NODE_ENV: 'production', COFFEE_DASHBOARD_DATA_DIR: dataDir },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
