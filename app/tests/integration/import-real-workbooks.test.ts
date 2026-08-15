import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import { createImportPreview } from '../../src/import/xlsx/preview-service.js';

const projectDir = join(import.meta.dirname, '..', '..', '..');
const completePath = join(projectDir, '意式咖啡豆_完整版.xlsx');
const selectionPath = join(projectDir, '意式咖啡豆_选单.xlsx');
const sourcesAvailable = existsSync(completePath) && existsSync(selectionPath);

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe.runIf(sourcesAvailable)('real legacy workbook dry-run', () => {
  it('produces the agreed baseline and leaves both source files byte-identical', async () => {
    const [complete, selection] = await Promise.all([
      readFile(completePath),
      readFile(selectionPath),
    ]);
    const before = [sha256(complete), sha256(selection)];

    const preview = await createImportPreview({
      complete: { name: '意式咖啡豆_完整版.xlsx', bytes: complete },
      selection: { name: '意式咖啡豆_选单.xlsx', bytes: selection },
      existing: createEmptyCoffeeData(new Date('2026-08-06T00:00:00.000Z')),
      now: new Date('2026-08-06T00:00:00.000Z'),
    });

    expect(preview.summary).toMatchObject({
      beans: 42,
      brands: 15,
      untried: 36,
      drank: 5,
      drinking: 1,
      legacyScores: 5,
    });
    expect(preview.conflicts).toHaveLength(2);
    expect(preview.conflicts.map((conflict) => conflict.beanName).sort()).toEqual([
      '任天堂',
      '茶花女',
    ]);
    expect(preview.conflicts.every((conflict) => conflict.field === 'roastLevel')).toBe(true);
    expect(preview.items.every((item) => item.category === 'new')).toBe(true);

    const after = await Promise.all([readFile(completePath), readFile(selectionPath)]);
    expect(after.map(sha256)).toEqual(before);
  });

  it('fails explicitly when either required workbook is missing', async () => {
    const complete = await readFile(completePath);
    await expect(
      createImportPreview({
        complete: { name: '意式咖啡豆_完整版.xlsx', bytes: complete },
        selection: null,
        existing: createEmptyCoffeeData(),
      }),
    ).rejects.toThrow(/两份|选单/);
  });
});
