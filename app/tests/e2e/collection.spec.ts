import { expect, test } from 'playwright/test';

const candidate = {
  sourceUrl: 'https://shop.example.com/bean-a', title: '日晒拼配', capturedAt: '2026-08-15T08:00:00.000Z', sourceKind: 'search',
  fields: { brandName: '山谷咖啡', beanName: '日晒拼配', roastLevel: '中深烘焙', process: '日晒', flavorNotes: ['黑巧克力', '焦糖'] },
};

test('parses a product into an editable confirmation preview and only saves after the user confirms', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The full collection flow is covered once; responsive reachability is covered separately.');
  const confirmed: unknown[] = [];
  await page.route('**/api/collect/parse', async (route) => route.fulfill({ json: {
    candidate, preview: { duplicateBeans: [], fields: [
      { key: 'brandName', currentValue: null, proposedValue: '山谷咖啡', defaultDecision: 'accept_candidate' },
      { key: 'beanName', currentValue: null, proposedValue: '日晒拼配', defaultDecision: 'accept_candidate' },
      { key: 'roastLevel', currentValue: null, proposedValue: '中深烘焙', defaultDecision: 'accept_candidate' },
    ] },
  } }));
  await page.route('**/api/collect/confirm', async (route) => {
    confirmed.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { dataRevision: 1, beanId: '00000000-0000-4000-8000-000000000001', action: 'create' } });
  });
  await page.goto('/');
  const collection = page.getByRole('region', { name: '联网采集与手工添加' });
  await collection.getByLabel('商品链接').fill('https://shop.example.com/bean-a');
  await collection.getByRole('button', { name: '解析链接' }).click();
  await expect(collection.getByRole('heading', { name: '确认这支豆的资料' })).toBeVisible();
  await expect(collection.getByText(/候选来源：https:\/\/shop\.example\.com\/bean-a · 采集时间：/)).toBeVisible();
  await collection.screenshot({ path: testInfo.outputPath('collection-confirmation.png') });
  await collection.getByRole('textbox', { name: '豆名', exact: true }).fill('日晒拼配（手工确认）');
  await collection.getByRole('button', { name: '确认加入关注' }).click();
  await expect(collection.getByRole('status')).toContainText('已加入关注');
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]).toMatchObject({ action: 'create', operationKey: expect.any(String), acceptedFields: { beanName: '日晒拼配（手工确认）' } });
});

test('keeps the failed URL and offers a minimum manual fallback without writing on cancellation', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'minimum-320-reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
  let confirmations = 0;
  await page.route('**/api/collect/parse', async (route) => route.fulfill({ status: 422, json: { error: 'no_product_fields', message: '页面没有可确认的商品名称，请改用手工录入。 原始链接和输入内容已保留，可改为手工填写。' } }));
  await page.route('**/api/collect/confirm', async (route) => { confirmations += 1; await route.fulfill({ status: 201, json: { dataRevision: 1, beanId: 'x', action: 'create' } }); });
  await page.goto('/');
  const collection = page.getByRole('region', { name: '联网采集与手工添加' });
  await collection.getByLabel('商品链接').fill('https://shop.example.com/blocked');
  await collection.getByRole('button', { name: '解析链接' }).click();
  await expect(collection.getByRole('status')).toContainText('手工填写');
  await expect(collection.getByLabel('商品链接')).toHaveValue('https://shop.example.com/blocked');
  await collection.getByRole('button', { name: '取消本次采集' }).click();
  expect(confirmations).toBe(0);
  const overflow = await collection.evaluate((region) => region.scrollWidth <= region.clientWidth);
  expect(overflow).toBeTruthy();
  await collection.screenshot({ path: testInfo.outputPath(`collection-${testInfo.project.name}.png`) });
});

