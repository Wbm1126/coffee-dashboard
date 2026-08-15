import { expect, test } from 'playwright/test';

test('saves a three-bean purchase, a single-bean partial review, and immediately undoes trash', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Full record authoring is covered once; entry reachability runs at every viewport.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const suffix = Date.now(); const names = [`购买豆甲-${suffix}`, `购买豆乙-${suffix}`, `购买豆丙-${suffix}`];
  const quick = await request.post('/api/catch-up/quick', { headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    data: { expectedRevision: snapshot.data.dataRevision, items: names.map((beanName) => ({ brandName: '事实链测试社', beanName, drankOn: '2026-08-01', brewMethod: 'other' })) } });
  expect(quick.ok()).toBeTruthy();
  await page.goto('/');

  const purchase = page.getByRole('region', { name: '一笔订单，保留每支豆的来路' });
  await purchase.getByLabel('购买渠道').fill('初始渠道');
  await purchase.getByLabel('商品 1 咖啡豆').selectOption({ label: names[0] });
  await purchase.getByLabel('商品 1 单包克数').fill('250'); await purchase.getByLabel('商品 1 行实付').fill('88');
  await purchase.getByRole('button', { name: '添加商品' }).click(); await purchase.getByRole('button', { name: '添加商品' }).click();
  await purchase.getByLabel('商品 2 咖啡豆').selectOption({ label: names[1] });
  await purchase.getByLabel('商品 3 咖啡豆').selectOption({ label: names[2] });
  await purchase.getByRole('button', { name: '保存购买' }).click();
  await expect(purchase.getByRole('status')).toContainText('包含 3 支豆');

  const drinking = page.getByRole('region', { name: '一次只记录一支豆' });
  await drinking.getByLabel('饮用咖啡豆').selectOption({ label: names[0] });
  await drinking.getByLabel('关联购买项').selectOption({ index: 1 });
  await drinking.getByLabel('奶咖评价状态').selectOption('reviewed');
  await drinking.getByLabel('奶咖评分').selectOption('4.5');
  await drinking.getByLabel('奶咖风味标签').fill('榛果、焦糖');
  await drinking.getByLabel('奶咖优点').fill('甜感清楚');
  await drinking.getByLabel('奶咖不足').fill('尾段稍短');
  await drinking.getByLabel('奶咖补充品鉴').fill('降温后更甜');
  await drinking.getByLabel('个人等级').selectOption('A');
  await drinking.getByLabel('是否回购').selectOption('yes');
  await drinking.getByLabel('一句总结').fill('适合稳定复购');
  await drinking.getByRole('button', { name: '保存饮用' }).click();
  await expect(drinking.getByRole('status')).toContainText('未评价维度仍是待补');

  const timeline = page.getByRole('region', { name: '购买与饮用各自保留，在这里汇合' });
  const purchaseArticle = timeline.getByRole('article').filter({ hasText: '初始渠道' });
  await purchaseArticle.getByRole('button', { name: '更正' }).click();
  await expect(purchase.getByLabel('购买渠道')).toHaveValue('初始渠道');
  await purchase.getByLabel('购买渠道').fill('尚未保存的渠道');
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('未保存'); await dialog.dismiss(); });
  await timeline.getByRole('article').filter({ hasText: names[0] }).first().getByRole('button', { name: '更正' }).click();
  await expect(purchase.getByLabel('购买渠道')).toHaveValue('尚未保存的渠道');
  await purchase.getByLabel('购买渠道').fill('更正渠道');
  await purchase.getByLabel('商品 1 数量').fill('2');
  await purchase.getByRole('button', { name: '保存更正' }).click();
  await expect(timeline.getByText(/更正渠道/)).toBeVisible();

  const target = timeline.getByRole('article').filter({ hasText: `${names[0]}` }).filter({ hasText: '已关联购买项' });
  await target.getByRole('button', { name: '更正' }).click();
  await expect(drinking.getByLabel('饮用咖啡豆')).toHaveValue(/.+/);
  await expect(drinking.getByLabel('个人等级')).toHaveValue('A');
  await drinking.getByLabel('饮用咖啡豆').selectOption({ label: names[1] });
  await expect(drinking.getByLabel('个人等级')).toHaveValue('');
  await expect(drinking.getByLabel('一句总结')).toHaveValue('');
  await drinking.getByLabel('饮用咖啡豆').selectOption({ label: names[0] });
  await expect(drinking.getByLabel('个人等级')).toHaveValue('A');
  await drinking.getByLabel('关联购买项').selectOption({ index: 1 });
  await drinking.getByLabel('饮用日期').fill('2026-08-07');
  await drinking.getByLabel('萃取备注').fill('18g / 36g / 28s');
  await drinking.getByRole('button', { name: '保存更正' }).click();
  await expect(timeline.getByRole('article').filter({ hasText: `${names[0]}` }).filter({ hasText: '2026-08-07' })).toHaveCount(1);

  const persisted = await (await request.get('/api/snapshot')).json() as { data: { purchases: unknown[]; drinkingRecords: Array<{ drankOn: string; extractionNote: string | null }>; assessments: Array<{ grade: string | null; repurchase: string | null; summary: string | null }> } };
  expect(persisted.data.purchases).toHaveLength(1);
  expect(persisted.data.drinkingRecords.filter((record) => record.extractionNote === '18g / 36g / 28s')).toHaveLength(1);
  expect(persisted.data.drinkingRecords.find((record) => record.extractionNote === '18g / 36g / 28s')?.drankOn).toBe('2026-08-07');
  expect(persisted.data.assessments).toContainEqual(expect.objectContaining({ grade: 'A', repurchase: 'yes', summary: '适合稳定复购' }));

  await timeline.getByText(/更正渠道/).locator('..').getByRole('button', { name: '更正' }).click();
  await purchase.getByRole('group', { name: '商品 1' }).getByRole('button', { name: '移除此行' }).click();
  await purchase.getByRole('button', { name: '保存更正' }).click();
  await expect(purchase.getByRole('status')).toContainText('已有饮用记录引用');
  await expect(purchase.getByLabel('商品 1 咖啡豆')).toBeVisible();
  page.once('dialog', async (dialog) => { await dialog.accept(); });
  await purchase.getByRole('button', { name: '取消更正' }).click();

  const correctedTarget = timeline.getByRole('article').filter({ hasText: `${names[0]}` }).filter({ hasText: '已关联购买项' });
  await correctedTarget.getByRole('button', { name: '移入回收站' }).click();
  await expect(timeline.getByRole('alert')).toContainText('保存后可立即撤销');
  await timeline.getByRole('button', { name: '确认移入回收站' }).click();
  await expect(timeline.getByRole('button', { name: '立即撤销' })).toBeVisible();
  await timeline.getByRole('button', { name: '立即撤销' }).click();
  await expect(timeline.getByRole('status')).toContainText('记录已恢复');
});

