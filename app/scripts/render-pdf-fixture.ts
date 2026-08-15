import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderPdf } from '../src/exports/pdf.js';
const output = resolve('test-results', 'pdf-visual', 'coffee-export-sample.pdf');
await mkdir(resolve('test-results', 'pdf-visual'), { recursive: true });
const bytes = await renderPdf({ snapshot: { id: '00000000-0000-4000-8000-000000000001', dataRevision: 7, generatedAt: '2026-08-15T08:00:00.000Z', beanIds: ['bean'], filters: { roast: '中深烘焙' }, sort: { field: 'name', direction: 'asc' } }, beans: Array.from({ length: 12 }, (_, index) => ({ id: `${index}`, brand: '山谷咖啡', name: `中文分页测试豆 ${index + 1}`, roast: '中深烘焙', process: '日晒', flavorNotes: ['黑巧克力', '焦糖', '莓果'], price: '68 CNY', americano: '4.5 分：甜感清晰，余韵干净。'.repeat(10), milk: index % 2 ? '未知' : '4.0 分：奶咖平衡。', assessment: 'A · 会回购 · 长文本分页检查', sources: [] })) });
await writeFile(output, bytes); process.stdout.write(`${output}\n`);
