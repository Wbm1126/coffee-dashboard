// U8 发布回归：对「U0 备份的 v1 空库」与「现网 v2 数据」分别做升级/读取验证，未达预期即非零退出。
// 用法：npx tsx scripts/u8-release-regression.ts <U0备份coffee-data.json> <现网coffee-data.json>
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/storage/json-repository.js';
import { normalizeLegacyStatus } from '../src/domain/legacy-status.js';
import { CURRENT_SCHEMA_VERSION } from '../src/domain/schema.js';

const [u0Backup, liveData] = process.argv.slice(2);
if (!u0Backup || !liveData) {
  console.error('用法：npx tsx scripts/u8-release-regression.ts <U0备份coffee-data.json> <现网coffee-data.json>');
  process.exit(1);
}

const dirA = await mkdtemp(join(tmpdir(), 'u8-regress-v1-'));
const dirB = await mkdtemp(join(tmpdir(), 'u8-regress-v2-'));

try {
  // 场景 A：v1 备份 → 当前构建迁移 → v2 ready，且迁移备份保留 v1 字节。
  const repoA = new JsonRepository(dirA);
  await copyFile(u0Backup, join(dirA, 'coffee-data.json'));
  const inspectionA = await repoA.initialize();
  const dataA = await repoA.read();
  const backupName = (await repoA.backups.list())[0]?.name;
  if (!backupName) throw new Error('迁移未产生备份文件，无法校验备份内容');
  const v1Bytes = JSON.parse(await readFile(join(repoA.backups.backupDir, backupName), 'utf8')) as { schemaVersion: number };

  // 场景 B：现网 v2 数据（42 豆）→ 当前构建直接读取并再次校验。
  const repoB = new JsonRepository(dirB);
  await copyFile(liveData, join(dirB, 'coffee-data.json'));
  const inspectionB = await repoB.initialize();
  const dataB = await repoB.read();

  const report = {
    A_v1迁移: { mode: inspectionA.mode, schemaVersion: dataA.schemaVersion, migrationBackupHeldV1: v1Bytes.schemaVersion },
    B_v2现网: {
      mode: inspectionB.mode, schemaVersion: dataB.schemaVersion, beans: dataB.beans.length, brands: dataB.brands.length,
      evaluations: dataB.beanEvaluations.length,
      drank: dataB.beans.filter((bean) => normalizeLegacyStatus(bean.legacyStatusRaw) === 'drank').length,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  const failed: string[] = [];
  if (inspectionA.mode !== 'ready' || dataA.schemaVersion !== CURRENT_SCHEMA_VERSION || v1Bytes.schemaVersion !== 1) failed.push('A_v1迁移');
  if (inspectionB.mode !== 'ready' || dataB.schemaVersion !== CURRENT_SCHEMA_VERSION || dataB.beans.length !== 42
    || dataB.brands.length !== 15 || dataB.beanEvaluations.length !== 6) failed.push('B_v2现网');
  if (failed.length) {
    console.error(`\n${failed.length} 项未达预期：${failed.join('、')}`);
    process.exitCode = 1;
  }
} finally {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
}
