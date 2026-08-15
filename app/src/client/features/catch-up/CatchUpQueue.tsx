import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatchUpQueue as CatchUpQueueData, CatchUpQueueItem } from '../../../domain/review-completeness';
import { ReviewEditor, type ReviewSavePayload } from '../reviews/ReviewEditor';
import { QuickBeanForm, type QuickEntryRow } from './QuickBeanForm';

interface QueueResponse extends CatchUpQueueData { dataRevision: number }

interface CatchUpQueueProps {
  csrfToken: string;
  snapshotRevision: number;
  onDataChanged: () => Promise<void>;
}

interface WriteErrorBody { code?: string; error?: string; message?: string }

class ApiWriteError extends Error {
  readonly code: string | undefined;

  constructor(body: WriteErrorBody, fallback: string) {
    super(body.message ?? fallback);
    this.code = body.error ?? body.code;
  }
}

export function CatchUpQueue({ csrfToken, snapshotRevision, onDataChanged }: CatchUpQueueProps) {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reviewDirty, setReviewDirty] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const queueLoaded = useRef(false);
  const loadSequence = useRef(0);

  const loadQueue = useCallback(async () => {
    const requestSequence = ++loadSequence.current;
    const response = await fetch('/api/catch-up');
    if (requestSequence !== loadSequence.current) return false;
    if (!response.ok) throw new Error('暂时无法读取待补评价队列。');
    const body = await response.json() as QueueResponse;
    if (requestSequence !== loadSequence.current) return false;
    queueLoaded.current = true;
    setRefreshPending(false);
    setQueue(body);
    setSkipped((current) => new Set([...current].filter((beanId) => body.items.some((item) => item.beanId === beanId))));
    setSelectedId((current) => current && body.items.some((item) => item.beanId === current) ? current : (body.items[0]?.beanId ?? null));
    return true;
  }, []);

  useEffect(() => {
    let active = true;
    const initialLoad = async () => {
      try {
        await loadQueue();
      } catch (caught) {
        if (active) {
          setRefreshPending(queueLoaded.current);
          setError((current) => current || (queueLoaded.current
            ? '数据版本已更新，但待补队列刷新失败；可重试刷新。'
            : caught instanceof Error ? caught.message : '队列读取失败。'));
        }
      }
    };
    void initialLoad();
    return () => { active = false; };
  }, [loadQueue, snapshotRevision]);

  const visibleItems = useMemo(() => queue?.items.filter((item) => !skipped.has(item.beanId)) ?? [], [queue, skipped]);
  const selected = visibleItems.find((item) => item.beanId === selectedId) ?? visibleItems[0] ?? null;

  const leaveReview = useCallback((message: string, action: () => void) => {
    if (reviewDirty && !window.confirm(message)) return;
    setReviewDirty(false);
    action();
  }, [reviewDirty]);

  const select = (item: CatchUpQueueItem) => {
    leaveReview('当前评价尚未保存，确定切换到另一款豆子吗？', () => setSelectedId(item.beanId));
  };

  const moveLater = () => {
    if (!selected) return;
    const index = visibleItems.findIndex((item) => item.beanId === selected.beanId);
    leaveReview('当前评价尚未保存，确定稍后再写吗？', () => {
      setSelectedId(visibleItems[(index + 1) % visibleItems.length]?.beanId ?? null);
    });
  };

  const skip = () => {
    if (!selected) return;
    leaveReview('当前评价尚未保存，确定跳过本轮吗？', () => {
      setSkipped((current) => new Set([...current, selected.beanId]));
      setSelectedId(visibleItems.find((item) => item.beanId !== selected.beanId)?.beanId ?? null);
    });
  };

  const write = async <T extends WriteErrorBody>(url: string, payload: unknown): Promise<T> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(payload),
    });
    const body = await response.json() as T;
    if (!response.ok) throw new ApiWriteError(body, '保存失败，数据未写入。');
    return body;
  };

  const refreshQueueAndSnapshot = async () => {
    const results = await Promise.allSettled([loadQueue(), onDataChanged()]);
    const failed = results.some((result) => result.status === 'rejected');
    setRefreshPending(failed);
    return !failed;
  };

  const recoverFromConflict = async () => {
    const refreshed = await refreshQueueAndSnapshot();
    setError(refreshed
      ? '数据已在其他页面更新，已刷新到最新版本。表单内容仍保留，请重新保存。'
      : '数据已在其他页面更新，但最新版本刷新失败。表单内容仍保留，请重试刷新后再保存。');
  };

  const retryRefresh = async () => {
    setBusy(true); setError(''); setMessage('');
    const refreshed = await refreshQueueAndSnapshot();
    if (refreshed) setMessage('队列与数据版本已刷新。');
    else setError('刷新仍未完成，请稍后再试；已经保存的数据不会重复写入。');
    setBusy(false);
  };

  const saveReview = async (payload: ReviewSavePayload): Promise<boolean> => {
    if (!queue) return false;
    setBusy(true); setError(''); setMessage('');
    try {
      const currentIndex = visibleItems.findIndex((item) => item.beanId === selected?.beanId);
      const nextBeanId = !payload.isDraft && visibleItems.length > 1
        ? visibleItems[(currentIndex + 1) % visibleItems.length]?.beanId ?? null
        : null;
      await write<{ message?: string; reviewComplete: boolean }>('/api/drinking/save', { expectedRevision: queue.dataRevision, ...payload });
      const refreshed = await refreshQueueAndSnapshot();
      if (nextBeanId) setSelectedId(nextBeanId);
      if (refreshed) {
        setMessage(payload.isDraft ? '草稿已保存，可以随时继续。' : '评价已保存，已自动前往下一款。');
      } else {
        setError('评价已保存，但队列刷新失败。可安全重试刷新，不要重复提交评价。');
      }
      return true;
    } catch (caught) {
      if (caught instanceof ApiWriteError && caught.code === 'revision_conflict') {
        await recoverFromConflict();
        return false;
      }
      setError(caught instanceof Error ? caught.message : '评价保存失败，表单内容仍在。');
      return false;
    } finally { setBusy(false); }
  };

  const saveQuick = async (rows: QuickEntryRow[]) => {
    if (!queue) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await write('/api/catch-up/quick', { expectedRevision: queue.dataRevision, items: rows });
      setQuickOpen(false);
      const refreshed = await refreshQueueAndSnapshot();
      if (refreshed) setMessage(`已加入 ${rows.length} 款，商品资料可以以后再补。`);
      else setError(`已加入 ${rows.length} 款，但队列刷新失败。可安全重试刷新，不要重复提交。`);
    } catch (caught) {
      if (caught instanceof ApiWriteError && caught.code === 'revision_conflict') {
        await recoverFromConflict();
        return;
      }
      setError(caught instanceof Error ? caught.message : '快速补记失败，输入内容仍在。');
    } finally { setBusy(false); }
  };

  return (
    <section id="catch-up-studio" className="catch-up-studio" aria-labelledby="catch-up-title">
      <header className="catch-up-heading">
        <div>
          <p className="section-kicker">TASTING BACKLOG / 02</p>
          <h2 id="catch-up-title">把散落的味道，一杯杯收回来。</h2>
        </div>
        <div className="progress-stamp" aria-label="补评价进度">
          <strong>{queue ? `${queue.completed}/${queue.total}` : '—'}</strong>
          <span>已完成</span>
        </div>
      </header>
      <p className="catch-up-lede">先写你真正喝到的部分。商品产地、处理法和价格都不拦住这一刻。</p>
      <div className="catch-up-toolbar">
        <button className="button-primary" type="button" onClick={() => leaveReview('当前评价尚未保存，确定打开快速补记吗？', () => setQuickOpen(true))}>快速补记喝过的豆子</button>
        <span>{visibleItems.length} 款等待本轮处理{skipped.size ? ` · ${skipped.size} 款已跳过` : ''}</span>
        {refreshPending && <button className="button-outline" type="button" disabled={busy} onClick={() => void retryRefresh()}>重试刷新</button>}
      </div>
      {(message || error) && <p role="status" className={error ? 'catch-up-message catch-up-message--error' : 'catch-up-message'}>{error || message}</p>}

      {quickOpen ? (
        <QuickBeanForm disabled={busy} onCancel={() => setQuickOpen(false)} onSubmit={saveQuick} />
      ) : (
        <div className="catch-up-workspace">
          <nav className="queue-rail" aria-label="待补评价咖啡豆">
            {visibleItems.map((item, index) => (
              <button key={item.beanId} type="button" aria-current={selected?.beanId === item.beanId ? 'true' : undefined} onClick={() => select(item)}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <b>{item.beanName}</b>
                <small>{item.brandName ?? '未记品牌'} · {item.reason === 'draft_drinking_record' ? '草稿' : item.drankOn ?? '待补日期'}</small>
              </button>
            ))}
            {visibleItems.length === 0 && (
              <div className="queue-empty">
                <span aria-hidden="true">✓</span>
                <b>{queue?.total ? '这一轮都处理好了' : '还没有待补评价'}</b>
                <p>下一次喝完一支豆，就从这里继续。</p>
              </div>
            )}
          </nav>
          <div className="review-stage">
            {selected ? (
              <ReviewEditor
                key={`${selected.beanId}-${selected.drinkingRecordId ?? 'new'}`}
                item={selected}
                disabled={busy}
                onSave={saveReview}
                onLater={moveLater}
                onSkip={skip}
                onDirtyChange={setReviewDirty}
              />
            ) : <div className="review-stage__empty"><p>队列清空后，这里会留作下一次品鉴的起点。</p></div>}
          </div>
        </div>
      )}
    </section>
  );
}
