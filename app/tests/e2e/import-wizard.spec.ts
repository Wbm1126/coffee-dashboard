import { expect, test } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRepresentativeWorkbooks } from '../fixtures/import/build-workbooks.js';

test('previews both workbooks and requires every conflict decision', async ({ page }, testInfo) => {
  const files = await buildRepresentativeWorkbooks();
  const fixtureDir = join(import.meta.dirname, '..', '..', 'test-results', 'generated-import');
  await mkdir(fixtureDir, { recursive: true });
  const completePath = join(fixtureDir, files.complete.name);
  const selectionPath = join(fixtureDir, files.selection.name);
  await Promise.all([
    writeFile(completePath, files.complete.bytes),
    writeFile(selectionPath, files.selection.bytes),
  ]);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '接上四月的记录' })).toBeVisible();
  await page.getByLabel(/01 · 完整版/).setInputFiles(completePath);
  await page.getByLabel(/02 · 选单/).setInputFiles(selectionPath);
  const previewResponse = page.waitForResponse((response) => response.url().endsWith('/api/import/preview'));
  await page.getByRole('button', { name: '生成只读预览' }).click();
  const apiResponse = await previewResponse;
  expect(apiResponse.status(), await apiResponse.text()).toBe(200);

  await expect(page.getByText('预览已生成。确认冲突后再写入，不会修改原 Excel。')).toBeVisible();
  await expect(page.getByText('新增 2 · 自动合并 0 · 需确认 0 · 未识别 0')).toBeVisible();
  await expect(page.getByRole('group', { name: '晨光 · 烘焙度' })).toBeVisible();
  const commit = page.getByRole('button', { name: /先处理 1 项冲突/ });
  await expect(commit).toBeDisabled();
  await page.getByRole('radio', { name: /中浅烘焙/ }).check();
  await expect(page.getByRole('button', { name: '确认并导入' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(fixtureDir, `import-preview-${testInfo.project.name}.png`), fullPage: true });
});
