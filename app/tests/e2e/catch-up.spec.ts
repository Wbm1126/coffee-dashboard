import { expect, test, type APIRequestContext } from 'playwright/test';

async function addPendingBeans(
  request: APIRequestContext,
  names: string[],
) {
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const response = await request.post('/api/catch-up/quick', {
    headers: {
      origin: 'http://127.0.0.1:5194',
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
    },
    data: {
      expectedRevision: snapshot.data.dataRevision,
      items: names.map((beanName) => ({ brandName: '队列回归烘焙社', beanName, drankOn: '2026-08-05', brewMethod: 'milk' })),
    },
  });
  expect(response.ok()).toBeTruthy();
  return { session, response: await response.json() as { dataRevision: number } };
}

test('completes independent review dimensions and removes the bean from the pending queue', async ({ page, request }, testInfo) => {
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const beanName = `连续补评-${testInfo.project.name}-${Date.now()}`;
  const quick = await request.post('/api/catch-up/quick', {
    headers: {
      origin: 'http://127.0.0.1:5194',
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
    },
    data: {
      expectedRevision: snapshot.data.dataRevision,
      items: [{ brandName: '端到端烘焙社', beanName, drankOn: '2026-08-05', brewMethod: 'milk' }],
    },
  });
  expect(quick.ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: '开始补评价' }).click();
  await page.getByRole('button', { name: new RegExp(beanName) }).click();

  await page.getByLabel('当时感受').fill('这段内容还没有保存');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('尚未保存');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '快速补记喝过的豆子' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('heading', { name: beanName })).toBeVisible();

  await page.getByRole('radio', { name: '美式不适用' }).check();
  await page.getByRole('radio', { name: '奶咖已评价' }).check();
  await page.getByLabel('奶咖评分').selectOption('4.5');
  await page.getByLabel('奶咖风味标签').fill('榛果、焦糖');
  await page.getByLabel('奶咖优点').fill('甜感清楚，和牛奶融合自然');
  const verdict = page.getByRole('group', { name: '最后由你定调' });
  await verdict.getByLabel('个人等级').selectOption('A');
  await verdict.getByLabel('是否回购').selectOption('yes');
  await page.getByRole('button', { name: '保存并继续' }).click();

  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('评价已保存');
  await expect(page.getByRole('button', { name: new RegExp(beanName) })).toHaveCount(0);
});

test('batch quick entry creates factual pending records and warns before clearing dirty input', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Batch authoring is covered once; the primary flow runs at every viewport.');
  await page.goto('/');
  await page.getByRole('button', { name: '开始补评价' }).click();
  await page.getByRole('button', { name: '快速补记喝过的豆子' }).click();

  await page.getByLabel('第 1 行品牌').fill('批量测试品牌');
  await page.getByLabel('第 1 行豆名').fill('批量豆一');
  await page.getByRole('button', { name: '再加一行' }).click();
  await page.getByLabel('第 2 行品牌').fill('批量测试品牌');
  await page.getByLabel('第 2 行豆名').fill('批量豆二');

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('尚未保存');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '清空' }).click();
  await expect(page.getByLabel('第 1 行豆名')).toHaveValue('批量豆一');

  await page.getByRole('button', { name: '批量加入待补队列' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('已加入 2 款');
  await expect(page.getByRole('button', { name: /批量豆一/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /批量豆二/ })).toBeVisible();
});

test('exposes the skip link and primary catch-up action in keyboard order', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Keyboard order is viewport independent and covered once.');
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '开始补评价' })).toBeFocused();
});

test('resets the unsaved baseline after a draft is successfully stored', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Draft baseline behavior is viewport independent and covered once.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const beanName = `草稿基线-${Date.now()}`;
  await request.post('/api/catch-up/quick', {
    headers: { origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    data: { expectedRevision: snapshot.data.dataRevision, items: [{ brandName: '草稿测试社', beanName, drankOn: '2026-08-05', brewMethod: 'milk' }] },
  });

  await page.goto('/');
  await page.getByRole('button', { name: '开始补评价' }).click();
  await page.getByRole('button', { name: new RegExp(beanName) }).click();
  await page.getByLabel('当时感受').fill('先保存为草稿');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('草稿已保存');
  await page.getByRole('button', { name: '快速补记喝过的豆子' }).click();
  await expect(page.getByRole('heading', { name: '先留下“喝过”这个事实' })).toBeVisible();
});

