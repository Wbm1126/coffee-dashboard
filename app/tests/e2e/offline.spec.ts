import { expect, test } from 'playwright/test';
test('records and exports local facts while external requests are blocked', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The complete offline record path is covered once.');
  await page.route(/^(?!http:\/\/127\.0\.0\.1:5194).*/, (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: '快速补记喝过的豆子' }).click();
  await page.getByLabel('第 1 行品牌').fill('离线测试社'); await page.getByLabel('第 1 行豆名').fill('离线豆');
  await page.getByRole('button', { name: '批量加入待补队列' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('已加入 1 款');
  const exportPanel = page.getByRole('region', { name: '导出评价快照' });
  await exportPanel.getByLabel('PDF（阅读与打印）').uncheck(); await exportPanel.getByRole('button', { name: /确认导出 \d+ 支豆/ }).click();
  await expect(exportPanel.getByRole('status')).toContainText('已生成同一快照');
});
