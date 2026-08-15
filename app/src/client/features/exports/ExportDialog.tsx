import { useState } from 'react';
import type { GalleryFilters, GallerySort } from '../gallery/gallery-model';
interface Props { csrfToken: string; dataRevision: number; filteredBeanIds: string[]; selectedBeanIds: string[]; filters: GalleryFilters; sort: GallerySort; onDataChanged: () => Promise<void> }
type ExportScope = 'filtered' | 'selected';

export function ExportDialog({ csrfToken, dataRevision, filteredBeanIds, selectedBeanIds, filters, sort, onDataChanged }: Props) {
  const [markdown, setMarkdown] = useState(true); const [pdf, setPdf] = useState(true); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [links, setLinks] = useState<Record<string, string>>({}); const [snapshotId, setSnapshotId] = useState<string | null>(null); const [snapshotRevision, setSnapshotRevision] = useState<number | null>(null);
  const [preferredScope, setPreferredScope] = useState<ExportScope>('filtered');
  const [snapshotScopeSignature, setSnapshotScopeSignature] = useState<string | null>(null);
  const [feedbackScopeSignature, setFeedbackScopeSignature] = useState<string | null>(null);
  const scope: ExportScope = preferredScope === 'selected' && selectedBeanIds.length === 0 ? 'filtered' : preferredScope;
  const beanIds = scope === 'selected' ? selectedBeanIds : filteredBeanIds;
  const scopeLabel = scope === 'selected' ? '指定咖啡豆（来自比较台）' : '当前筛选范围';
  const signatureAtRevision = (revision: number) => JSON.stringify({ scope, beanIds, filters, sort, dataRevision: revision });
  const scopeSignature = signatureAtRevision(dataRevision);
  const visibleMessage = feedbackScopeSignature === scopeSignature ? message : '';
  const visibleLinks = snapshotScopeSignature === scopeSignature ? links : {};

  const exportReport = async () => {
    setFeedbackScopeSignature(scopeSignature);
    if (!markdown && !pdf) { setMessage('请至少选择一种导出格式。'); return; }
    if (!beanIds.length) { setMessage(scope === 'selected' ? '比较台还没有指定咖啡豆。请先在豆卡上加入比较。' : '当前筛选没有咖啡豆可导出。'); return; }
    setBusy(true); setMessage('正在固定快照并生成本地报告…');
    try {
      const exportFilters = { ...filters, exportScope: scope === 'selected' ? '比较台指定咖啡豆' : '当前筛选结果' };
      const reuseSnapshot = snapshotScopeSignature === scopeSignature;
      const response = await fetch('/api/exports', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ expectedRevision: reuseSnapshot ? snapshotRevision ?? dataRevision : dataRevision, beanIds, filters: exportFilters, sort, snapshotId: reuseSnapshot ? snapshotId ?? undefined : undefined, formats: [markdown && 'markdown', pdf && 'pdf'].filter(Boolean) }) });
      const body = await response.json() as { snapshot?: { id: string }; dataRevision?: number; artifacts?: Record<string, string>; error?: string };
      if (!response.ok || !body.snapshot || !body.artifacts) {
        if (body.snapshot) {
          const committedRevision = body.dataRevision ?? snapshotRevision ?? dataRevision;
          setSnapshotId(body.snapshot.id); setSnapshotRevision(committedRevision); setSnapshotScopeSignature(scopeSignature);
          try {
            await onDataChanged();
            const refreshedSignature = signatureAtRevision(committedRevision);
            setSnapshotScopeSignature(refreshedSignature); setFeedbackScopeSignature(refreshedSignature);
          } catch {
            setMessage('快照已固定，但页面版本刷新失败；将复用同一快照重试，不会重复创建。');
            return;
          }
        }
        setMessage(response.status === 409 ? '数据已更新，报告尚未生成；请刷新后重试。' : body.snapshot ? '部分格式未生成；将复用同一快照重试。' : '报告未完整生成。请重试导出。');
        return;
      }
      const committedRevision = body.dataRevision ?? snapshotRevision ?? dataRevision;
      setSnapshotId(body.snapshot.id); setSnapshotRevision(committedRevision); setSnapshotScopeSignature(scopeSignature); setLinks(body.artifacts);
      try {
        await onDataChanged();
        const refreshedSignature = signatureAtRevision(committedRevision);
        setSnapshotScopeSignature(refreshedSignature); setFeedbackScopeSignature(refreshedSignature);
        setMessage(`已生成同一快照 ${body.snapshot.id.slice(0, 8)} 的本地报告。`);
      } catch {
        setMessage(`已生成同一快照 ${body.snapshot.id.slice(0, 8)} 的本地报告，但页面版本刷新失败；重试会复用该快照。`);
      }
    } catch { setMessage('本地导出服务暂时不可用；数据没有发送到外部。'); } finally { setBusy(false); }
  };
  return <section className="export-studio" aria-labelledby="export-title"><div><p className="section-kicker">ARCHIVE / 06</p><h3 id="export-title">导出评价快照</h3><p>选择范围后，Markdown 与 PDF 会固定为同一版本；数据不会上传。</p></div>
    <fieldset className="export-scope"><legend>导出范围</legend><label><input type="radio" name="export-scope" checked={scope === 'filtered'} onChange={() => setPreferredScope('filtered')} /> 当前筛选范围（{filteredBeanIds.length} 支）</label><label><input type="radio" name="export-scope" checked={scope === 'selected'} disabled={selectedBeanIds.length === 0} onChange={() => setPreferredScope('selected')} /> 指定咖啡豆（比较台已选 {selectedBeanIds.length} 支）</label>{selectedBeanIds.length === 0 && <small>要导出指定豆，请先在豆卡上勾选“加入比较”；最多可选 3 支。</small>}</fieldset>
    <p className="export-scope-summary" aria-live="polite"><strong>本次导出：</strong>{scopeLabel} · {beanIds.length} 支咖啡豆</p>
    <div className="export-options"><label><input type="checkbox" checked={markdown} onChange={(event) => setMarkdown(event.target.checked)} /> Markdown（Obsidian）</label><label><input type="checkbox" checked={pdf} onChange={(event) => setPdf(event.target.checked)} /> PDF（阅读与打印）</label><button type="button" className="button-primary" disabled={busy || !beanIds.length} onClick={() => void exportReport()}>{busy ? '生成中…' : `确认导出 ${beanIds.length} 支豆`}</button></div><p role="status" aria-live="polite">{visibleMessage}</p>{Object.entries(visibleLinks).map(([format, href]) => <a key={format} className="button-outline export-download" href={href} download>下载 {format === 'markdown' ? 'Markdown' : 'PDF'}</a>)}</section>;
}
