import { useMemo, useState } from 'react';
import type { CoffeeData } from '../../../domain/schema';
import { usePostSaveRefresh } from '../../use-post-save-refresh';

interface Props { csrfToken: string; data: CoffeeData; onDataChanged: () => Promise<void>; onEditPurchase: (id: string) => void; onEditDrinking: (id: string) => void }
type Pending = { kind: 'drinking' | 'purchases'; id: string; message: string } | null;

export function RecordTimeline({ csrfToken, data, onDataChanged, onEditPurchase, onEditDrinking }: Props) {
  const [pending, setPending] = useState<Pending>(null); const [message, setMessage] = useState('');
  const [mutating, setMutating] = useState(false);
  const [lastTrashed, setLastTrashed] = useState<{ kind: 'drinking' | 'purchases'; id: string } | null>(null);
  const { refreshPending, refreshAfterSave } = usePostSaveRefresh(onDataChanged);
  const beanNames = useMemo(() => new Map(data.beans.map((bean) => [bean.id, bean.name])), [data.beans]);
  const beanName = (id: string) => beanNames.get(id) ?? '已缺失的咖啡豆';
  const preview = async (kind: 'drinking' | 'purchases', id: string) => {
    if (refreshPending || mutating) return;
    const response = await fetch(`/api/${kind}/${id}/trash-impact`); const impact = await response.json() as { beanIds?: string[]; purchaseItemCount?: number };
    if (!response.ok) { setMessage('无法读取关联影响，记录未移动。'); return; }
    setPending({ kind, id, message: `将影响 ${impact.beanIds?.map(beanName).join('、') || '未知豆'}${impact.purchaseItemCount ? `，以及 ${impact.purchaseItemCount} 个购买项` : ''}；保存后可立即撤销。` });
  };
  const mutate = async (kind: 'drinking' | 'purchases', id: string, action: 'trash' | 'restore') => {
    if (refreshPending || mutating) return;
    setMutating(true);
    try {
      const response = await fetch(`/api/${kind}/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ expectedRevision: data.dataRevision }) });
      const body = await response.json() as { message?: string }; if (!response.ok) { setMessage(body.message ?? '操作失败，数据未改变。'); return; }
      setPending(null);
      setLastTrashed(action === 'trash' ? { kind, id } : null);
      const refreshed = await refreshAfterSave();
      setMessage(refreshed ? (action === 'trash' ? '记录已移入回收站。' : '记录已恢复。') : `${action === 'trash' ? '记录已移入回收站' : '记录已恢复'}，但刷新失败；请先重试刷新，勿重复操作。`);
    } finally {
      setMutating(false);
    }
  };
  const purge = async (kind: 'drinking' | 'purchases', id: string) => {
    if (refreshPending || mutating) return;
    if (!window.confirm('永久清除后无法恢复。确定只清除这条已在回收站中的记录吗？')) return;
    setMutating(true);
    try {
      const response = await fetch(`/api/${kind}/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ expectedRevision: data.dataRevision, confirmPermanent: true }) });
      const body = await response.json() as { message?: string }; if (!response.ok) { setMessage(body.message ?? '永久清除失败；记录仍在回收站。'); return; }
      setLastTrashed(null);
      const refreshed = await refreshAfterSave();
      setMessage(refreshed ? '已永久清除所选回收站记录。' : '记录已永久清除，但刷新失败；请先重试刷新，勿重复操作。');
    } finally {
      setMutating(false);
    }
  };
  const actionDisabled = refreshPending || mutating;
  const activePurchases = data.purchases.filter((item) => !item.deletedAt); const activeDrinks = data.drinkingRecords.filter((item) => !item.deletedAt && !item.isDraft);
  const trashedPurchases = data.purchases.filter((item) => item.deletedAt); const trashedDrinks = data.drinkingRecords.filter((item) => item.deletedAt);
  return <section className="record-timeline" aria-labelledby="timeline-title"><p className="section-kicker">HISTORY / 长期事实链</p><h3 id="timeline-title">购买与饮用各自保留，在这里汇合</h3>
    {pending && <div className="impact-preview" role="alert"><strong>移动前影响</strong><p>{pending.message}</p><button className="button-primary" type="button" disabled={actionDisabled} onClick={() => void mutate(pending.kind, pending.id, 'trash')}>确认移入回收站</button><button className="text-button" type="button" disabled={mutating} onClick={() => setPending(null)}>取消</button></div>}
    {message && <p className="record-message" role="status">{message} {lastTrashed && <button type="button" className="text-button" disabled={actionDisabled} onClick={() => void mutate(lastTrashed.kind, lastTrashed.id, 'restore')}>立即撤销</button>} {refreshPending && <button type="button" className="button-outline" disabled={mutating} onClick={async () => { setMutating(true); const refreshed = await refreshAfterSave(); setMessage(refreshed ? '数据已刷新，可以继续操作。' : '刷新仍未完成；请勿重复操作。'); setMutating(false); }}>重试刷新</button>}</p>}
    <div className="timeline-columns"><div><h4>购买</h4>{activePurchases.length === 0 ? <p>还没有购买记录。</p> : activePurchases.map((purchase) => <article key={purchase.id}><b>{purchase.purchasedOn} · {purchase.channel ?? '渠道未记'}</b><span>{purchase.itemIds.length} 个商品项</span><div className="timeline-actions"><button className="text-button" disabled={actionDisabled} onClick={() => onEditPurchase(purchase.id)}>更正</button><button className="text-button" disabled={actionDisabled} onClick={() => void preview('purchases', purchase.id)}>移入回收站</button></div></article>)}</div>
      <div><h4>饮用</h4>{activeDrinks.length === 0 ? <p>还没有饮用记录。</p> : activeDrinks.map((drink) => <article key={drink.id}><b>{drink.drankOn} · {beanName(drink.beanId)}</b><span>{drink.brewMethod} · {drink.purchaseItemId ? '已关联购买项' : '历史饮用'}</span><div className="timeline-actions"><button className="text-button" disabled={actionDisabled} onClick={() => onEditDrinking(drink.id)}>更正</button><button className="text-button" disabled={actionDisabled} onClick={() => void preview('drinking', drink.id)}>移入回收站</button></div></article>)}</div></div>
    {(trashedPurchases.length + trashedDrinks.length) > 0 && <details className="trash"><summary>回收站（{trashedPurchases.length + trashedDrinks.length}）</summary>{trashedPurchases.map((item) => <p key={item.id}>购买 {item.purchasedOn} <button disabled={actionDisabled} onClick={() => void mutate('purchases', item.id, 'restore')}>恢复</button> <button disabled={actionDisabled} onClick={() => void purge('purchases', item.id)}>永久清除</button></p>)}{trashedDrinks.map((item) => <p key={item.id}>饮用 {item.drankOn} · {beanName(item.beanId)} <button disabled={actionDisabled} onClick={() => void mutate('drinking', item.id, 'restore')}>恢复</button> <button disabled={actionDisabled} onClick={() => void purge('drinking', item.id)}>永久清除</button></p>)}</details>}
  </section>;
}
