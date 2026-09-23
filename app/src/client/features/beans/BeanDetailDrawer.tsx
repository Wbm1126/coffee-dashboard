import type { CoffeeData } from '../../../domain/schema';
import { Dialog } from '../../components/Dialog';
import type { GalleryItem } from '../gallery/gallery-model';
import { REPURCHASE_OPTIONS, REVIEW_SCORE_MAX, REVIEW_STATE_LABELS } from '../reviews/review-options';
import { BeanLifecyclePanel } from './BeanLifecyclePanel';

interface Props { item: GalleryItem | null; returnFocusTo: HTMLElement | null; dataRevision: number; csrfToken: string; onDataChanged: () => Promise<void>; onLifecycleCompleted: (action: 'archived' | 'permanently_deleted') => void; onClose: () => void; onFollow: (beanId: string, trigger: HTMLButtonElement) => void; onPurchase: (beanId: string) => boolean; followBusy: boolean; followDisabled: boolean }

export function BeanDetailDrawer({ item, returnFocusTo, dataRevision, csrfToken, onDataChanged, onLifecycleCompleted, onClose, onFollow, onPurchase, followBusy, followDisabled }: Props) {
  const bean = item?.bean;
  const sources = item?.sources ?? [];
  const purchases = item?.purchaseHistory ?? [];
  const drinks = item?.drinkingHistory ?? [];
  return <Dialog open={Boolean(item)} labelledBy="bean-detail-title" onClose={onClose} returnFocusTo={returnFocusTo} className="bean-drawer">
    {item && bean && <>
      <header className="drawer-heading"><div><p className="section-kicker">BEAN INDEX / {String(item.originalIndex + 1).padStart(2, '0')}</p><h2 id="bean-detail-title">{bean.name}</h2><p>{item.brand ?? '品牌未知'} · {bean.importedFacts?.originOrVariety ?? '产地 / 品种未知'}</p></div><button type="button" className="drawer-close" onClick={onClose} aria-label="关闭咖啡豆详情">关闭 ×</button></header>
      <div className="drawer-spectrum" aria-label="风味谱">{bean.flavorNotes.length ? bean.flavorNotes.map((note) => <span key={note}>{note}</span>) : <span>风味待补</span>}</div>
      <div className="drawer-actions">{!item.badges.includes('followed') && <button type="button" className="button-outline" disabled={followDisabled} onClick={(event) => onFollow(bean.id, event.currentTarget)}>{followBusy ? '保存中…' : '加入关注'}</button>}<button type="button" className="button-primary" onClick={() => onPurchase(bean.id)}>为这支豆创建购买</button></div>
      {/* 信息优先级（v1.1 U6）：商品信息 → 我的评价 → 最近冲煮 → 历史记录 → 购买记录 → 数据来源（折叠）。 */}
      <section aria-labelledby="bean-product-title"><h3 id="bean-product-title">商品信息</h3><dl className="detail-facts"><Fact term="烘焙度" value={bean.roastLevel} /><Fact term="处理法" value={bean.process} /><Fact term="参考价格" value={item.price === null ? null : `¥${item.price} ${bean.importedFacts?.referencePrice?.currency ?? ''}`} /><Fact term="规格" value={bean.importedFacts?.packageGrams ? `${bean.importedFacts.packageGrams}g` : null} /></dl></section>
      <section aria-labelledby="bean-verdict-title"><h3 id="bean-verdict-title">我的评价</h3><dl className="detail-facts"><Fact term="个人等级" value={item.assessment?.grade ?? bean.legacyPersonalScoreRaw} /><Fact term="回购判断" value={REPURCHASE_OPTIONS.find((option) => option.value === item.assessment?.repurchase)?.label ?? null} /></dl><p>{item.assessment?.summary ?? '尚未形成综合结论。'}</p></section>
      <section aria-labelledby="bean-lastbrew-title"><h3 id="bean-lastbrew-title">最近冲煮</h3>{(() => {
        const lastWithParams = [...drinks].sort((left, right) => (right.record.drankOn + right.record.createdAt).localeCompare(left.record.drankOn + left.record.createdAt)).find(({ record }) => Object.values(record.brewParams ?? {}).some((value) => value !== null));
        if (!lastWithParams?.record.brewParams) return <p className="unknown-note">还没有记录过冲煮参数；在"记录"里填写后会显示在这里。</p>;
        const params = lastWithParams.record.brewParams;
        return <dl className="detail-facts"><Fact term="日期" value={lastWithParams.record.drankOn} /><Fact term="粉量" value={params.doseGrams === null ? null : `${params.doseGrams}g`} /><Fact term="液量" value={params.yieldGrams === null ? null : `${params.yieldGrams}g`} /><Fact term="时间" value={params.brewTimeSeconds === null ? null : `${params.brewTimeSeconds}秒`} /><Fact term="水温" value={params.temperatureC === null ? null : `${params.temperatureC}°C`} /><Fact term="研磨" value={params.grindSetting} /><Fact term="水量" value={params.waterGrams === null ? null : `${params.waterGrams}g`} /><Fact term="奶量" value={params.milkGrams === null ? null : `${params.milkGrams}g`} /></dl>;
      })()}</section>
      <section aria-labelledby="bean-drink-title"><h3 id="bean-drink-title">历史记录 · {drinks.length}</h3>{drinks.length ? <ol className="trace-list">{drinks.map(({ record, purchaseItem, purchase }) => <li key={record.id}><b>{record.drankOn}</b><span>{record.brewMethod}</span><PurchaseTrace purchaseItemId={record.purchaseItemId} purchaseItem={purchaseItem} purchase={purchase} /><ReviewLine name="美式" review={record.americanoReview} /><ReviewLine name="奶咖" review={record.milkReview} />{record.feeling && <small>{record.feeling}</small>}</li>)}</ol> : <p className="unknown-note">还没有饮用记录。</p>}</section>
      <section aria-labelledby="bean-purchase-title"><h3 id="bean-purchase-title">购买记录 · {purchases.length}</h3>{purchases.length ? <ol className="trace-list">{purchases.map(({ purchase, items }) => <li key={purchase.id}><b>{purchase.purchasedOn}</b><span>{purchase.channel ?? '渠道未知'}</span><small>{items.map((line) => `${line.quantity} 包 / ${line.paid ? `¥${line.paid.amount}` : '实付未知'}`).join('；')}</small></li>)}</ol> : <p className="unknown-note">还没有购买记录。</p>}</section>
      <details className="provenance-details" aria-label="数据来源与出处">
        <summary>数据来源（provenance）</summary>
        {(() => {
          const fieldEntries = Object.entries(bean.provenance).filter(([, entries]) => (entries ?? []).length > 0);
          if (!fieldEntries.length && !sources.length) return <p className="unknown-note">暂无字段级出处记录。</p>;
          return <>
            {sources.length > 0 && <ul>{sources.map((source) => { const url = safeExternalUrl(source.url); return <li key={source.id}>{url ? <a href={url} target="_blank" rel="noreferrer">{source.title ?? '商品来源'}</a> : <span>{source.title ?? '来源地址不可打开'}</span>}<small>{new Date(source.capturedAt).toLocaleString('zh-CN')}</small></li>; })}</ul>}
            <ul>{fieldEntries.map(([field, entries]) => { const latest = (entries ?? [])[(entries ?? []).length - 1]!; return <li key={field}>{field}：{SOURCE_KIND_LABELS[latest.sourceKind]} · {latest.location || latest.sourceId} · {new Date(latest.capturedAt).toLocaleDateString('zh-CN')}</li>; })}</ul>
          </>;
        })()}
      </details>
      <BeanLifecyclePanel beanId={bean.id} beanName={bean.name} dataRevision={dataRevision} csrfToken={csrfToken} onDataChanged={onDataChanged} onCompleted={onLifecycleCompleted} />
    </>}
  </Dialog>;
}

