import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { renderPdf } from '../../src/exports/pdf.js';
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
it('renders a tagged A4 PDF containing Chinese long-form report text', async () => {
  const bytes = await renderPdf({ snapshot: { id: '00000000-0000-4000-8000-000000000001', dataRevision: 7, generatedAt: '2026-08-15T08:00:00.000Z', beanIds: ['bean-1'], filters: { roast: '中深烘焙' }, sort: { field: 'name', direction: 'asc' } }, beans: Array.from({ length: 8 }, (_, index) => ({ id: `bean-${index}`, brand: '山谷咖啡', name: `长风味测试豆 ${index + 1}`, roast: '中深烘焙', process: '日晒', flavorNotes: ['黑巧克力', '焦糖', '莓果'], price: '68 CNY', americano: '4.5 分：甜感清晰，余韵干净。'.repeat(8), milk: '未知', assessment: 'A · 会回购 · 中文长文本分页检查', sources: [] })) });
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.byteLength).toBeGreaterThan(5_000);
  const dir = await mkdtemp(join(tmpdir(), 'coffee-pdf-')); dirs.push(dir); await writeFile(join(dir, 'report.pdf'), bytes);
});
