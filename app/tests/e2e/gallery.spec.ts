import { expect, test } from 'playwright/test';

test('browses, filters, compares and traces beans with keyboard-safe detail actions', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Full gallery behavior is covered once; responsive reachability runs separately.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const suffix = Date.now(); const firstName = `莓果航线-${suffix}`; const secondName = `可可航线-${suffix}`;
  const quick = await request.post('/api/catch-up/quick', { headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, data: {
    expectedRevision: snapshot.data.dataRevision,
    items: [
      { brandName: '陈列测试社', beanName: firstName, drankOn: '2026-08-06', brewMethod: 'americano' },
      { brandName: '陈列测试社', beanName: secondName, drankOn: '2026-08-07', brewMethod: 'milk' },
    ],
  } });
  expect(quick.ok()).toBeTruthy();
  const created = await quick.json() as { items: Array<{ beanId: string }> };
  await page.goto('/');

  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  await expect(gallery.getByRole('heading', { name: '收藏陈列馆' })).toBeVisible();
  await gallery.getByLabel('状态').selectOption('drank_pending_review');
  await gallery.getByLabel('搜索陈列馆').fill(firstName);
  await expect(gallery.getByRole('article').filter({ hasText: firstName })).toHaveCount(1);
  await gallery.getByRole('button', { name: '清除筛选' }).last().click();
  await gallery.getByRole('button', { name: '列表' }).click();
  await expect(gallery.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true');

  const firstCard = gallery.getByRole('article').filter({ hasText: firstName });
  const purchaseEditor = page.getByRole('region', { name: '一笔订单，保留每支豆的来路' });
  await purchaseEditor.getByLabel('购买渠道').fill('暂存渠道');
  const detailTrigger = firstCard.getByRole('button', { name: '查看档案' });
  await detailTrigger.focus(); await detailTrigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: firstName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭咖啡豆详情' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '查看归档或删除影响' })).toBeFocused();
  await expect(dialog.getByRole('heading', { name: '商品与来源' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /饮用与评价/ })).toBeVisible();
  page.once('dialog', async (confirmation) => confirmation.dismiss());
  await dialog.getByRole('button', { name: '为这支豆创建购买' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(detailTrigger).toBeFocused();
  await purchaseEditor.getByLabel('购买渠道').fill('');

  await gallery.getByLabel('搜索陈列馆').fill('一定不存在的咖啡豆');
  await expect(gallery.getByRole('heading', { name: '没有符合条件的豆' })).toBeVisible();
  await gallery.getByRole('button', { name: '清除筛选' }).last().click();

  await firstCard.getByLabel('加入比较').check();
  await gallery.getByRole('article').filter({ hasText: secondName }).getByLabel('加入比较').check();
  const comparison = gallery.getByRole('region', { name: /比较台/ });
  await expect(comparison.getByText('甜感')).toBeVisible();
  await expect(comparison.getByText('未知').first()).toBeVisible();
  await comparison.getByRole('button', { name: '创建购买' }).first().click();
  await expect(page.getByRole('region', { name: '一笔订单，保留每支豆的来路' }).getByLabel('商品 1 咖啡豆')).toHaveValue(created.items[0]!.beanId);

  const latest = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const conflictWrite = await request.post('/api/catch-up/quick', { headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, data: {
    expectedRevision: latest.data.dataRevision,
    items: [{ brandName: '陈列测试社', beanName: `并发写入-${suffix}`, drankOn: '2026-08-07', brewMethod: 'other' }],
  } });
  expect(conflictWrite.ok()).toBeTruthy();
  await firstCard.getByRole('button', { name: '加入关注' }).click();
  await expect(gallery.getByRole('status').filter({ hasText: '已刷新到最新版本' })).toBeVisible();
  await firstCard.getByRole('button', { name: '加入关注' }).click();
  await expect(gallery.getByRole('status').filter({ hasText: '已加入关注' })).toBeVisible();
  await expect(firstCard.getByRole('button', { name: '查看档案' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('gallery-desktop.png'), fullPage: true });
  const persisted = await (await request.get('/api/snapshot')).json() as { data: { beans: Array<{ id: string; followedAt: string | null }> } };
  expect(persisted.data.beans.find((bean) => bean.id === created.items[0]!.beanId)?.followedAt).not.toBeNull();
});

test('recovers a committed follow when refreshing the gallery fails', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Follow partial-failure recovery is covered once.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const beanName = `刷新恢复豆-${Date.now()}`;
  const quick = await request.post('/api/catch-up/quick', { headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, data: {
    expectedRevision: snapshot.data.dataRevision,
    items: [{ brandName: '恢复测试社', beanName, drankOn: '2026-08-07', brewMethod: 'other' }],
  } });
  expect(quick.ok()).toBeTruthy();
  await page.goto('/');

  let failNextSnapshot = false;
  await page.route('**/api/snapshot', async (route) => {
    if (!failNextSnapshot) { await route.continue(); return; }
    failNextSnapshot = false;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'refresh_unavailable' }) });
  });
  failNextSnapshot = true;
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  const card = gallery.getByRole('article').filter({ hasText: beanName });
  await card.getByRole('button', { name: '加入关注' }).click();
  await expect(gallery.getByRole('status').filter({ hasText: '已写入本地数据，但页面刷新失败' })).toBeVisible();
  await expect(card.getByRole('button', { name: '加入关注' })).toBeDisabled();
  await gallery.getByRole('button', { name: '重试刷新' }).click();
  await expect(gallery.getByRole('status').filter({ hasText: '本地数据已刷新' })).toBeVisible();
  await expect(card.getByRole('button', { name: '加入关注' })).toHaveCount(0);
});

test('keeps the gallery and high-frequency recording entry reachable at narrow widths', async ({ page, request }, testInfo) => {
  if (testInfo.project.name === 'minimum-320-reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  await request.post('/api/catch-up/quick', { headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, data: { expectedRevision: snapshot.data.dataRevision, items: [{ brandName: '窄屏社', beanName: `窄屏豆-${testInfo.project.name}-${Date.now()}`, drankOn: '2026-08-07', brewMethod: 'other' }] } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始补评价' })).toBeVisible();
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  await expect(gallery.getByLabel('搜索陈列馆')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await page.screenshot({ path: testInfo.outputPath(`gallery-${testInfo.project.name}.png`), fullPage: true });
  if (testInfo.project.name === 'minimum-320-reduced') {
    await gallery.getByRole('article').filter({ hasText: '窄屏豆-' }).first().getByRole('button', { name: '查看档案' }).click();
    const animationDuration = await page.getByRole('dialog').evaluate((element) => getComputedStyle(element).animationDuration);
    expect(['0s', '0ms']).toContain(animationDuration);
  }
});