function Fact({ term, value }: { term: string; value: string | null | undefined }) { return <div><dt>{term}</dt><dd>{value || '未知'}</dd></div>; }
const SOURCE_KIND_LABELS: Record<string, string> = { user: '手工确认', excel: '历史表格', official: '官方页面', search: '搜索结果', derived: '推算值' };
function ReviewLine({ name, review }: { name: string; review: CoffeeData['drinkingRecords'][number]['americanoReview'] }) { return <small>{name}：{review ? `${REVIEW_STATE_LABELS[review.state]}${review.score === null ? '' : ` · ${review.score}/${REVIEW_SCORE_MAX}`}` : '未知'}</small>; }
function PurchaseTrace({ purchaseItemId, purchaseItem, purchase }: { purchaseItemId: string | null; purchaseItem: GalleryItem['drinkingHistory'][number]['purchaseItem']; purchase: GalleryItem['drinkingHistory'][number]['purchase'] }) {
  if (!purchaseItemId) return <small>购买来源：未关联购买项</small>;
  if (!purchaseItem) return <small>购买来源：购买项已缺失</small>;
  if (!purchase) return <small>购买来源：购买记录已缺失 · {purchaseItem.quantity} 包</small>;
  const packageText = purchaseItem.packageGrams === null ? '' : ` · ${purchaseItem.packageGrams}g`;
  const paidText = purchaseItem.paid === null ? '' : ` · ¥${purchaseItem.paid.amount}`;
  return <small>购买来源：{purchase.purchasedOn} · {purchase.channel ?? '渠道未知'} · {purchaseItem.quantity} 包{packageText}{paidText}{purchase.deletedAt ? ' · 已移入回收站' : ''}</small>;
}
function safeExternalUrl(value: string) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
