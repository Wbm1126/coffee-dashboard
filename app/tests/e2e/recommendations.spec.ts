import { expect, test } from 'playwright/test';

test('edits local preferences and refreshes an explainable recommendation without external requests', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Full recommendation flow is covered once; responsive reachability runs separately.');
  const externalRequests: string[] = [];
  const recommendationRequests: string[] = [];
  page.on('request', (outgoing) => {
    const url = new URL(outgoing.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(outgoing.url());
    if (url.pathname.startsWith('/api/recommendations')) recommendationRequests.push(url.pathname);
  });
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const current = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const suffix = Date.now();
  const quick = await request.post('/api/catch-up/quick', { headers: {
    origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken,
  }, data: { expectedRevision: current.data.dataRevision, items: [{ brandName: '离线推荐社', beanName: `低酸奶咖-${suffix}`, drankOn: '2026-08-07', brewMethod: 'milk' }] } });
  expect(quick.ok()).toBeTruthy();
  const created = await quick.json() as { dataRevision: number; items: Array<{ beanId: string; drinkingRecordId: string }> };
  const reviewed = await request.post('/api/drinking/save', { headers: {
    origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken,
  }, data: {
    expectedRevision: created.dataRevision, beanId: created.items[0]!.beanId, purchaseItemId: null,
    drinkingRecordId: created.items[0]!.drinkingRecordId, drankOn: '2026-08-07', brewMethod: 'milk',
    extractionNote: null, feeling: '低酸，巧克力感清楚',
    americanoReview: { state: 'not_applicable', score: null, flavorNotes: [], pros: null, cons: null, note: null },
    milkReview: { state: 'reviewed', score: 4.5, flavorNotes: ['巧克力'], pros: null, cons: null, note: '适合奶咖' },
    isDraft: false, assessment: { grade: 'A', repurchase: 'yes', summary: '愿意复购' },
  } });
  expect(reviewed.ok()).toBeTruthy();

  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  await expect(view.getByRole('button', { name: '打开本地推荐' })).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(250);
  expect(recommendationRequests).toEqual([]);
  await view.getByRole('button', { name: '打开本地推荐' }).click();
  await expect(view.getByRole('button', { name: '收起本地推荐' })).toHaveAttribute('aria-expanded', 'true');
  await expect(view.getByRole('heading', { name: '今天值得怎样选豆？' })).toBeFocused();
  await view.getByLabel('主要冲煮方式').selectOption('milk');
  await view.getByLabel('酸感偏好').selectOption('low');
  await view.getByLabel('喜欢的风味').fill('巧克力');
  await view.getByLabel('每 100g 最高预算').fill('80');
  await view.getByRole('button', { name: '保存偏好' }).click();
  await expect(view.getByRole('status').filter({ hasText: '偏好已保存' })).toBeVisible();
  await expect(view.getByRole('heading', { name: '适合复购' })).toBeVisible();
  const card = view.getByRole('article').filter({ hasText: `低酸奶咖-${suffix}` });
  await expect(card.getByText(/个人评价与回购判断/)).toBeVisible();
  await expect(card.getByText(/数据缺口/)).toBeVisible();
  await view.getByRole('button', { name: '重新生成推荐' }).click();
  await expect(view.getByRole('status').filter({ hasText: '推荐已按本地数据重新生成' })).toBeVisible();
  await card.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByRole('dialog', { name: `低酸奶咖-${suffix}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: '加入关注' }).click();
  await expect(view.getByRole('status').filter({ hasText: '已加入关注' })).toBeVisible();
  await expect(card.getByRole('button', { name: '查看详情' })).toBeFocused();
  await card.getByRole('button', { name: '创建购买' }).click();
  await expect(page.getByRole('region', { name: '一笔订单，保留每支豆的来路' }).getByLabel('商品 1 咖啡豆')).toHaveValue(created.items[0]!.beanId);
  expect(externalRequests).toEqual([]);
});

test('shows five recommendations per lane by default and can reveal the complete local ranking', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The bounded recommendation list is covered once.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const current = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const suffix = Date.now();
  const seeded = await request.post('/api/catch-up/quick', { headers: {
    origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken,
  }, data: { expectedRevision: current.data.dataRevision, items: Array.from({ length: 7 }, (_, index) => ({
    brandName: '完整榜单社', beanName: `榜单豆-${suffix}-${index}`, drankOn: '2026-08-07', brewMethod: 'americano',
  })) } });
  expect(seeded.ok()).toBeTruthy();
  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  await view.getByRole('button', { name: '打开本地推荐' }).click();
  await expect(view.getByRole('status')).toContainText(/推荐快照与当前本地数据一致|已按当前本地数据生成/);
  const response = await request.get('/api/recommendations');
  const body = await response.json() as { snapshot: { worthTrying: unknown[]; repurchase: unknown[] } };
  for (const [heading, total] of [['值得尝试', body.snapshot.worthTrying.length], ['适合复购', body.snapshot.repurchase.length]] as const) {
    const lane = view.getByRole('region', { name: heading });
    await expect(lane.getByRole('article')).toHaveCount(Math.min(5, total));
    if (total > 5) {
      const reveal = lane.getByRole('button', { name: `查看全部 ${total} 支` });
      await reveal.click();
      await expect(lane.getByRole('article')).toHaveCount(total);
      await expect(lane.getByRole('button', { name: '收起到前 5 支' })).toBeVisible();
    }
  }
});

test('queues the newest data revision when an older automatic refresh is still in flight', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The revision race is covered once.');
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const seeded = await request.post('/api/catch-up/quick', { headers: {
    origin: 'http://127.0.0.1:5194', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken,
  }, data: { expectedRevision: snapshot.data.dataRevision, items: [{ brandName: '竞态测试社', beanName: `竞态预置-${Date.now()}`, drankOn: '2026-08-07', brewMethod: 'milk' }] } });
  expect(seeded.ok()).toBeTruthy();

  let releaseFirst!: () => void;
  let observeFirst!: () => void;
  const firstObserved = new Promise<void>((resolve) => { observeFirst = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let refreshCount = 0;
  await page.route('**/api/recommendations/refresh', async (route) => {
    refreshCount += 1;
    if (refreshCount === 1) { observeFirst(); await firstRelease; }
    await route.continue();
  });

  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  await view.getByRole('button', { name: '打开本地推荐' }).click();
  await firstObserved;
  await page.getByRole('button', { name: '开始补评价' }).click();
  await page.getByRole('button', { name: '快速补记喝过的豆子' }).click();
  await page.getByLabel('第 1 行品牌').fill('竞态测试社');
  await page.getByLabel('第 1 行豆名').fill(`竞态更新-${Date.now()}`);
  await page.getByRole('button', { name: '批量加入待补队列' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('已加入 1 款');
  releaseFirst();

  await expect.poll(() => refreshCount).toBeGreaterThanOrEqual(2);
  await expect(view.getByRole('status')).toContainText(/已按当前本地数据生成个性化推荐|推荐快照与当前本地数据一致/);
  await expect.poll(async () => {
    const currentRecommendation = await (await request.get('/api/recommendations')).json() as { dataRevision: number; stale: boolean; snapshot: { dataRevision: number } | null };
    return currentRecommendation.snapshot?.dataRevision === currentRecommendation.dataRevision && !currentRecommendation.stale;
  }).toBe(true);
});

test('keeps recommendation controls keyboard reachable at narrow widths and reduced motion', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'minimum-320-reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  const opener = view.getByRole('button', { name: '打开本地推荐' });
  await opener.focus();
  await opener.press('Enter');
  await expect(view.getByLabel('主要冲煮方式')).toBeVisible();
  await expect(view.getByLabel('主要冲煮方式')).toBeEnabled();
  await view.getByLabel('主要冲煮方式').focus();
  await page.keyboard.press('Tab');
  await expect(view.getByLabel('酸感偏好')).toBeFocused();
  const overflow = await view.evaluate((region) => {
    const boundary = region.getBoundingClientRect();
    return {
      region: { clientWidth: region.clientWidth, scrollWidth: region.scrollWidth },
      offenders: [...region.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.getBoundingClientRect().right > boundary.right + 1)
      .slice(0, 8)
      .map((element) => ({ tag: element.tagName, className: element.className, right: Math.round(element.getBoundingClientRect().right) })),
    };
  });
  expect(overflow.region.scrollWidth).toBeLessThanOrEqual(overflow.region.clientWidth);
  expect(overflow.offenders, JSON.stringify(overflow)).toEqual([]);
  await view.screenshot({ path: testInfo.outputPath(`recommendations-${testInfo.project.name}.png`) });
});

test('closing during a delayed snapshot read does not start a background write', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The close/read race is covered once.');
  let releaseRead!: () => void;
  let observeRead!: () => void;
  const readObserved = new Promise<void>((resolve) => { observeRead = resolve; });
  const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
  let refreshWrites = 0;
  await page.route('**/api/recommendations', async (route) => {
    if (route.request().method() === 'GET') { observeRead(); await readRelease; }
    await route.continue();
  });
  page.on('request', (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.pathname === '/api/recommendations/refresh' && outgoing.method() === 'POST') refreshWrites += 1;
  });

  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  await view.getByRole('button', { name: '打开本地推荐' }).click();
  await readObserved;
  await view.getByRole('button', { name: '收起本地推荐' }).click();
  releaseRead();
  await page.waitForTimeout(300);
  expect(refreshWrites).toBe(0);
  await expect(view.getByRole('button', { name: '打开本地推荐' })).toBeFocused();
});

test('reconciles an incomplete successful preference response without claiming the write failed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The ambiguous-success contract is covered once.');
  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  await view.getByRole('button', { name: '打开本地推荐' }).click();
  await expect(view.getByLabel('主要冲煮方式')).toBeVisible();
  await page.route('**/api/recommendations/preferences', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
  });
  await view.getByLabel('主要冲煮方式').selectOption('americano');
  await view.getByRole('button', { name: '保存偏好' }).click();
  await expect(view.getByText('偏好响应不完整，写入结果未知；已重新读取本地数据，请确认偏好后再重试。')).toBeVisible();
});

test('drains a queued refresh after follow contention', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The follow/refresh contention is covered once.');
  await page.goto('/');
  const view = page.getByRole('region', { name: '离线个性化推荐' });
  await view.getByRole('button', { name: '打开本地推荐' }).click();
  await expect(view.getByRole('status')).toContainText(/推荐快照与当前本地数据一致|已按当前本地数据生成/);

  let releaseFollow!: () => void;
  let observeFollow!: () => void;
  const followObserved = new Promise<void>((resolve) => { observeFollow = resolve; });
  const followRelease = new Promise<void>((resolve) => { releaseFollow = resolve; });
  let refreshWrites = 0;
  await page.route('**/api/beans/*/follow', async (route) => { observeFollow(); await followRelease; await route.continue(); });
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname === '/api/recommendations/refresh' && outgoing.method() === 'POST') refreshWrites += 1;
  });

  await view.getByRole('button', { name: '加入关注' }).first().click();
  await followObserved;
  await page.getByRole('button', { name: '开始补评价' }).click();
  await page.getByRole('button', { name: '快速补记喝过的豆子' }).click();
  await page.getByLabel('第 1 行品牌').fill('关注竞态社');
  await page.getByLabel('第 1 行豆名').fill(`关注竞态-${Date.now()}`);
  await page.getByRole('button', { name: '批量加入待补队列' }).click();
  await expect(page.locator('#catch-up-studio').getByRole('status')).toContainText('已加入 1 款');
  releaseFollow();
  await expect.poll(() => refreshWrites).toBeGreaterThanOrEqual(1);
});

test('does not touch recommendation APIs while using the ordinary homepage and record studio', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The passive homepage regression is covered once.');
  const recommendationRequests: string[] = [];
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.startsWith('/api/recommendations')) recommendationRequests.push(outgoing.url());
  });
  await page.goto('/');
  await page.getByRole('region', { name: '一笔订单，保留每支豆的来路' }).getByLabel('购买渠道').fill('只操作普通记录');
  await page.waitForTimeout(250);
  expect(recommendationRequests).toEqual([]);
  await expect(page.getByRole('button', { name: '打开本地推荐' })).toHaveAttribute('aria-expanded', 'false');
});
