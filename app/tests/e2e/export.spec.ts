import { expect, test, type APIRequestContext } from 'playwright/test';

async function createBeans(request: APIRequestContext, names: string[]) {
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const response = await request.post('/api/catch-up/quick', {
    headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    data: {
      expectedRevision: snapshot.data.dataRevision,
      items: names.map((beanName, index) => ({ brandName: '导出测试社', beanName, drankOn: `2026-08-${String(index + 6).padStart(2, '0')}`, brewMethod: 'other' })),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json() as { items: Array<{ beanId: string }> }).items.map((item) => item.beanId);
}

test('exports the current filtered gallery scope as a local markdown snapshot', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Export interaction is covered once; responsive layout is exercised separately.');
  const beanName = `当前筛选快照豆-${Date.now()}`;
  const [beanId] = await createBeans(request, [beanName]);
  await page.goto('/');
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  await gallery.getByLabel('搜索陈列馆').fill(beanName);
  const exportPanel = page.getByRole('region', { name: '导出评价快照' });
  await expect(exportPanel.locator('.export-scope-summary')).toContainText('当前筛选范围 · 1 支咖啡豆');
  await exportPanel.getByLabel('PDF（阅读与打印）').uncheck();
  const requestPromise = page.waitForRequest((outgoing) => outgoing.url().endsWith('/api/exports') && outgoing.method() === 'POST');
  await exportPanel.getByRole('button', { name: '确认导出 1 支豆' }).click();
  const payload = (await requestPromise).postDataJSON() as { beanIds: string[]; filters: Record<string, string> };
  expect(payload.beanIds).toEqual([beanId]);
  expect(payload.filters.exportScope).toBe('当前筛选结果');
  await expect(exportPanel.getByRole('status')).toContainText('已生成同一快照');
  await expect(exportPanel.getByRole('link', { name: '下载 Markdown' })).toHaveAttribute('href', /\/api\/exports\/.+\.md$/);
});

test('exports three comparison-selected beans as one explicit snapshot scope', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The three-bean comparison export is covered once.');
  const suffix = Date.now();
  const names = [`指定豆甲-${suffix}`, `指定豆乙-${suffix}`, `指定豆丙-${suffix}`];
  const beanIds = await createBeans(request, names);
  await page.goto('/');
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  for (const name of names) await gallery.getByRole('article').filter({ hasText: name }).getByLabel('加入比较').check();
  const exportPanel = page.getByRole('region', { name: '导出评价快照' });
  await exportPanel.getByLabel(/指定咖啡豆（比较台已选 3 支）/).check();
  await expect(exportPanel.locator('.export-scope-summary')).toContainText('指定咖啡豆（来自比较台） · 3 支咖啡豆');
  await exportPanel.getByLabel('PDF（阅读与打印）').uncheck();
  const requestPromise = page.waitForRequest((outgoing) => outgoing.url().endsWith('/api/exports') && outgoing.method() === 'POST');
  await exportPanel.getByRole('button', { name: '确认导出 3 支豆' }).click();
  const payload = (await requestPromise).postDataJSON() as { beanIds: string[]; filters: Record<string, string> };
  expect(payload.beanIds).toEqual(beanIds);
  expect(payload.filters.exportScope).toBe('比较台指定咖啡豆');
  await expect(exportPanel.getByRole('status')).toContainText('已生成同一快照');
});

test('keeps the selected-bean export reachable by keyboard on narrow screens', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-1440', 'Narrow keyboard reachability runs at 768px and 320px.');
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const names = [`键盘指定甲-${suffix}`, `键盘指定乙-${suffix}`];
  await createBeans(request, names);
  await page.goto('/');
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  const exportPanel = page.getByRole('region', { name: '导出评价快照' });
  await expect(exportPanel.getByText(/请先在豆卡上勾选“加入比较”/)).toBeVisible();
  await expect(exportPanel.getByLabel(/指定咖啡豆/)).toBeDisabled();
  for (const name of names) {
    const checkbox = gallery.getByRole('article').filter({ hasText: name }).getByLabel('加入比较');
    await checkbox.focus(); await checkbox.press('Space');
  }
  const selectedScope = exportPanel.getByLabel(/指定咖啡豆（比较台已选 2 支）/);
  await selectedScope.focus(); await selectedScope.press('Space');
  await expect(exportPanel.locator('.export-scope-summary')).toContainText('指定咖啡豆（来自比较台） · 2 支咖啡豆');
  const pdf = exportPanel.getByLabel('PDF（阅读与打印）');
  await pdf.focus(); await pdf.press('Space');
  const submit = exportPanel.getByRole('button', { name: '确认导出 2 支豆' });
  await submit.focus(); await submit.press('Enter');
  await expect(exportPanel.getByRole('status')).toContainText('已生成同一快照');
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
});

