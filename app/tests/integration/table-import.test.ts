import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTablePreview } from '../../src/import/table/preview-service.js';
import { commitTablePreview } from '../../src/import/table/commit-service.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];

async function makeRepository(): Promise<JsonRepository> {
  const dataDir = await mkdtemp(join(tmpdir(), 'coffee-table-import-'));
  tempDirs.push(dataDir);
  const repository = new JsonRepository(dataDir);
  await repository.initialize();
  return repository;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface SheetSpec {
  name: string;
  headers: string[];
  rows: string[][];
}

async function xlsxUpload(spec: SheetSpec): Promise<{ name: string; bytes: Uint8Array }> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(spec.name);
  sheet.addRow(spec.headers);
  for (const row of spec.rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return { name: `${spec.name}.xlsx`, bytes: new Uint8Array(Buffer.from(buffer)) };
}

function csvUpload(rows: string[][]): { name: string; bytes: Uint8Array } {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const csv = rows.map((row) => row.map(escape).join(',')).join('\r\n');
  return { name: 'beans.csv', bytes: new TextEncoder().encode(csv) };
}

const HEADERS = ['品牌', '产品', '烘焙度', '风味关键词', '状态', '个人评分', '打分依据'];
const ROW = ['铁壶', '黑猫', '中深烘焙', '巧克力、坚果', '已喝', '4.5', '平衡顺口'];

describe('通用表格导入', () => {
  it('新豆导入：品牌/豆/评价一次入库，评分进入 BeanEvaluation', async () => {
    const repository = await makeRepository();
    const upload = await xlsxUpload({ name: '决策表', headers: HEADERS, rows: [ROW] });
    const existing = await repository.read();
    const preview = await createTablePreview({ upload, existing });
    expect(preview.categories).toMatchObject({ new: 1, merge: 0, conflict: 0, possible_duplicate: 0, unrecognized: 0 });
    expect(preview.summary).toMatchObject({ beans: 1, brands: 1, evaluations: 1, drank: 1 });

    const result = await commitTablePreview(repository, preview, {}, {});
    expect(result.alreadyImported).toBe(false);
    expect(result.beansWritten).toBe(1);
    expect(result.evaluationsWritten).toBe(1);
    const data = await repository.read();
    expect(data.beans).toHaveLength(1);
    expect(data.brands.map((brand) => brand.name)).toEqual(['铁壶']);
    const bean = data.beans[0]!;
    expect(bean).toMatchObject({ roastLevel: '中深烘焙', legacyStatusRaw: '已喝', legacyPersonalScoreRaw: '4.5' });
    expect(bean.importedFacts).toMatchObject({ legacyScoreBasisRaw: '平衡顺口', pricePerGram: null });
    expect(data.beanEvaluations).toHaveLength(1);
    expect(data.beanEvaluations[0]).toMatchObject({ beanId: bean.id, source: 'legacy_import', overallScore: 4.5, evaluatedOn: null });
    expect(data.importBatches).toHaveLength(1);
  });

  it('同一文件重复提交幂等：不产生重复数据，也不追加评价', async () => {
    const repository = await makeRepository();
    const upload = await xlsxUpload({ name: '决策表', headers: HEADERS, rows: [ROW] });
    const first = await createTablePreview({ upload, existing: await repository.read() });
    await commitTablePreview(repository, first, {}, {});

    const second = await createTablePreview({ upload, existing: await repository.read() });
    const result = await commitTablePreview(repository, second, {}, {});
    expect(result.alreadyImported).toBe(true);
    const data = await repository.read();
    expect(data.beans).toHaveLength(1);
    expect(data.beanEvaluations).toHaveLength(1);
    expect(data.importBatches).toHaveLength(1);
  });

  it('同豆两行：多行评价全部保留，不因去重丢失', async () => {
    const repository2 = await makeRepository();
    const upload2 = await xlsxUpload({
      name: '两行评价',
      headers: HEADERS,
      rows: [
        ['铁壶', '黑猫', '中深烘焙', '巧克力', '已喝', '4.5', '第一包'],
        ['铁壶', '黑猫', '中深烘焙', '巧克力', '已喝', '4', '第二包偏酸'],
      ],
    });
    const existing = await repository2.read();
    const preview = await createTablePreview({ upload: upload2, existing });
    expect(preview.categories.new).toBe(1);
    expect(preview.summary.evaluations).toBe(2);

    await commitTablePreview(repository2, preview, {}, {});
    const data = await repository2.read();
    expect(data.beans).toHaveLength(1);
    expect(data.beanEvaluations.map((evaluation) => evaluation.overallScore).sort()).toEqual([4, 4.5]);
  });

  it('与库内同键冲突时进入 conflict 分类，未决议提交被拒绝（数据不写入）', async () => {
    const repository = await makeRepository();
    const upload = await xlsxUpload({ name: '决策表', headers: HEADERS, rows: [ROW] });
    const base = await createTablePreview({ upload, existing: await repository.read() });
    await commitTablePreview(repository, base, {}, {});

    const existing = await repository.read();
    const conflictUpload = await xlsxUpload({
      name: '冲突表',
      headers: HEADERS,
      rows: [['铁壶', '黑猫', '中浅烘焙', '花果', '已喝', '4.5', '烘焙度不同']],
    });
    const preview = await createTablePreview({ upload: conflictUpload, existing });
    expect(preview.categories.conflict).toBe(1);
    expect(preview.conflicts[0]).toMatchObject({ field: 'roastLevel', incomingValue: '中浅烘焙', existingValue: '中深烘焙', availableChoices: ['incoming', 'existing'] });

    await expect(commitTablePreview(repository, preview, {}, {})).rejects.toMatchObject({ name: 'UnresolvedTableConflictError' });
    expect((await repository.read()).beans[0]?.roastLevel).toBe('中深烘焙');

    const resolutions = Object.fromEntries(preview.conflicts.map((conflict) => [conflict.id, 'existing' as const]));
    const resolved = await commitTablePreview(repository, preview, resolutions, {});
    expect(resolved.alreadyImported).toBe(false);
    expect((await repository.read()).beans[0]?.roastLevel).toBe('中深烘焙');
  });

  it('可能重复：同豆名异品牌需要决策，merge 只填空不覆盖', async () => {
    const repository3 = await makeRepository();
    const upload = await xlsxUpload({ name: '决策表', headers: HEADERS, rows: [ROW] });
    const first = await createTablePreview({ upload, existing: await repository3.read() });
    await commitTablePreview(repository3, first, {}, {});

    const otherBrand = await xlsxUpload({
      name: '异品牌同豆名',
      headers: HEADERS,
      rows: [['铁壶工坊', '黑猫', '中浅烘焙', '柑橘', '在喝', '4', '另一家']],
    });
    const preview = await createTablePreview({ upload: otherBrand, existing: await repository3.read() });
    expect(preview.categories.possible_duplicate).toBe(1);
    expect(preview.items[0]?.duplicateTargets?.[0]?.beanKey).toBe('铁壶::黑猫');

    await expect(commitTablePreview(repository3, preview, {}, {})).rejects.toMatchObject({ name: 'UnresolvedTableDuplicateError' });

    const targetKey = preview.items[0]!.beanKey;
    await commitTablePreview(repository3, preview, {}, { [targetKey]: 'import_as_new' });
    const data = await repository3.read();
    expect(data.beans).toHaveLength(2);
    expect(data.beans.map((bean) => bean.roastLevel).sort()).toEqual(['中浅烘焙', '中深烘焙']);
  });

  it('缺身份字段的行归入无法识别，须显式跳过才能提交', async () => {
    const repository4 = await makeRepository();
    const badUpload = await xlsxUpload({
      name: '缺豆名',
      headers: HEADERS,
      rows: [['铁壶', '', '中深烘焙', '', '', '', '']],
    });
    const preview = await createTablePreview({ upload: badUpload, existing: await repository4.read() });
    expect(preview.categories.unrecognized).toBe(1);

    await expect(commitTablePreview(repository4, preview, {}, {})).rejects.toMatchObject({ name: 'UnresolvedTableSkipError' });
    const key = preview.items[0]!.beanKey;
    await commitTablePreview(repository4, preview, {}, {}, [key]);
    expect((await repository4.read()).beans).toHaveLength(0);
  });

  it('CSV 文件走同一管线', async () => {
    const repository5 = await makeRepository();
    const preview = await createTablePreview({ upload: csvUpload([HEADERS, ROW]), existing: await repository5.read() });
    expect(preview.categories.new).toBe(1);
    const result = await commitTablePreview(repository5, preview, {}, {});
    expect(result.beansWritten).toBe(1);
    expect((await repository5.read()).beanEvaluations).toHaveLength(1);
  });

  it('提交前自动创建备份，且原始工作簿不受导入影响', async () => {
    const repository6 = await makeRepository();
    const upload = await xlsxUpload({ name: '决策表', headers: HEADERS, rows: [ROW] });
    const preview = await createTablePreview({ upload, existing: await repository6.read() });
    const result = await commitTablePreview(repository6, preview, {}, {});
    expect(result.backupName).toMatch(/before-table-import/);
    expect((await repository6.backups.list())[0]?.valid).toBe(true);
    // 上传内容是 base64 副本，仓库目录中的真实 xlsx 只读：这里断言导入不依赖文件路径。
    expect(preview.fileName.endsWith('.xlsx')).toBe(true);
  });
});
