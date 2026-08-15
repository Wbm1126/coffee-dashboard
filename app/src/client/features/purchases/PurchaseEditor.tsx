import { useEffect, useState, type FormEvent } from 'react';
import type { CoffeeData } from '../../../domain/schema';
import { formatLocalDate } from '../../local-date';
import { usePostSaveRefresh } from '../../use-post-save-refresh';

interface Line { key: string; purchaseItemId: string | null; beanId: string; quantity: string; packageGrams: string; paid: string }
interface Props { csrfToken: string; data: CoffeeData; initialPurchase?: CoffeeData['purchases'][number]; preselectedBeanId?: string | null; onDataChanged: () => Promise<void>; onSaved: () => void; onDirtyChange: (dirty: boolean) => void; onCancelEdit: () => void }

export function PurchaseEditor({ csrfToken, data, initialPurchase, preselectedBeanId, onDataChanged, onSaved, onDirtyChange, onCancelEdit }: Props) {
  const editableBeanIds = new Set(initialPurchase
    ? data.purchaseItems.filter((item) => item.purchaseId === initialPurchase.id).map((item) => item.beanId)
    : []);
  const activeBeans = data.beans.filter((bean) => !bean.archivedAt || editableBeanIds.has(bean.id));
  const [purchasedOn, setPurchasedOn] = useState(initialPurchase?.purchasedOn ?? formatLocalDate());
  const [channel, setChannel] = useState(initialPurchase?.channel ?? '');
  const [note, setNote] = useState(initialPurchase?.note ?? '');
  const [lines, setLines] = useState<Line[]>(() => initialPurchase
    ? data.purchaseItems.filter((item) => item.purchaseId === initialPurchase.id).map((item) => ({ key: item.id, purchaseItemId: item.id, beanId: item.beanId, quantity: String(item.quantity), packageGrams: item.packageGrams === null ? '' : String(item.packageGrams), paid: item.paid === null ? '' : String(item.paid.amount) }))
    : activeBeans[0]
      ? [{ key: crypto.randomUUID(), purchaseItemId: null, beanId: activeBeans.find((bean) => bean.id === preselectedBeanId)?.id ?? activeBeans[0].id, quantity: '1', packageGrams: '', paid: '' }]
      : []);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const { refreshPending, refreshAfterSave } = usePostSaveRefresh(onDataChanged, onSaved);
  const snapshot = JSON.stringify({ purchasedOn, channel, note, lines: lines.map((line) => ({ purchaseItemId: line.purchaseItemId, beanId: line.beanId, quantity: line.quantity, packageGrams: line.packageGrams, paid: line.paid })) });
  const [baseline, setBaseline] = useState(snapshot); const dirty = snapshot !== baseline;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  const update = (key: string, patch: Partial<Line>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/purchases/save', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ expectedRevision: data.dataRevision, purchaseId: initialPurchase?.id ?? null, purchasedOn, channel: channel || null, note: note || null,
          shipping: initialPurchase?.shipping ?? null, discount: initialPurchase?.discount ?? null, items: lines.map((line) => ({ purchaseItemId: line.purchaseItemId, beanId: line.beanId,
            quantity: Number(line.quantity), packageGrams: line.packageGrams ? Number(line.packageGrams) : null,
            paid: line.paid ? { amount: Number(line.paid), currency: 'CNY' } : null })) }) });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '购买记录未保存，请检查全部商品行。');
      setBaseline(snapshot);
      const successMessage = initialPurchase ? '购买更正已保存，没有创建重复订单。' : `已保存一笔包含 ${lines.length} 支豆的购买，没有自动生成饮用记录。`;
      setMessage(await refreshAfterSave() ? successMessage : '购买已保存，但刷新失败；请点击“重试刷新”，勿重复提交。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '购买记录未保存。'); }
    finally { setBusy(false); }
  };

  return <section className="record-card" aria-labelledby="purchase-title">
    <p className="section-kicker">PURCHASE / 购买事实</p><h3 id="purchase-title">一笔订单，保留每支豆的来路</h3>{initialPurchase && <p className="editing-notice">正在更正已有购买；保存会更新原记录。</p>}
    {activeBeans.length === 0 ? <p>先建立至少一支咖啡豆，再记录购买。</p> : <form onSubmit={(event) => void submit(event)}>
      <div className="record-grid"><label>购买日期<input aria-label="购买日期" type="date" required value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} /></label>
        <label>渠道<input aria-label="购买渠道" value={channel} onChange={(e) => setChannel(e.target.value)} /></label>
        <label className="field-wide">订单备注<textarea aria-label="订单备注" value={note} onChange={(e) => setNote(e.target.value)} /></label></div>
      <div className="purchase-lines">{lines.map((line, index) => <fieldset key={line.key}><legend>商品 {index + 1}</legend>
        <label>咖啡豆<select aria-label={`商品 ${index + 1} 咖啡豆`} value={line.beanId} onChange={(e) => update(line.key, { beanId: e.target.value })}>{activeBeans.map((bean) => <option key={bean.id} value={bean.id}>{bean.name}</option>)}</select></label>
        <label>数量<input aria-label={`商品 ${index + 1} 数量`} type="number" min="1" required value={line.quantity} onChange={(e) => update(line.key, { quantity: e.target.value })} /></label>
        <label>单包克数<input aria-label={`商品 ${index + 1} 单包克数`} type="number" min="0.1" step="0.1" value={line.packageGrams} onChange={(e) => update(line.key, { packageGrams: e.target.value })} /></label>
        <label>行实付<input aria-label={`商品 ${index + 1} 行实付`} type="number" min="0" step="0.01" value={line.paid} onChange={(e) => update(line.key, { paid: e.target.value })} /></label>
        {lines.length > 1 && <button type="button" className="text-button" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>移除此行</button>}
      </fieldset>)}</div>
      <div className="record-actions"><button type="button" className="button-outline" onClick={() => setLines((current) => [...current, { key: crypto.randomUUID(), purchaseItemId: null, beanId: activeBeans[0]!.id, quantity: '1', packageGrams: '', paid: '' }])}>添加商品</button>
        {initialPurchase && <button type="button" className="text-button" onClick={() => { if (!dirty || window.confirm('购买更正尚未保存，确定退出吗？')) onCancelEdit(); }}>取消更正</button>}
        {refreshPending && <button type="button" className="button-outline" disabled={busy} onClick={async () => { setBusy(true); setMessage(await refreshAfterSave() ? '购买数据已刷新。' : '刷新仍未完成；已保存的购买不会重复写入。'); setBusy(false); }}>重试刷新</button>}
        <button type="submit" className="button-primary" disabled={busy || refreshPending}>{busy ? '保存中…' : initialPurchase ? '保存更正' : '保存购买'}</button></div>
    </form>}
    {message && <p className="record-message" role="status">{message}</p>}
  </section>;
}