test('does not launch duplicate external parses when the same control is activated twice synchronously', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The concurrency guard is covered once.');
  let parses = 0;
  await page.route('**/api/collect/parse', async (route) => {
    parses += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({ json: { candidate, preview: { duplicateBeans: [], fields: [] } } });
  });
  await page.goto('/');
  const collection = page.getByRole('region', { name: '联网采集与手工添加' });
  await collection.getByLabel('商品链接').fill('https://shop.example.com/bean-a');
  await collection.getByRole('button', { name: '解析链接' }).evaluate((button) => { button.click(); button.click(); });
  await expect(collection.getByRole('heading', { name: '确认这支豆的资料' })).toBeVisible();
  expect(parses).toBe(1);
});

test('merges a detected duplicate with its default keep-existing identity fields', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The default duplicate merge path is covered once.');
  const saved: unknown[] = [];
  await page.route('**/api/collect/parse', async (route) => route.fulfill({ json: {
    candidate,
    preview: { duplicateBeans: [{ id: '00000000-0000-4000-8000-000000000101', brandName: '山谷咖啡', name: '日晒拼配' }], fields: [
      { key: 'brandName', currentValue: '山谷咖啡', proposedValue: '山谷咖啡', defaultDecision: 'keep_existing' },
      { key: 'beanName', currentValue: '日晒拼配', proposedValue: '日晒拼配', defaultDecision: 'keep_existing' },
    ] },
  } }));
  await page.route('**/api/collect/confirm', async (route) => { saved.push(route.request().postDataJSON()); await route.fulfill({ json: { dataRevision: 2, action: 'merge' } }); });
  await page.goto('/');
  const collection = page.getByRole('region', { name: '联网采集与手工添加' });
  await collection.getByLabel('商品链接').fill('https://shop.example.com/bean-a');
  await collection.getByRole('button', { name: '解析链接' }).click();
  await collection.getByLabel(/合并到「山谷咖啡 · 日晒拼配」/).check();
  await collection.getByRole('button', { name: '确认加入关注' }).click();
  await expect(collection.getByRole('status')).toContainText('已加入关注');
  expect(saved[0]).toMatchObject({ action: 'merge', beanId: '00000000-0000-4000-8000-000000000101', acceptedFields: {} });
});

test('keeps mandatory identity inputs editable when parsing lacks a brand', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The incomplete parse recovery is covered once.');
  await page.route('**/api/collect/parse', async (route) => route.fulfill({ json: {
    candidate: { ...candidate, fields: { beanName: '无品牌候选' } },
    preview: { duplicateBeans: [], fields: [{ key: 'beanName', currentValue: null, proposedValue: '无品牌候选', defaultDecision: 'accept_candidate' }] },
  } }));
  await page.goto('/');
  const collection = page.getByRole('region', { name: '联网采集与手工添加' });
  await collection.getByLabel('商品链接').fill('https://shop.example.com/bean-a');
  await collection.getByRole('button', { name: '解析链接' }).click();
  await expect(collection.getByRole('textbox', { name: '品牌', exact: true })).toBeEnabled();
  await collection.getByRole('textbox', { name: '品牌', exact: true }).fill('补齐品牌');
});

test('does not call a confirmed write unknown when only the snapshot refresh fails', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'The post-confirm refresh recovery is covered once.');
  await page.route('**/api/collect/parse', async (route) => route.fulfill({ json: { candidate, preview: { duplicateBeans: [], fields: [] } } }));
  await page.route('**/api/collect/confirm', async (route) => route.fulfill({ status: 201, json: { dataRevision: 1, action: 'create' } }));
  await page.goto('/');
  await page.route('**/api/snapshot', async (route) => route.fulfill({ status: 500, json: { message: 'refresh failed' } }));
  const collection = page.getByRole('region', { name: '联网采集与手工添加' });
  await collection.getByLabel('商品链接').fill('https://shop.example.com/bean-a');
  await collection.getByRole('button', { name: '解析链接' }).click();
  await collection.getByRole('button', { name: '确认加入关注' }).click();
  await expect(collection.getByRole('status')).toContainText('已确认加入关注，但本地概览刷新失败');
});