test('prevents duplicate purchase submission while a committed save is waiting for refresh', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Refresh recovery is viewport independent and covered once.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const beanName = `刷新保护豆-${Date.now()}`;
  await request.post('/api/catch-up/quick', {
    headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    data: { expectedRevision: snapshot.data.dataRevision, items: [{ brandName: '刷新保护社', beanName, drankOn: '2026-08-01', brewMethod: 'other' }] },
  });
  await page.goto('/');
  const purchase = page.getByRole('region', { name: '一笔订单，保留每支豆的来路' });
  await purchase.getByLabel('商品 1 咖啡豆').selectOption({ label: beanName });
  await purchase.getByLabel('购买渠道').fill('刷新失败测试');

  let failRefresh = true;
  await page.route('**/api/snapshot', async (route) => {
    if (failRefresh) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试刷新失败' }) });
    else await route.continue();
  });
  await purchase.getByRole('button', { name: '保存购买' }).click();
  await expect(purchase.getByRole('status')).toContainText('购买已保存，但刷新失败');
  await expect(purchase.getByRole('button', { name: '保存购买' })).toBeDisabled();

  failRefresh = false;
  await purchase.getByRole('button', { name: '重试刷新' }).click();
  await expect(purchase.getByRole('status')).toContainText('购买数据已刷新');
  const persisted = await (await request.get('/api/snapshot')).json() as { data: { purchases: Array<{ channel: string | null }> } };
  expect(persisted.data.purchases.filter((item) => item.channel === '刷新失败测试')).toHaveLength(1);
});

