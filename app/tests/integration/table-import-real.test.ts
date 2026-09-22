import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import { createTablePreview } from '../../src/import/table/preview-service.js';
import { commitTablePreview } from '../../src/import/table/commit-service.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import type { TableUpload } from '../../src/import/table/preview-service.js';

// 与 v1.0 的 import-real-workbooks.test.ts 相同约定：两份真实 xlsx 放仓库根（git 忽略，只读）。
const projectDir = join(import.meta.dirname, '..', '..', '..');
const completePath = join(projectDir, '意式咖啡豆_完整版.xlsx');
const selectionPath = join(projectDir, '意式咖啡豆_选单.xlsx');
const sourcesAvailable = existsSync(completePath) && existsSync(selectionPath);

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.runIf(sourcesAvailable)('真实两份工作簿 · 通用导入器 dry-run（§7 基线）', () => {
  it('完整版 42 豆全为新豆；选单合并 42 键且仅 2 处烘焙冲突；基线计数与 summary.md 一致', async () => {
    const [completeBytes, selectionBytes] = await Promise.all([readFile(completePath), readFile(selectionPath)]);
    const before = [sha256(completeBytes), sha256(selectionBytes)];
    const complete: TableUpload = { name: '意式咖啡豆_完整版.xlsx', bytes: new Uint8Array(completeBytes) };
    const selection: TableUpload = { name: '意式咖啡豆_选单.xlsx', bytes: new Uint8Array(selectionBytes) };

    const empty = createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z'));
    const completePreview = await createTablePreview({ upload: complete, sheetName: '产品详情对比', existing: empty });
    expect(completePreview.categories).toMatchObject({ new: 42, merge: 0, possible_duplicate: 0, conflict: 0, unrecognized: 0 });
    expect(completePreview.summary).toMatchObject({ beans: 42, brands: 15 });

    const repository = new JsonRepository(await mkdtemp(join(tmpdir(), 'coffee-table-real-')));
    tempDirs.push(repository.dataDir);
    await repository.initialize();
    await commitTablePreview(repository, completePreview, {}, {});

    const selectionPreview = await createTablePreview({ upload: selection, sheetName: '选豆决策表', existing: await repository.read() });
    expect(selectionPreview.categories).toMatchObject({ new: 0, merge: 40, possible_duplicate: 0, unrecognized: 0 });
    expect(selectionPreview.categories.conflict).toBe(2);
    expect(selectionPreview.conflicts.map((conflict) => conflict.beanName).sort()).toEqual(['任天堂', '茶花女']);
    expect(selectionPreview.conflicts.every((conflict) => conflict.field === 'roastLevel')).toBe(true);

    const resolutions = Object.fromEntries(selectionPreview.conflicts.map((conflict) => [conflict.id, 'existing' as const]));
    const result = await commitTablePreview(repository, selectionPreview, resolutions, {});
    expect(result.alreadyImported).toBe(false);

    const data = await repository.read();
    expect(data.beans).toHaveLength(42);
    expect(data.brands).toHaveLength(15);

    // §7：5 已喝 + 1 在喝；字母等级评分原样保留在豆上；评价记录 = 已喝/在喝各一条，原文进 summary，不伪造数值分。
    const drank = data.beans.filter((bean) => (bean.legacyStatusRaw ?? '').includes('已喝'));
    const drinking = data.beans.filter((bean) => (bean.legacyStatusRaw ?? '').includes('在喝'));
    expect(drank).toHaveLength(5);
    expect(drinking).toHaveLength(1);
    // 真实数据（2026-08 核对）：5 已喝评分含一个区间值 B+~A-，原样保留不做归一。
    expect(drank.map((bean) => bean.legacyPersonalScoreRaw).sort()).toEqual(['A', 'A+', 'A-', 'B+', 'B+~A-']);
    expect(data.beanEvaluations).toHaveLength(6);
    expect(data.beanEvaluations.every((evaluation) => evaluation.source === 'legacy_import' && evaluation.evaluatedOn === null)).toBe(true);
    expect(data.beanEvaluations.every((evaluation) => evaluation.overallScore === null && evaluation.summary !== null)).toBe(true);

    // §7：推荐等级分布 S 8 / A 15 / B 18 / C 1。
    const grades = data.beans.map((bean) => bean.importedFacts?.recommendationRaw ?? '');
    const countGrade = (prefix: string) => grades.filter((grade) => grade.includes(prefix)).length;
    expect(countGrade('S')).toBe(8);
    expect(countGrade('A')).toBe(15);
    expect(countGrade('B')).toBe(18);
    expect(countGrade('C')).toBe(1);

    // 抽样逐列核对：黑猫（乔治队长）的关键字段与评价。
    const blackCat = data.beans.find((bean) => bean.name.includes('黑猫'));
    expect(blackCat).toBeTruthy();
    expect(blackCat?.importedFacts?.recommendationRaw).toContain('A');
    expect(blackCat?.legacyPersonalScoreRaw).toBeTruthy();
    expect(blackCat?.importedFacts?.officialFlavorDescription ?? blackCat?.flavorNotes.length ?? 0).toBeTruthy();

    // 幂等：再次导入选单不产生新数据。
    const rePreview = await createTablePreview({ upload: selection, sheetName: '选豆决策表', existing: data });
    const reResult = await commitTablePreview(repository, rePreview, resolutions, {});
    expect(reResult.alreadyImported).toBe(true);
    expect((await repository.read()).beans).toHaveLength(42);

    // 原始文件字节不变。
    const after = await Promise.all([readFile(completePath), readFile(selectionPath)]);
    expect(after.map(sha256)).toEqual(before);
  }, 60_000);
});
