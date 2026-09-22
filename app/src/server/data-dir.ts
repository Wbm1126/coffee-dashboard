import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 无论本文件从 src（tsx 直跑）还是 dist 运行，向上三级都是仓库根。
export const coffeeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const appRoot = resolve(coffeeRoot, 'app');

export interface DataDirResolution {
  dataDir: string;
  source: string;
}

// 数据目录解析的唯一权威实现。优先级：
// 1. 环境变量 COFFEE_DASHBOARD_DATA_DIR（发布版 launcher 走这里）；
// 2. app/.data-dir（本机 git 忽略配置，指向 Syncthing 同步的 vault 数据目录，相对路径相对 app 根解析）；
// 3. 仓库默认 data/。
export async function resolveDataDir(): Promise<DataDirResolution> {
  if (process.env.COFFEE_DASHBOARD_DATA_DIR) {
    return {
      dataDir: resolve(process.env.COFFEE_DASHBOARD_DATA_DIR),
      source: '环境变量 COFFEE_DASHBOARD_DATA_DIR',
    };
  }
  let configured = '';
  try {
    configured = (await readFile(resolve(appRoot, '.data-dir'), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw new Error(`读取 app/.data-dir 失败：${String(error)}`);
    }
  }
  if (configured) {
    return { dataDir: resolve(appRoot, configured), source: 'app/.data-dir' };
  }
  return { dataDir: resolve(coffeeRoot, 'data'), source: '仓库默认 data/' };
}
