import { useCallback, useMemo, useRef, useState } from 'react';
import type { CoffeeData } from '../../../domain/schema';
import { BeanDetailDrawer } from '../beans/BeanDetailDrawer';
import { ComparisonView } from '../comparison/ComparisonView';
import { BeanCard } from './BeanCard';
import { FilterBar } from './FilterBar';
import { ExportDialog } from '../exports/ExportDialog';
import { buildGalleryItems, createEmptyGalleryFilters, filterAndSortGalleryItems, uniqueKnown, type GalleryItem, type GallerySort } from './gallery-model';

interface FollowResponse { error?: string; message?: string }
interface Props { data: CoffeeData; csrfToken: string; onDataChanged: () => Promise<void>; onCreatePurchase: (beanId: string) => boolean }
export function BeanGallery({ data, csrfToken, onDataChanged, onCreatePurchase }: Props) {
  const items = useMemo(() => buildGalleryItems(data), [data]);
  const [filters, setFilters] = useState(createEmptyGalleryFilters);
  const [sort, setSort] = useState<GallerySort>({ field: 'name', direction: 'asc' });
  const [listView, setListView] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<GalleryItem | null>(null);
  const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);
  const [busyBeanId, setBusyBeanId] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [message, setMessage] = useState('');
  const followInFlight = useRef<string | null>(null);
  const filtered = useMemo(() => filterAndSortGalleryItems(items, filters, sort), [filters, items, sort]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.bean.id, item])), [items]);
  const comparisonItems = useMemo(() => selectedIds.map((id) => itemsById.get(id)).filter((item): item is GalleryItem => Boolean(item)), [itemsById, selectedIds]);
  const options = useMemo(() => ({ brands: uniqueKnown(items.map((item) => item.brand)), roasts: uniqueKnown(items.map((item) => item.roast)), flavors: uniqueKnown(items.flatMap((item) => item.bean.flavorNotes)), processes: uniqueKnown(items.map((item) => item.bean.process)), scenes: uniqueKnown(items.flatMap((item) => item.scenes)), grades: uniqueKnown(items.map((item) => item.grade)) }), [items]);
  const openDetail = (item: GalleryItem, trigger: HTMLElement) => { setDetail(item); setDetailTrigger(trigger); };
  const closeDetail = useCallback(() => setDetail(null), []);
  const completeLifecycle = (action: 'archived' | 'permanently_deleted') => {
    setDetail(null);
    setMessage(action === 'archived' ? '咖啡豆已归档；购买、饮用与评价历史仍然保留。' : '没有事实引用的最小草稿已永久删除。');
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.gallery-message')?.focus());
  };
  const focusAfterFollow = (scope: Element | null) => {
    window.requestAnimationFrame(() => {
      const target = scope?.isConnected
        ? scope.querySelector<HTMLElement>('.drawer-close, .bean-card__open')
        : null;
      (target ?? document.querySelector<HTMLElement>('.gallery-message'))?.focus();
    });
  };
  const retryRefresh = async () => {
    if (followInFlight.current) return;
    followInFlight.current = 'refresh';
    setRefreshBusy(true); setMessage('');
    try {
      await onDataChanged();
      setRefreshPending(false);
      setMessage('本地数据已刷新，可以继续操作。');
      focusAfterFollow(null);
    } catch {
      setMessage('刷新仍未完成；已写入的关注不会重复提交，请稍后重试。');
    } finally {
      setRefreshBusy(false);
      followInFlight.current = null;
    }
  };
  const follow = async (beanId: string, trigger?: HTMLButtonElement) => {
    if (followInFlight.current) return;
    if (refreshPending) {
      setMessage('请先重试刷新，再关注其他咖啡豆。已写入的数据不会重复提交。');
      return;
    }
    const focusScope = trigger?.closest('.bean-card, .bean-drawer') ?? null;
    followInFlight.current = beanId;
    setBusyBeanId(beanId); setMessage('');
    try {
      const response = await fetch(`/api/beans/${beanId}/follow`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ expectedRevision: data.dataRevision }) });
      const body = await response.json() as FollowResponse;
      if (!response.ok) {
        if (response.status === 409 || body.error === 'revision_conflict') {
          try {
            await onDataChanged();
            setRefreshPending(false);
            setMessage('数据已在其他页面更新，已刷新到最新版本；请再次加入关注。');
          } catch {
            setRefreshPending(true);
            setMessage('数据已在其他页面更新，但最新版本刷新失败；关注未写入，请先重试刷新。');
          }
          return;
        }
        setMessage(body.message ?? '关注没有保存，请稍后重试。');
        return;
      }
      try {
        await onDataChanged();
        setRefreshPending(false);
        setMessage('已加入关注，状态已写入本地数据。');
        focusAfterFollow(focusScope);
      } catch {
        setRefreshPending(true);
        setMessage('关注已写入本地数据，但页面刷新失败；请重试刷新，勿重复提交。');
        focusAfterFollow(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '关注没有保存。');
    } finally {
      setBusyBeanId(null);
      followInFlight.current = null;
    }
  };
  return <section className="gallery-studio" id="gallery-studio" aria-labelledby="gallery-title"><div className="gallery-heading"><div><p className="section-kicker">COLLECTION / 03</p><h2 id="gallery-title">收藏陈列馆</h2></div><p>商品、购买与饮用从这里汇合。先看风味和状态，再沿着来源线追到每一次记录。</p></div>
    <FilterBar filters={filters} sort={sort} options={options} resultCount={filtered.length} onFiltersChange={setFilters} onSortChange={setSort} onClear={() => setFilters(createEmptyGalleryFilters())} />
    <ExportDialog csrfToken={csrfToken} dataRevision={data.dataRevision} filteredBeanIds={filtered.map((item) => item.bean.id)} selectedBeanIds={comparisonItems.map((item) => item.bean.id)} filters={filters} sort={sort} onDataChanged={onDataChanged} />
    <div className="gallery-view-toggle" aria-label="陈列方式"><button type="button" aria-pressed={!listView} onClick={() => setListView(false)}>卡片</button><button type="button" aria-pressed={listView} onClick={() => setListView(true)}>列表</button></div>
    {message && <p className="gallery-message" role="status" aria-live="polite" tabIndex={-1}>{message}</p>}
    {refreshPending && <button type="button" className="button-outline gallery-refresh-button" disabled={refreshBusy || Boolean(busyBeanId)} onClick={() => void retryRefresh()}>{refreshBusy ? '刷新中…' : '重试刷新'}</button>}
    {items.length === 0 ? <div className="gallery-empty"><h3>陈列馆还是空的</h3><p>先补录喝过的豆，或从四月表格迁移；新条目会自动在这里出现。</p></div> : filtered.length === 0 ? <div className="gallery-empty"><h3>没有符合条件的豆</h3><p>未知字段不会被当作最低值。可以清除筛选后继续浏览。</p><button type="button" className="button-outline" onClick={() => setFilters(createEmptyGalleryFilters())}>清除筛选</button></div> : <div className={`bean-gallery ${listView ? 'bean-gallery--list' : ''}`}>{filtered.map((item) => <BeanCard key={item.bean.id} item={item} selected={selectedIds.includes(item.bean.id)} onSelect={(selected) => setSelectedIds((current) => selected ? [...current.filter((id) => id !== item.bean.id), item.bean.id].slice(-3) : current.filter((id) => id !== item.bean.id))} onOpen={(trigger) => openDetail(item, trigger)} onFollow={(trigger) => void follow(item.bean.id, trigger)} onPurchase={() => onCreatePurchase(item.bean.id)} followBusy={busyBeanId === item.bean.id} followDisabled={Boolean(busyBeanId) || refreshBusy || refreshPending} />)}</div>}
    <ComparisonView items={comparisonItems} onRemove={(beanId) => setSelectedIds((current) => current.filter((id) => id !== beanId))} onOpen={openDetail} onFollow={(beanId) => void follow(beanId)} onPurchase={onCreatePurchase} busyBeanId={busyBeanId} />
    <BeanDetailDrawer item={detail ? itemsById.get(detail.bean.id) ?? detail : null} returnFocusTo={detailTrigger} dataRevision={data.dataRevision} csrfToken={csrfToken} onDataChanged={onDataChanged} onLifecycleCompleted={completeLifecycle} onClose={closeDetail} onFollow={(beanId, trigger) => void follow(beanId, trigger)} onPurchase={(beanId) => { const accepted = onCreatePurchase(beanId); if (accepted) closeDetail(); return accepted; }} followBusy={busyBeanId === detail?.bean.id} followDisabled={Boolean(busyBeanId) || refreshBusy || refreshPending} />
  </section>;
}
