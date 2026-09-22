import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
// 配置文件存在但读取失败（权限、指向文件等）时直接抛错，不得静默回退掩盖配置错误。
export async function resolveDataDir(): Promise<DataDirResolution> {
  if (process.env.COFFEE_DASHBOARD_DATA_DIR) {
    const envValue = process.env.COFFEE_DASHBOARD_DATA_DIR;
    rejectParentSegments(envValue, '环境变量 COFFEE_DASHBOARD_DATA_DIR');
    const dataDir = resolve(appRoot, envValue);
    await assertExistingDir(dataDir, '环境变量 COFFEE_DASHBOARD_DATA_DIR');
    return {
      dataDir,
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
    rejectParentSegments(configured, 'app/.data-dir');
    const dataDir = resolve(appRoot, configured);
    if (!isAbsolute(configured) && relative(appRoot, dataDir).startsWith('..')) {
      throw new Error(`app/.data-dir 相对路径不得逃逸 app 根目录：${configured}`);
    }
    await assertExistingDir(dataDir, 'app/.data-dir');
    return { dataDir, source: 'app/.data-dir' };
  }
  return { dataDir: resolve(appRoot, '..', 'data'), source: '仓库默认 data/' };
}

function rejectParentSegments(value: string, sourceLabel: string): void {
  if (value.split(/[\\/]+/).includes('..')) {
    throw new Error(`${sourceLabel} 路径不允许包含 .. 段：${value}`);
  }
}

async function assertExistingDir(dataDir: string, sourceLabel: string): Promise<void> {
  const info = await stat(dataDir).catch(() => null);
  if (!info) {
    throw new Error(`${sourceLabel} 指向的目录不存在：${dataDir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${sourceLabel} 指向的不是目录：${dataDir}`);
  }
}
