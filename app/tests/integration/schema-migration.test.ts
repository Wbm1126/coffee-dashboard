import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
const NOW = '2026-08-06T13:24:33.686Z';
const BRAND_ID = '00000000-0000-4000-8000-000000000101';
const BEAN_ID = '00000000-0000-4000-8000-000000000201';
const SOURCE_ID = '00000000-0000-4000-8000-000000000301';
const RECORD_ID = '00000000-0000-4000-8000-000000000401';

// 按真实磁盘上 v1 数据的形状构造：缺 acidityPreference / legacy* / collectionOperations 等后加键。
function v1Document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    dataRevision: 12,
    updatedAt: NOW,
    brands: [
      { id: BRAND_ID, name: '铁壶', aliases: [], archivedAt: null, createdAt: NOW, updatedAt: NOW },
    ],
    beans: [
      {
        id: BEAN_ID, brandId: BRAND_ID, name: '黑猫', normalizedKey: '黑猫',
        roastLevel: '中浅', process: '水洗', flavorNotes: ['茉莉'],
        followedAt: null, archivedAt: null, isDraft: false,
        legacyStatusRaw: '已喝', legacyPersonalScoreRaw: '4.5', provenance: {},
        createdAt: NOW, updatedAt: NOW,
      },
    ],
    productSources: [
      { id: SOURCE_ID, beanId: BEAN_ID, url: 'https://example.com/hei-mao', title: null, capturedAt: NOW, fields: {} },
    ],
    purchases: [],
    purchaseItems: [],
    drinkingRecords: [
      {
        id: RECORD_ID, beanId: BEAN_ID, purchaseItemId: null, drankOn: '2026-08-01',
        brewMethod: 'americano', extractionNote: '15g，手冲一刀流', feeling: '干净，回甘明显',
        americanoReview: { state: 'reviewed', score: 4, flavorNotes: ['柑橘'], pros: '酸质明亮', cons: null, note: null },
        milkReview: null, draftAssessment: null, isDraft: false, deletedAt: null,
        createdAt: NOW, updatedAt: NOW,
      },
    ],
    assessments: [],
    preferenceProfile: {
      brewMode: 'balanced', roastLevels: [], flavorNotes: [], avoidedFlavorNotes: [],
      maxPricePer100g: null, updatedAt: null,
    },
    recommendationSnapshots: [],
    importBatches: [],
    exportSnapshots: [],
    ...overrides,
  };
}

