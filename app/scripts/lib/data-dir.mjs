// 数据目录解析的唯一实现：COFFEE_DASHBOARD_DATA_DIR 环境变量 → app/.data-dir 配置文件 → 仓库 data/。
// doctor 与 start:vault 共用，保证检查与运行看到同一个目录。
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function resolveDataDir() {
  if (process.env.COFFEE_DASHBOARD_DATA_DIR) {
    return { dataDir: resolve(process.env.COFFEE_DASHBOARD_DATA_DIR), source: '环境变量 COFFEE_DASHBOARD_DATA_DIR' };
  }
  try {
    const configured = (await readFile(resolve(appRoot, '.data-dir'), 'utf8')).trim();
    if (configured) return { dataDir: resolve(configured), source: 'app/.data-dir' };
  } catch {
    // 未配置时回退仓库默认目录。
  }
  return { dataDir: resolve(appRoot, '..', 'data'), source: '仓库默认 data/' };
}
