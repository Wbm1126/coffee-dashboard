import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext } from 'playwright/test';
import { JsonRepository } from '../../src/storage/json-repository.js';

const writeHeaders = (csrfToken: string) => ({
  origin: 'http://127.0.0.1:5194',
  'content-type': 'application/json',
  'x-csrf-token': csrfToken,
});

async function createReferencedBean(request: APIRequestContext, beanName: string) {
  const session = await (await request.get('/api/session')).json() as { csrfToken: string };
  const snapshot = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  const response = await request.post('/api/catch-up/quick', {
    headers: writeHeaders(session.csrfToken),
    data: {
      expectedRevision: snapshot.data.dataRevision,
      items: [{ brandName: '生命周期测试社', beanName, drankOn: '2026-08-08', brewMethod: 'americano' }],
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { items: Array<{ beanId: string }> };
  return { beanId: body.items[0]!.beanId, csrfToken: session.csrfToken };
}

async function createMinimalDraft(markerBeanId: string, beanName: string) {
  const entries = await readdir(resolve('test-results'), { withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && candidate.name.startsWith('e2e-data-'))) {
    const repository = new JsonRepository(resolve('test-results', entry.name));
    try {
      const current = await repository.read();
      if (!current.beans.some((bean) => bean.id === markerBeanId)) continue;
      const beanId = randomUUID();
      await repository.mutate(current.dataRevision, (draft) => {
        const now = new Date().toISOString();
        draft.beans.push({
          id: beanId, brandId: null, name: beanName, normalizedKey: beanName.toLocaleLowerCase('zh-CN'),
          roastLevel: null, process: null, flavorNotes: [], followedAt: null, archivedAt: null,
          isDraft: true, legacyStatusRaw: null, legacyPersonalScoreRaw: null, provenance: {},
          createdAt: now, updatedAt: now,
        });
      });
      return beanId;
    } catch {
      // Ignore stale data directories from interrupted prior runs.
    }
  }
  throw new Error('找不到当前端到端测试数据目录。');
}

test('previews impact, archives a referenced bean, and permanently deletes only a minimal draft', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Full bean lifecycle is covered once; narrow reachability is separate.');
  const suffix = Date.now();
  const referencedName = `有关联历史-${suffix}`;
  const { beanId: referencedId } = await createReferencedBean(request, referencedName);
  await page.goto('/');

  const gallery = page.getByRole('region', { name: '收藏陈列馆' });
  const referencedCard = gallery.getByRole('article').filter({ hasText: referencedName });
  await referencedCard.getByRole('button', { name: '查看档案' }).click();
  let dialog = page.getByRole('dialog', { name: referencedName });
  await dialog.getByRole('button', { name: '查看归档或删除影响' }).click();
  await expect(dialog.getByText('只能归档，历史记录会保留')).toBeVisible();
  await expect(dialog.getByText('共有 1 条关联事实')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /永久删除/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '确认归档' })).toBeFocused();

  const beforeCancel = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog.getByRole('button', { name: '查看归档或删除影响' })).toBeFocused();
  const afterCancel = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number; beans: Array<{ id: string; archivedAt: string | null }> } };
  expect(afterCancel.data.dataRevision).toBe(beforeCancel.data.dataRevision);
  expect(afterCancel.data.beans.find((bean) => bean.id === referencedId)?.archivedAt).toBeNull();

  await dialog.getByRole('button', { name: '查看归档或删除影响' }).click();
  await createReferencedBean(request, `并发更新-${suffix}`);
  await dialog.getByRole('button', { name: '确认归档' }).click();
  await expect(dialog.getByRole('status')).toContainText('已刷新到最新版本');
  await expect(dialog.getByRole('button', { name: '查看归档或删除影响' })).toBeFocused();

  await dialog.getByRole('button', { name: '查看归档或删除影响' }).click();
  let failNextSnapshot = true;
  await page.route('**/api/snapshot', async (route) => {
    if (!failNextSnapshot) { await route.continue(); return; }
    failNextSnapshot = false;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'refresh_unavailable' }) });
  });
  await dialog.getByRole('button', { name: '确认归档' }).click();
  await expect(dialog.getByRole('status')).toContainText('咖啡豆已归档，但页面刷新失败');
  await expect(dialog.getByRole('button', { name: '确认归档' })).toBeDisabled();
  await dialog.getByRole('button', { name: '重试刷新' }).click();
  await expect(dialog).toBeHidden();
  await expect(gallery.getByRole('status').filter({ hasText: '咖啡豆已归档' })).toBeFocused();
  const archived = await (await request.get('/api/snapshot')).json() as { data: { beans: Array<{ id: string; archivedAt: string | null }>; drinkingRecords: Array<{ beanId: string }> } };
  expect(archived.data.beans.find((bean) => bean.id === referencedId)?.archivedAt).not.toBeNull();
  expect(archived.data.drinkingRecords.some((record) => record.beanId === referencedId)).toBeTruthy();

  const draftName = `可永久删除草稿-${suffix}`;
  const draftId = await createMinimalDraft(referencedId, draftName);
  await page.reload();
  const draftCard = gallery.getByRole('article').filter({ hasText: draftName });
  await draftCard.getByRole('button', { name: '查看档案' }).click();
  dialog = page.getByRole('dialog', { name: draftName });
  await dialog.getByRole('button', { name: '查看归档或删除影响' }).click();
  await expect(dialog.getByText('允许永久删除最小草稿')).toBeVisible();

  const beforeConfirmationCancel = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number } };
  page.once('dialog', (confirmation) => confirmation.dismiss());
  await dialog.getByRole('button', { name: '永久删除这支草稿' }).click();
  await expect(dialog.getByRole('status')).toContainText('已取消永久删除');
  const afterConfirmationCancel = await (await request.get('/api/snapshot')).json() as { data: { dataRevision: number; beans: Array<{ id: string }> } };
  expect(afterConfirmationCancel.data.dataRevision).toBe(beforeConfirmationCancel.data.dataRevision);
  expect(afterConfirmationCancel.data.beans.some((bean) => bean.id === draftId)).toBeTruthy();

  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '永久删除这支草稿' }).click();
  await expect(dialog).toBeHidden();
  await expect(gallery.getByRole('status').filter({ hasText: '最小草稿已永久删除' })).toBeFocused();
  const removed = await (await request.get('/api/snapshot')).json() as { data: { beans: Array<{ id: string }> } };
  expect(removed.data.beans.some((bean) => bean.id === draftId)).toBeFalsy();
});

test('keeps the bean impact preview operable without horizontal overflow at 320px', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'minimum-320-reduced', 'This assertion targets the minimum supported width.');
  const beanName = `窄屏归档-${Date.now()}`;
  await createReferencedBean(request, beanName);
  await page.goto('/');
  const card = page.getByRole('region', { name: '收藏陈列馆' }).getByRole('article').filter({ hasText: beanName });
  await card.getByRole('button', { name: '查看档案' }).click();
  const dialog = page.getByRole('dialog', { name: beanName });
  await dialog.getByRole('button', { name: '查看归档或删除影响' }).click();
  await expect(dialog.getByRole('button', { name: '确认归档' })).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog.getByRole('button', { name: '查看归档或删除影响' })).toBeVisible();
});
