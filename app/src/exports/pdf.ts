import { chromium } from 'playwright';
import type { ExportReport } from './report-model.js';
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
export async function renderPdf(report: ExportReport): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    const beanHtml = report.beans.map((bean, index) => `<article><h2>${index + 1}. ${escapeHtml(bean.brand)} · ${escapeHtml(bean.name)}</h2><dl><dt>烘焙度</dt><dd>${escapeHtml(bean.roast)}</dd><dt>处理法</dt><dd>${escapeHtml(bean.process)}</dd><dt>风味</dt><dd>${escapeHtml(bean.flavorNotes.join('、') || '未知')}</dd><dt>参考价</dt><dd>${escapeHtml(bean.price)}</dd><dt>美式评价</dt><dd>${escapeHtml(bean.americano)}</dd><dt>奶咖评价</dt><dd>${escapeHtml(bean.milk)}</dd><dt>综合结论</dt><dd>${escapeHtml(bean.assessment)}</dd></dl></article>`).join('');
    await page.setContent(`<!doctype html><title>豆迹咖啡豆评价报告</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src 'none'"><style>@page{size:A4;margin:17mm}body{font:10.5pt 'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#29231f}h1{font-size:22pt}h2{break-after:avoid;font-size:15pt;border-bottom:1px solid #b65a3c;padding-bottom:4pt}article{break-inside:avoid;margin:0 0 15pt}dl{display:grid;grid-template-columns:30mm 1fr;gap:5pt 8pt;margin:0}dt{color:#785f54}dd{margin:0;overflow-wrap:anywhere}header{border-bottom:2px solid #223d39;padding-bottom:8pt;margin-bottom:15pt}.meta{color:#785f54;font-size:9pt}</style><header><h1>豆迹咖啡豆评价报告</h1><p class="meta">生成时间：${escapeHtml(report.snapshot.generatedAt)} 数据版本：${report.snapshot.dataRevision}<br>快照标识：${escapeHtml(report.snapshot.id)}</p></header>${beanHtml}`);
    await page.evaluate('document.fonts.ready');
    return await page.pdf({ format: 'A4', printBackground: true, tagged: true, outline: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#785f54">豆迹 · <span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  } finally { await browser.close(); }
}