test('refreshes the parent revision before exporting a different scope', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The export revision handoff is covered once.');
  const suffix = Date.now();
  const names = [`版本交接甲-${suffix}`, `版本交接乙-${suffix}`];
  await createBeans(request, names);
  await page.goto('/');
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  await gallery.getByRole('article').filter({ hasText: names[0] }).getByLabel('加入比较').check();
  const exportPanel = page.getByRole('region', { name: '导出评价快照' });
  await exportPanel.getByLabel('PDF（阅读与打印）').uncheck();

  const firstResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/exports') && response.request().method() === 'POST');
  await exportPanel.getByRole('button', { name: /确认导出/ }).click();
  const firstResponse = await firstResponsePromise;
  expect(firstResponse.ok()).toBeTruthy();
  const firstResult = await firstResponse.json() as { dataRevision: number };

  await exportPanel.getByLabel(/指定咖啡豆（比较台已选 1 支）/).check();
  const secondRequestPromise = page.waitForRequest((outgoing) => outgoing.url().endsWith('/api/exports') && outgoing.method() === 'POST');
  const secondResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/exports') && response.request().method() === 'POST');
  await exportPanel.getByRole('button', { name: '确认导出 1 支豆' }).click();
  const secondPayload = (await secondRequestPromise).postDataJSON() as { expectedRevision: number; snapshotId?: string };
  const secondResponse = await secondResponsePromise;
  expect(secondPayload.expectedRevision).toBe(firstResult.dataRevision);
  expect(secondPayload.snapshotId).toBeUndefined();
  expect(secondResponse.ok()).toBeTruthy();
});

test('reuses the committed snapshot when the post-export refresh fails', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The failed refresh retry is covered once.');
  const [beanId] = await createBeans(request, [`刷新失败重试豆-${Date.now()}`]);
  let failSnapshotReads = false;
  await page.route('**/api/snapshot', async (route) => {
    if (failSnapshotReads) await route.abort('failed');
    else await route.continue();
  });
  await page.goto('/');
  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  await expect(gallery).toBeVisible();
  failSnapshotReads = true;
  await gallery.getByLabel('搜索陈列馆').fill('刷新失败重试豆');
  const exportPanel = page.getByRole('region', { name: '导出评价快照' });
  await exportPanel.getByLabel('PDF（阅读与打印）').uncheck();

  const firstResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/exports') && response.request().method() === 'POST');
  await exportPanel.getByRole('button', { name: '确认导出 1 支豆' }).click();
  const firstResponse = await firstResponsePromise;
  expect(firstResponse.ok()).toBeTruthy();
  const firstResult = await firstResponse.json() as { snapshot: { id: string }; dataRevision: number };
  await expect(exportPanel.getByRole('status')).toContainText('页面版本刷新失败');
  await expect(exportPanel.getByRole('link', { name: '下载 Markdown' })).toBeVisible();

  const retryRequestPromise = page.waitForRequest((outgoing) => outgoing.url().endsWith('/api/exports') && outgoing.method() === 'POST');
  const retryResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/exports') && response.request().method() === 'POST');
  await exportPanel.getByRole('button', { name: '确认导出 1 支豆' }).click();
  const retryPayload = (await retryRequestPromise).postDataJSON() as { expectedRevision: number; beanIds: string[]; snapshotId?: string };
  const retryResponse = await retryResponsePromise;
  expect(retryPayload).toMatchObject({ expectedRevision: firstResult.dataRevision, beanIds: [beanId], snapshotId: firstResult.snapshot.id });
  expect(retryResponse.ok()).toBeTruthy();
  expect((await retryResponse.json() as { snapshot: { id: string } }).snapshot.id).toBe(firstResult.snapshot.id);
});
