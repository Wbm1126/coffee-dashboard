import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright';
import { resolveDataDir } from '../src/server/data-dir.js';

// 与服务端共用同一套解析：环境变量 → app/.data-dir → 仓库 data/。
let dataDir = '';
let dataDirSource = '';
let resolveError: unknown = null;
try {
  const resolution = await resolveDataDir();
  dataDir = resolution.dataDir;
  dataDirSource = resolution.source;
} catch (error) {
  resolveError = error;
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
checks.push({
  name: 'Node.js',
  ok: nodeMajor >= 22,
  detail: `${process.versions.node}（推荐 24 LTS，最低 22.12）`,
});

if (resolveError) {
  checks.push({ name: '数据目录', ok: false, detail: String(resolveError) });
} else {
  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.R_OK | constants.W_OK);
    checks.push({ name: '数据目录', ok: true, detail: `${dataDir}（来源: ${dataDirSource}）` });
  } catch (error) {
    checks.push({ name: '数据目录', ok: false, detail: String(error) });
  }
}

try {
  const executable = chromium.executablePath();
  await access(executable, constants.X_OK);
  checks.push({ name: 'Chromium', ok: true, detail: executable });
} catch {
  checks.push({
    name: 'Chromium',
    ok: false,
    detail: '未找到与 Playwright 匹配的 Chromium；请运行 npm run setup。',
  });
}

for (const check of checks) {
  const mark = check.ok ? '✓' : '✗';
  process.stdout.write(`${mark} ${check.name}: ${check.detail}\n`);
}

if (checks.some((check) => !check.ok)) {
  process.exitCode = 1;
}

