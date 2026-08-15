import { expect, test } from 'playwright/test';
test('opens a new local archive without accounts or external network requests', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'minimum-320-reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
  const external: string[] = []; page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:5194')) external.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '豆迹' })).toBeVisible();
  await expect(page.getByText('可离线浏览和记录。当前没有数据被发送到外部服务。')).toBeVisible();
  await expect(page.getByRole('region', { name: '收藏陈列馆' })).toBeVisible();
  expect(external).toEqual([]);
});
