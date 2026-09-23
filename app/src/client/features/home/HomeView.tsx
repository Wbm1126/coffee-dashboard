import type { CoffeeData } from '../../../domain/schema';
import { CatchUpQueue } from '../catch-up/CatchUpQueue';
import { BREW_METHOD_OPTIONS } from '../reviews/review-options';
import { currentlyDrinkingBeans, pendingReviewDrinks, recentDrinks, recentlyAddedBeans } from './home-model';

interface Props {
  csrfToken: string;
  data: CoffeeData;
  onDataChanged: () => Promise<void>;
  onGoAdd: () => void;
  onGoRecords: (focus: 'drink' | 'review') => void;
}

// 首页五模块：当前在喝 / 最近喝过 / 待评价 / 快捷操作 / 最近新增。
export function HomeView({ csrfToken, data, onDataChanged, onGoAdd, onGoRecords }: Props) {
  const drinking = currentlyDrinkingBeans(data);
  const drinks = recentDrinks(data, 5);
  const pending = pendingReviewDrinks(data);
  const recentBeans = recentlyAddedBeans(data, 5);
  return <div className="home-modules">
    <section className="home-module home-module--drinking" aria-labelledby="home-drinking-title">
      <h3 id="home-drinking-title">当前在喝</h3>
      {drinking.length ? <ul>{drinking.map((line) => <li key={line.beanId}><b>{line.name}</b><small>{line.brand ?? '品牌未知'}{line.roastLevel ? ` · ${line.roastLevel}` : ''}</small></li>)}</ul> : <p className="home-empty">没有标记为"在喝"的豆；在购买项里把状态改成"在喝"就会出现在这里。</p>}
    </section>
    <section className="home-module" aria-labelledby="home-recent-title">
      <h3 id="home-recent-title">最近喝过</h3>
      {drinks.length ? <ol>{drinks.map((line) => <li key={line.record.id}><b>{line.beanName}</b><small>{line.record.drankOn} · {BREW_METHOD_OPTIONS.find((option) => option.value === line.record.brewMethod)?.label ?? line.record.brewMethod}{line.score !== null ? ` · ${line.score}/5` : ' · 待评分'}</small>{line.record.feeling && <small className="home-feeling">{line.record.feeling}</small>}</li>)}</ol> : <p className="home-empty">还没有饮用记录；喝一杯，用一分钟记下来。</p>}
    </section>
    <section className="home-module home-module--pending" aria-labelledby="home-pending-title">
      <h3 id="home-pending-title">待评价{pending.length > 0 && ` · ${pending.length}`}</h3>
      {pending.length ? <ol>{pending.slice(0, 3).map((line) => <li key={line.record.id}><b>{line.beanName}</b><small>{line.record.drankOn}</small></li>)}</ol> : <p className="home-empty">没有待补的评价。</p>}
      <button type="button" className="button-outline" onClick={() => onGoRecords('review')}>{pending.length ? '去补评价' : '记录一杯'}</button>
    </section>
    <section className="home-module home-module--actions" aria-labelledby="home-actions-title">
      <h3 id="home-actions-title">快捷操作</h3>
      <button type="button" className="button-primary" onClick={onGoAdd}>＋ 添加咖啡豆</button>
      <button type="button" className="button-outline" onClick={() => onGoRecords('drink')}>☕ 记录一杯</button>
      <button type="button" className="button-outline" onClick={() => onGoRecords('review')}>★ 写评价</button>
    </section>
    <section className="home-module" aria-labelledby="home-recent-beans-title">
      <h3 id="home-recent-beans-title">最近新增</h3>
      {recentBeans.length ? <ul>{recentBeans.map((line) => <li key={line.beanId}><b>{line.name}</b><small>{line.brand ?? '品牌未知'}{line.roastLevel ? ` · ${line.roastLevel}` : ''}</small></li>)}</ul> : <p className="home-empty">还没有咖啡豆。</p>}
    </section>
    <section className="home-module home-module--queue" aria-labelledby="home-catchup-title">
      <h3 id="home-catchup-title">补评价队列</h3>
      <CatchUpQueue csrfToken={csrfToken} snapshotRevision={data.dataRevision} onDataChanged={onDataChanged} />
    </section>
  </div>;
}