async function repositoryWithRawDocument(raw: unknown): Promise<JsonRepository> {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-schema-migration-'));
  tempDirs.push(dataDir);
  const repository = new JsonRepository(dataDir);
  await writeFile(repository.dataFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return repository;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Schema v1→v2 迁移', () => {
  it('空库初始化即为 v2，包含 beanEvaluations 空容器', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coffee-schema-empty-'));
    tempDirs.push(dataDir);
    const repository = new JsonRepository(dataDir);

    const inspection = await repository.initialize();

    expect(inspection.mode).toBe('ready');
    if (inspection.mode === 'ready') {
      expect(inspection.data.schemaVersion).toBe(2);
      expect(inspection.data.beanEvaluations).toEqual([]);
    }
  });

  it('打开 v1 数据：先备份原始字节，再自动迁移且事实完整保留', async () => {
    const repository = await repositoryWithRawDocument(v1Document());

    const inspection = await repository.initialize();

    expect(inspection.mode).toBe('ready');
    if (inspection.mode !== 'ready') throw new Error('v1 数据应迁移成功');

    expect(inspection.data.schemaVersion).toBe(2);
    expect(inspection.data.beanEvaluations).toEqual([]);
    const bean = inspection.data.beans[0];
    expect(bean).toMatchObject({ name: '黑猫', roastLevel: '中浅', legacyPersonalScoreRaw: '4.5' });
    const record = inspection.data.drinkingRecords[0];
    expect(record).toMatchObject({ extractionNote: '15g，手冲一刀流', brewParams: null });
    expect(record?.americanoReview).toMatchObject({ state: 'reviewed', score: 4 });
    expect(inspection.data.productSources[0]).toMatchObject({ imageUrl: null, localImagePath: null, imageSource: null });

    const backups = await repository.backups.list();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ valid: true, name: expect.stringContaining('schema-migration') });
    const backupRaw = JSON.parse((await readFile(join(repository.backups.backupDir, backups[0]!.name), 'utf8')) as string);
    expect(backupRaw.schemaVersion).toBe(1);
    expect(backupRaw.beans[0]).toMatchObject({ name: '黑猫' });

    const persisted = JSON.parse(await readFile(repository.dataFile, 'utf8')) as { schemaVersion: number };
    expect(persisted.schemaVersion).toBe(2);
  });

  it('重复打开已迁移数据不产生新的迁移备份，数据保持稳定', async () => {
    const repository = await repositoryWithRawDocument(v1Document());
    const first = await repository.initialize();
    expect(await repository.backups.list()).toHaveLength(1);

    const second = await repository.initialize();

    // inspect 的 backups 快照取自读取前，直接比较数据本体：已迁移文档不得再被改动。
    if (first.mode !== 'ready' || second.mode !== 'ready') throw new Error('两次打开都应是 ready');
    expect(second.data).toEqual(first.data);
    expect(await repository.backups.list()).toHaveLength(1);
  });

  it('损坏 JSON 进入 recovery，不写迁移备份且不改动原文件', async () => {
    const damaged = '{damaged';
    const repository = await repositoryWithRawDocument(damaged);
    await writeFile(repository.dataFile, damaged, 'utf8');

    const inspection = await repository.initialize();

    expect(inspection.mode).toBe('recovery');
    expect(await repository.backups.list()).toHaveLength(0);
    expect(await readFile(repository.dataFile, 'utf8')).toBe(damaged);
  });

  it('v1 内容非法时迁移失败进 recovery：原文件与迁移前备份保留，非法备份恢复被拒绝', async () => {
    const repository = await repositoryWithRawDocument(v1Document({ beans: 'not-an-array' }));

    const inspection = await repository.initialize();
    expect(inspection.mode).toBe('recovery');

    const backups = await repository.backups.list();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ valid: true });
    expect(JSON.parse(await readFile(repository.dataFile, 'utf8'))).toMatchObject({ schemaVersion: 1 });

    await expect(repository.restoreBackup(backups[0]!.name)).rejects.toThrow();
    expect(await readFile(repository.dataFile, 'utf8')).toContain('not-an-array');
  });

  it('恢复合法的 v1 备份时自动迁移为 v2', async () => {
    const repository = await repositoryWithRawDocument(v1Document());
    await repository.initialize();
    const v1Backup = (await repository.backups.list())[0]!.name;
    await writeFile(repository.dataFile, '{damaged', 'utf8');

    const restored = await repository.restoreBackup(v1Backup);

    expect(restored.mode).toBe('ready');
    if (restored.mode === 'ready') {
      expect(restored.data.schemaVersion).toBe(2);
      expect(restored.data.beanEvaluations).toEqual([]);
      expect(restored.data.beans[0]).toMatchObject({ name: '黑猫' });
    }
  });

  it('高版本数据保持只读，不触发迁移备份', async () => {
    const repository = await repositoryWithRawDocument({ schemaVersion: 99 });

    const inspection = await repository.initialize();

    expect(inspection).toMatchObject({ mode: 'read_only', schemaVersion: 99 });
    expect(await repository.backups.list()).toHaveLength(0);
  });

  it('迁移后的 v2 文档可写入 BeanEvaluation、冲煮参数与商品图片', async () => {
    const repository = await repositoryWithRawDocument(v1Document());
    await repository.initialize();

    const next = await repository.mutate(12, (draft) => {
      draft.beanEvaluations.push({
        id: '00000000-0000-4000-8000-000000000501',
        beanId: BEAN_ID,
        source: 'manual',
        evaluatedOn: null,
        brewMethod: 'americano',
        americanoReview: null,
        milkReview: null,
        overallScore: 4.5,
        flavorNotes: ['茉莉', '柑橘'],
        pros: '香气清晰',
        cons: null,
        summary: '值得回购的中浅烘。',
        repurchase: 'yes',
        sourceRecordId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const record = draft.drinkingRecords[0];
      if (record) record.brewParams = { doseGrams: 15, temperatureC: 92, grindSetting: '中细' };
      const source = draft.productSources[0];
      if (source) source.imageUrl = 'https://example.com/hei-mao.jpg';
    });

    expect(next.beanEvaluations).toHaveLength(1);
    const reread = await repository.read();
    expect(reread.beanEvaluations[0]).toMatchObject({ overallScore: 4.5, evaluatedOn: null });
    expect(reread.drinkingRecords[0]?.brewParams).toMatchObject({ doseGrams: 15, temperatureC: 92, grindSetting: '中细', yieldGrams: null });
    expect(reread.productSources[0]?.imageUrl).toBe('https://example.com/hei-mao.jpg');
  });

  it('drinking 来源的 BeanEvaluation 缺少来源记录时拒绝保存', async () => {
    const repository = await repositoryWithRawDocument(v1Document());
    await repository.initialize();

    await expect(
      repository.mutate(12, (draft) => {
        draft.beanEvaluations.push({
          id: '00000000-0000-4000-8000-000000000502',
          beanId: BEAN_ID,
          source: 'drinking',
          evaluatedOn: '2026-08-01',
          brewMethod: null,
          americanoReview: null,
          milkReview: null,
          overallScore: 4,
          flavorNotes: [],
          pros: null,
          cons: null,
          summary: null,
          repurchase: null,
          sourceRecordId: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }),
    ).rejects.toThrow(/关联对应记录/);
  });
});