test('prefills the default bean assessment so a later drinking record does not erase it', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Assessment preservation is viewport independent and covered once.');
  await page.goto('/');
  const drinking = page.getByRole('region', { name: '一次只记录一支豆' });
  const beanId = await drinking.getByLabel('饮用咖啡豆').inputValue();
  expect(beanId).not.toBe('');
  const suffix = Date.now();
  const firstNote = `评价保留-第一次-${suffix}`;
  const secondNote = `评价保留-第二次-${suffix}`;

  await drinking.getByLabel('萃取备注').fill(firstNote);
  await drinking.getByLabel('个人等级').selectOption('B');
  await drinking.getByLabel('是否回购').selectOption('price_dependent');
  await drinking.getByLabel('一句总结').fill('已有结论不应被下一次饮用清空');
  await drinking.getByRole('button', { name: '保存饮用' }).click();
  await expect(drinking.getByRole('status')).toContainText('饮用已保存');

  await page.reload();
  const freshDrinking = page.getByRole('region', { name: '一次只记录一支豆' });
  await expect(freshDrinking.getByLabel('饮用咖啡豆')).toHaveValue(beanId);
  await expect(freshDrinking.getByLabel('个人等级')).toHaveValue('B');
  await expect(freshDrinking.getByLabel('是否回购')).toHaveValue('price_dependent');
  await expect(freshDrinking.getByLabel('一句总结')).toHaveValue('已有结论不应被下一次饮用清空');
  await freshDrinking.getByLabel('萃取备注').fill(secondNote);
  await freshDrinking.getByRole('button', { name: '保存饮用' }).click();
  await expect(freshDrinking.getByRole('status')).toContainText('饮用已保存');

  const persisted = await (await request.get('/api/snapshot')).json() as { data: {
    drinkingRecords: Array<{ beanId: string; extractionNote: string | null }>;
    assessments: Array<{ beanId: string; grade: string | null; repurchase: string | null; summary: string | null }>;
  } };
  expect(persisted.data.drinkingRecords).toEqual(expect.arrayContaining([
    expect.objectContaining({ beanId, extractionNote: firstNote }),
    expect.objectContaining({ beanId, extractionNote: secondNote }),
  ]));
  expect(persisted.data.assessments).toContainEqual(expect.objectContaining({
    beanId,
    grade: 'B',
    repurchase: 'price_dependent',
    summary: '已有结论不应被下一次饮用清空',
  }));
});

test('blocks stale timeline mutations after a committed action fails to refresh', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Timeline refresh recovery is viewport independent and covered once.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const suffix = Date.now();
  const beanName = `时间线刷新豆-${suffix}`;
  const channel = `时间线刷新渠道-${suffix}`;
  const quick = await request.post('/api/catch-up/quick', {
    headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    data: { expectedRevision: snapshot.data.dataRevision, items: [{ brandName: '时间线测试社', beanName, drankOn: '2026-08-02', brewMethod: 'other' }] },
  });
  expect(quick.ok()).toBeTruthy();
  await page.goto('/');
  const purchase = page.getByRole('region', { name: '一笔订单，保留每支豆的来路' });
  await purchase.getByLabel('商品 1 咖啡豆').selectOption({ label: beanName });
  await purchase.getByLabel('购买渠道').fill(channel);
  await purchase.getByRole('button', { name: '保存购买' }).click();
  await expect(purchase.getByRole('status')).toContainText('已保存一笔');

  const timeline = page.getByRole('region', { name: '购买与饮用各自保留，在这里汇合' });
  const target = timeline.getByRole('article').filter({ hasText: channel });
  await target.getByRole('button', { name: '移入回收站' }).click();
  await expect(timeline.getByRole('alert')).toBeVisible();

  let failRefresh = true;
  let trashPosts = 0;
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && /\/api\/purchases\/[^/]+\/trash$/.test(outgoing.url())) trashPosts += 1;
  });
  await page.route('**/api/snapshot', async (route) => {
    if (failRefresh) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试刷新失败' }) });
    else await route.continue();
  });
  await timeline.getByRole('button', { name: '确认移入回收站' }).click();
  await expect(timeline.getByRole('status')).toContainText('已移入回收站，但刷新失败');
  await expect(timeline.getByRole('button', { name: '立即撤销' })).toBeDisabled();
  await expect(target.getByRole('button', { name: '更正' })).toBeDisabled();
  await expect(target.getByRole('button', { name: '移入回收站' })).toBeDisabled();
  expect(trashPosts).toBe(1);

  failRefresh = false;
  await timeline.getByRole('button', { name: '重试刷新' }).click();
  await expect(timeline.getByRole('status')).toContainText('数据已刷新，可以继续操作');
  await expect(timeline.getByRole('button', { name: '更正' }).first()).toBeEnabled();
  await timeline.locator('summary').filter({ hasText: '回收站' }).click();
  await expect(timeline.getByRole('button', { name: '恢复' }).last()).toBeEnabled();
  expect(trashPosts).toBe(1);
});

test('keeps purchase and drinking entry points reachable at the configured viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '购买和饮用，分开写清楚。' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '一笔订单，保留每支豆的来路' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '一次只记录一支豆' })).toBeVisible();
});