test('moves to the next visible bean after saving an intentionally partial review', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Queue movement is viewport independent and covered once.');
  const suffix = Date.now();
  const firstBean = `部分评价一-${suffix}`;
  const secondBean = `部分评价二-${suffix}`;
  await addPendingBeans(request, [firstBean, secondBean]);

  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(firstBean) }).click();
  await page.getByRole('radio', { name: '奶咖已评价' }).check();
  await page.getByLabel('奶咖评分').selectOption('4');
  await page.getByRole('button', { name: '保存并继续' }).click();

  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('评价已保存');
  await expect(page.locator('.review-editor__bean h3')).not.toHaveText(firstBean);
  await expect(page.getByRole('button', { name: new RegExp(secondBean) })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(firstBean) })).toBeVisible();
});

test('reports a committed save separately from a failed refresh and allows retry', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Refresh recovery is viewport independent and covered once.');
  const beanName = `刷新恢复-${Date.now()}`;
  await addPendingBeans(request, [beanName]);
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(beanName) }).click();

  let blockQueueRefresh = true;
  await page.route('**/api/catch-up', async (route) => {
    if (blockQueueRefresh) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试刷新失败' }) });
    } else {
      await route.continue();
    }
  });
  await page.getByLabel('当时感受').fill('服务端会成功保存这段内容');
  await page.getByRole('button', { name: '保存草稿' }).click();

  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('评价已保存，但队列刷新失败');
  await expect(page.getByRole('button', { name: '重试刷新' })).toBeVisible();
  blockQueueRefresh = false;
  await page.getByRole('button', { name: '重试刷新' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('队列与数据版本已刷新');
  await expect(page.getByRole('button', { name: '重试刷新' })).toHaveCount(0);
});

test('refreshes after a revision conflict, retains the form, and succeeds on retry', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Revision recovery is viewport independent and covered once.');
  const beanName = `版本冲突-${Date.now()}`;
  await addPendingBeans(request, [beanName]);
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(beanName) }).click();
  await page.getByLabel('当时感受').fill('冲突后仍要保留');

  await addPendingBeans(request, [`并发新增-${Date.now()}`]);
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('已刷新到最新版本');
  await expect(page.getByLabel('当时感受')).toHaveValue('冲突后仍要保留');

  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('草稿已保存');
});

test('ignores an older queue response that arrives after a newer revision refresh', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The deferred response race is viewport independent and covered once.');
  let releaseFirstResponse!: () => void;
  const releaseFirst = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  let markFirstCaptured!: () => void;
  const firstCaptured = new Promise<void>((resolve) => { markFirstCaptured = resolve; });
  let queueRequests = 0;

  await page.route('**/api/catch-up', async (route) => {
    queueRequests += 1;
    if (queueRequests === 1) {
      const oldResponse = await route.fetch();
      markFirstCaptured();
      await releaseFirst;
      await route.fulfill({ response: oldResponse });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await firstCaptured;
  const pendingName = `延迟队列-${Date.now()}`;
  await addPendingBeans(request, [pendingName]);

  await page.getByRole('button', { name: '不联网，直接手工填写' }).click();
  const brandField = page.getByRole('group', { name: '品牌' });
  const beanField = page.getByRole('group', { name: '豆名' });
  await brandField.getByRole('checkbox').check();
  await beanField.getByRole('checkbox').check();
  await brandField.getByRole('textbox', { name: '品牌' }).fill('触发刷新烘焙社');
  await beanField.getByRole('textbox', { name: '豆名' }).fill(`触发版本冲突-${Date.now()}`);
  await page.getByRole('button', { name: '确认加入关注' }).click();
  await expect.poll(() => queueRequests).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('button', { name: new RegExp(pendingName) })).toBeVisible();

  releaseFirstResponse();
  await page.waitForTimeout(100);
  await expect(page.getByRole('button', { name: new RegExp(pendingName) })).toBeVisible();
});
