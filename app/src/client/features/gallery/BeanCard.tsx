import { useState, type CSSProperties } from 'react';
import type { GalleryItem } from './gallery-model';
import { BEAN_BADGE_LABELS } from './gallery-options';
import { BREW_METHOD_OPTIONS, REVIEW_SCORE_MAX } from '../reviews/review-options';

interface Props { item: GalleryItem; selected: boolean; onSelect: (selected: boolean) => void; onOpen: (trigger: HTMLButtonElement) => void; onFollow: (trigger: HTMLButtonElement) => void; onPurchase: () => void; followBusy: boolean; followDisabled: boolean }

export function BeanCard({ item, selected, onSelect, onOpen, onFollow, onPurchase, followBusy, followDisabled }: Props) {
  const nextAction = item.badges.includes('drank_pending_review') ? '补全未完成评价' : item.badges.includes('purchased_waiting') ? '饮用后记录体验' : '回看商品、购买与品鉴历史';
  // 最近喝法/评分：取最近一条可见饮用记录，评分按该喝法的主轨取值。
  const latestDrink = [...item.drinkingHistory].sort((left, right) => (right.record.drankOn + right.record.createdAt).localeCompare(left.record.drankOn + left.record.createdAt))[0];
  const primaryTrack = latestDrink && latestDrink.record.brewMethod === 'milk' ? latestDrink.record.milkReview : latestDrink?.record.americanoReview;
  const latestScore = primaryTrack?.score ?? null;
  const latestMethodLabel = BREW_METHOD_OPTIONS.find((option) => option.value === latestDrink?.record.brewMethod)?.label;
  // U7 商品图：本地缓存优先，回退远程地址；加载失败落到占位样式，不影响任何操作。
  const source = item.sources[0];
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc = !imageFailed && source ? (source.localImagePath ? `/api/images/${source.localImagePath}` : source.imageUrl) : null;
  return <article className="bean-card">
    {imageSrc ? <img className="bean-card__image" src={imageSrc} alt="" loading="lazy" onError={() => setImageFailed(true)} /> : <div className="bean-card__image bean-card__image--placeholder" aria-hidden="true">☕</div>}
    <div className="origin-index" aria-hidden="true"><span>{String(item.originalIndex + 1).padStart(2, '0')}</span><i /></div>
    <div className="bean-card__identity"><p>{item.brand ?? '品牌未知'}</p><h3>{item.bean.name}</h3><span>{item.bean.importedFacts?.originOrVariety ?? '产地 / 品种未知'}</span></div>
    <div className="flavor-spectrum" aria-label={item.bean.flavorNotes.length ? `风味：${item.bean.flavorNotes.join('、')}` : '风味未知'}>{item.bean.flavorNotes.length ? item.bean.flavorNotes.slice(0, 4).map((note, index) => <span key={note} style={{ '--spectrum-index': index } as CSSProperties}>{note}</span>) : <span>待补风味</span>}</div>
    <dl className="bean-card__facts"><div><dt>烘焙</dt><dd>{item.roast ?? '未知'}</dd></div><div><dt>参考价</dt><dd>{item.price === null ? '未知' : `¥${item.price}`}</dd></div><div><dt>个人等级</dt><dd>{item.grade ?? '未知'}</dd></div></dl>
    {latestDrink && <p className="bean-card__last-drink">最近喝：{latestDrink.record.drankOn} · {latestMethodLabel ?? latestDrink.record.brewMethod}{latestScore !== null ? ` · ${latestScore}/${REVIEW_SCORE_MAX}` : ''}</p>}
    <div className="bean-card__badges">{item.badges.length ? item.badges.map((badge) => <span key={badge} data-status={badge}>{BEAN_BADGE_LABELS[badge]}</span>) : <span>尚未归类</span>}</div>
    <div className="bean-card__actions">
      <p className="bean-card__next-action"><strong>下一步：</strong>{nextAction}</p>
      <label className="compare-check"><input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} />加入比较</label>
      {!item.badges.includes('followed') && <button type="button" className="text-button" disabled={followDisabled} onClick={(event) => onFollow(event.currentTarget)}>{followBusy ? '保存中…' : '加入关注'}</button>}
      <button type="button" className="text-button" onClick={onPurchase}>创建购买</button>
      <button type="button" className="bean-card__open" onClick={(event) => onOpen(event.currentTarget)}>查看档案</button>
    </div>
  </article>;
}
