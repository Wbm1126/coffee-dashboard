// U8 发布回归：用当前构建对「U0 备份的 v1 空库」与「vault 现网 v2 数据」分别做升级/读取验证。用后即删。
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/storage/json-repository.js';

const u0Backup = 'D:/obsidian-vault/30-私人内容/咖啡豆/data-backups/2026-09-22-U0基线/coffee-data.json';
const liveData = 'D:/obsidian-vault/30-私人内容/咖啡豆/data/coffee-data.json';

// 场景 A：v1 备份 → 当前构建迁移 → v2 ready
const dirA = await mkdtemp(join(tmpdir(), 'u8-regress-v1-'));
const repoA = new JsonRepository(dirA);
await copyFile(u0Backup, join(dirA, 'coffee-data.json'));
const inspectionA = await repoA.initialize();
const dataA = await repoA.read();
const v1Bytes = JSON.parse(await readFile(join(dirA, 'backups', (await repoA.backups.list())[0]!.name), 'utf8')) as { schemaVersion: number };

// 场景 B：现网 v2 数据（42 豆）→ 当前构建直接读取并再次校验
const dirB = await mkdtemp(join(tmpdir(), 'u8-regress-v2-'));
const repoB = new JsonRepository(dirB);
await copyFile(liveData, join(dirB, 'coffee-data.json'));
const inspectionB = await repoB.initialize();
const dataB = await repoB.read();

console.log(JSON.stringify({
  A_v1迁移: { mode: inspectionA.mode, schemaVersion: dataA.schemaVersion, migrationBackupHeldV1: v1Bytes.schemaVersion },
  B_v2现网: { mode: inspectionB.mode, schemaVersion: dataB.schemaVersion, beans: dataB.beans.length, brands: dataB.brands.length, evaluations: dataB.beanEvaluations.length, drank: dataB.beans.filter((bean) => (bean.legacyStatusRaw ?? '').includes('已喝')).length },
}, null, 2));

await rm(dirA, { recursive: true, force: true });
await rm(dirB, { recursive: true, force: true });
