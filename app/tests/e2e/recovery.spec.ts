import { expect, test } from 'playwright/test';

test('restores a selected local backup and returns to the ready dashboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The recovery interaction is covered once.');
  let recovered = false;
  const recovery = { mode: 'recovery', reason: '测试损坏', backups: [{ name: 'known-good.json', valid: true }] };
  await page.route('**/api/snapshot', async (route) => {
    if (!recovered) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(recovery) });
    else await route.continue();
  });
  await page.route('**/api/recovery', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recovery) }));
  await page.route('**/api/recovery/restore', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ backupName: 'known-good.json' });
    recovered = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'ready' }) });
  });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '本地数据恢复' })).toBeVisible();
  await page.getByRole('button', { name: '恢复 known-good.json' }).click();
  await expect(page.getByRole('heading', { name: '豆迹' })).toBeVisible();
  await expect(page.getByText('可离线浏览和记录。当前没有数据被发送到外部服务。')).toBeVisible();
});
