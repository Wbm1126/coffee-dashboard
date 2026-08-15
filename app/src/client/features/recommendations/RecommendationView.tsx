import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoffeeData, RecommendationItem, RecommendationSnapshot } from '../../../domain/schema';
import { BeanDetailDrawer } from '../beans/BeanDetailDrawer';
import { buildGalleryItems, type GalleryItem } from '../gallery/gallery-model';
import { PreferenceEditor } from './PreferenceEditor';
import { RECOMMENDATION_CONFIDENCE_LABELS, RECOMMENDATION_COPY as COPY } from './recommendation-copy';

interface Props {
  data: CoffeeData;
  csrfToken: string;
  onDataChanged: () => Promise<void>;
  onCreatePurchase: (beanId: string) => boolean;
}

interface RecommendationResponse {
  dataRevision: number;
  preferenceProfile: CoffeeData['preferenceProfile'];
  snapshot: RecommendationSnapshot | null;
  stale: boolean;
}

const LOCAL_REQUEST_TIMEOUT_MS = 15_000;
async function safeJson<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

export function RecommendationView({ data, csrfToken, onDataChanged, onCreatePurchase }: Props) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (open) window.requestAnimationFrame(() => titleRef.current?.focus());
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      window.requestAnimationFrame(() => toggleRef.current?.focus());
      return;
    }
    setOpen(true);
  };

  return <section className={`recommendation-studio ${open ? '' : 'recommendation-studio--closed'}`} id="recommendation-studio" aria-label="离线个性化推荐">
    <div className="recommendation-heading"><div><p className="section-kicker">LOCAL DECISION / 04</p><h2 id="recommendation-title" ref={titleRef} tabIndex={-1}>{open ? '今天值得怎样选豆？' : '推荐按需打开，不打扰记录。'}</h2></div><div className="recommendation-entry"><p>只有你明确打开后，才会读取本地偏好并生成推荐快照；普通浏览与记录不会因此改变数据版本。</p><button ref={toggleRef} type="button" className="button-outline" aria-expanded={open} aria-controls="recommendation-decision-panel" onClick={toggle}>{open ? '收起本地推荐' : '打开本地推荐'}</button></div></div>
    <div id="recommendation-decision-panel" hidden={!open}>
      {open && <RecommendationDecisionPanel data={data} csrfToken={csrfToken} onDataChanged={onDataChanged} onCreatePurchase={onCreatePurchase} />}
    </div>
  </section>;
}

function RecommendationDecisionPanel({ data, csrfToken, onDataChanged, onCreatePurchase }: Props) {
  const [snapshot, setSnapshot] = useState<RecommendationSnapshot | null>(null);
  const [snapshotStale, setSnapshotStale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>(COPY.reading);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<GalleryItem | null>(null);
  const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);
  const autoRevision = useRef<number | null>(null);
  const inFlight = useRef(false);
  const pendingRefresh = useRef<{ expectedRevision: number; automatic: boolean } | null>(null);
  const manualFeedbackRevision = useRef<number | null>(null);
  const readSequence = useRef(0);
  const requestControllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const items = useMemo(() => buildGalleryItems(data), [data]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.bean.id, item])), [items]);

  const localRequest = useCallback(async <T,>(url: string, init: RequestInit) => {
    const controller = new AbortController();
    requestControllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), LOCAL_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { response, body: await safeJson<T>(response) };
    } finally {
      window.clearTimeout(timeout);
      requestControllers.current.delete(controller);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controllers = requestControllers.current;
    return () => {
      mounted.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  const refresh = useCallback(async (expectedRevision: number, automatic: boolean) => {
    if (inFlight.current) {
      const pending = pendingRefresh.current;
      if (!pending || expectedRevision >= pending.expectedRevision) pendingRefresh.current = { expectedRevision, automatic };
      return;
    }
    inFlight.current = true; setBusy(true); setError(false);
    let next: { expectedRevision: number; automatic: boolean } | null = { expectedRevision, automatic };
    try {
      while (next) {
        const current = next;
        pendingRefresh.current = null;
        setMessage(current.automatic ? COPY.autoRefreshing : COPY.manualRefreshing);
        try {
          const { response, body } = await localRequest<{ snapshot?: RecommendationSnapshot; message?: string }>('/api/recommendations/refresh', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
            body: JSON.stringify({ expectedRevision: current.expectedRevision }),
          });
          if (!mounted.current) return;
          if (response.ok && !body?.snapshot) {
            setError(true);
            try {
              await onDataChanged();
              setMessage(COPY.malformedRefreshReconciled);
            } catch {
              setMessage(COPY.malformedRefreshUnreconciled);
            }
            next = pendingRefresh.current;
            continue;
          }
          if (!response.ok || !body?.snapshot) {
            if (response.status === 409) {
              try {
                await onDataChanged();
                setMessage(COPY.refreshConflictReconciled);
              } catch {
                setError(true); setMessage(COPY.refreshConflictUnreconciled);
              }
            } else {
              setError(true); setMessage(body?.message ?? COPY.refreshRejected);
            }
          } else {
            setSnapshot(body.snapshot);
            setSnapshotStale(false);
            if (!current.automatic) manualFeedbackRevision.current = body.snapshot.dataRevision;
            try {
              await onDataChanged();
              setMessage(current.automatic ? COPY.autoRefreshSaved : COPY.manualRefreshSaved);
            } catch {
              setError(true); setMessage(COPY.refreshSavedViewFailed);
            }
          }
        } catch {
          if (!mounted.current) return;
          setError(true);
          try {
            await onDataChanged();
            setMessage(COPY.refreshInterruptedReconciled);
          } catch {
            setMessage(COPY.refreshInterruptedUnreconciled);
          }
        }
        next = pendingRefresh.current;
      }
    } finally {
      if (mounted.current) setBusy(false);
      inFlight.current = false;
    }
  }, [csrfToken, localRequest, onDataChanged]);

  useEffect(() => {
    if (autoRevision.current === data.dataRevision) return;
    const sequence = ++readSequence.current;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const timeout = window.setTimeout(() => controller.abort(), LOCAL_REQUEST_TIMEOUT_MS);
        const response = await fetch('/api/recommendations', { signal: controller.signal }).finally(() => window.clearTimeout(timeout));
        if (!response.ok) throw new Error('recommendation_read_failed');
        const body = await response.json() as RecommendationResponse;
        if (!active || sequence !== readSequence.current) return;
        autoRevision.current = data.dataRevision;
        setSnapshot(body.snapshot);
        setSnapshotStale(body.stale);
        if (body.stale) await refresh(body.dataRevision, true);
        else if (manualFeedbackRevision.current !== data.dataRevision) setMessage(COPY.snapshotCurrent);
      } catch {
        if (!active) return;
        setError(true); setMessage(COPY.snapshotReadFailed);
      }
    })();
    return () => {
      active = false;
      readSequence.current += 1;
      controller.abort();
    };
  }, [data.dataRevision, refresh]);

  const follow = async (beanId: string, focusAfterSave?: HTMLElement | null) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(false); setMessage(COPY.following);
    try {
      const { response, body } = await localRequest<{ message?: string }>(`/api/beans/${beanId}/follow`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ expectedRevision: data.dataRevision }),
      });
      if (!mounted.current) return;
      if (response.ok && body === null) {
        setError(true);
        try {
          await onDataChanged();
          setMessage(COPY.malformedFollowReconciled);
        } catch {
          setMessage(COPY.malformedFollowUnreconciled);
        }
        return;
      }
      if (!response.ok) {
        setError(true); setMessage(body?.message ?? COPY.followRejected); return;
      }
      try {
        await onDataChanged(); setMessage(COPY.followSaved);
        window.requestAnimationFrame(() => { if (focusAfterSave?.isConnected) focusAfterSave.focus(); });
      } catch {
        setError(true); setMessage(COPY.followSavedViewFailed);
      }
    } catch {
      if (!mounted.current) return;
      setError(true);
      try {
        await onDataChanged();
        setMessage(COPY.followInterruptedReconciled);
      } catch {
        setMessage(COPY.followInterruptedUnreconciled);
      }
    } finally {
      if (mounted.current) setBusy(false);
      inFlight.current = false;
      const pending = pendingRefresh.current;
      if (mounted.current && pending) {
        pendingRefresh.current = null;
        void refresh(pending.expectedRevision, pending.automatic);
      }
    }
  };

  const openDetail = (beanId: string, trigger: HTMLElement) => {
    const item = itemsById.get(beanId);
    if (!item) return;
    setDetail(item); setDetailTrigger(trigger);
  };

  return <>
    <div className="recommendation-board">
      <PreferenceEditor profile={data.preferenceProfile} dataRevision={data.dataRevision} csrfToken={csrfToken} disabled={busy} onDataChanged={onDataChanged} />
      <div className="recommendation-results">
        <div className="recommendation-toolbar"><div>{snapshot ? <><span>规则 {snapshot.ruleVersion}</span><span>数据版本 {snapshot.dataRevision}</span><span>{new Date(snapshot.generatedAt).toLocaleString('zh-CN')}</span>{snapshotStale && <strong>快照已过期</strong>}</> : <span>尚无推荐快照</span>}</div><button type="button" className="button-outline" disabled={busy} onClick={() => void refresh(data.dataRevision, false)}>{busy ? '生成中…' : '重新生成推荐'}</button></div>
        <p className={`recommendation-message ${error ? 'recommendation-message--error' : ''}`} role="status" aria-live="polite">{message}</p>
        <RecommendationLane title="值得尝试" marker="TRY / 01" empty="当前没有未饮用的正式咖啡豆候选。加入关注或导入新豆后会出现在这里。" recommendations={snapshot?.worthTrying ?? []} itemsById={itemsById} busy={busy} onOpen={openDetail} onFollow={(beanId, focusAfterSave) => void follow(beanId, focusAfterSave)} onPurchase={onCreatePurchase} />
        <RecommendationLane title="适合复购" marker="AGAIN / 02" empty="还没有足够的饮用事实；完成一次评价后再来看看。明确“不会回购”的豆不会进入这里。" recommendations={snapshot?.repurchase ?? []} itemsById={itemsById} busy={busy} onOpen={openDetail} onFollow={(beanId, focusAfterSave) => void follow(beanId, focusAfterSave)} onPurchase={onCreatePurchase} />
      </div>
    </div>
    <BeanDetailDrawer item={detail ? itemsById.get(detail.bean.id) ?? detail : null} returnFocusTo={detailTrigger} dataRevision={data.dataRevision} csrfToken={csrfToken} onDataChanged={onDataChanged} onLifecycleCompleted={(action) => {
      setDetail(null);
      setMessage(action === 'archived' ? '咖啡豆已归档；关联历史仍然保留。' : '没有事实引用的最小草稿已永久删除。');
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.recommendation-toolbar button')?.focus());
    }} onClose={() => setDetail(null)} onFollow={(beanId, trigger) => void follow(beanId, trigger.nextElementSibling as HTMLElement | null)} onPurchase={(beanId) => { const accepted = onCreatePurchase(beanId); if (accepted) setDetail(null); return accepted; }} followBusy={busy} followDisabled={busy} />
  </>;
}

function RecommendationLane({ title, marker, empty, recommendations, itemsById, busy, onOpen, onFollow, onPurchase }: {
  title: string; marker: string; empty: string; recommendations: RecommendationItem[]; itemsById: Map<string, GalleryItem>; busy: boolean;
  onOpen: (beanId: string, trigger: HTMLElement) => void; onFollow: (beanId: string, focusAfterSave: HTMLElement | null) => void; onPurchase: (beanId: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleRecommendations = expanded ? recommendations : recommendations.slice(0, 5);
  return <section className="recommendation-lane" aria-labelledby={`lane-${marker.slice(0, 3).toLowerCase()}`}><div className="recommendation-lane__heading"><span>{marker}</span><h3 id={`lane-${marker.slice(0, 3).toLowerCase()}`}>{title}</h3></div>
    {recommendations.length === 0 ? <p className="recommendation-empty">{empty}</p> : <><div className="recommendation-stack">{visibleRecommendations.map((recommendation, index) => {
      const item = itemsById.get(recommendation.beanId);
      if (!item) return null;
      return <article key={recommendation.beanId} className="recommendation-card"><header><span>{String(index + 1).padStart(2, '0')}</span><div><h4>{item.bean.name}</h4><p>{item.brand ?? '品牌未知'} · {RECOMMENDATION_CONFIDENCE_LABELS[recommendation.confidence]}</p></div></header>
        <ol className="reason-bars">{recommendation.factors.map((entry) => <li key={entry.key}><div><b>{entry.label}</b><span>{entry.evidence}</span></div><i aria-hidden="true"><em style={{ width: `${entry.weight === 0 ? 0 : entry.contribution / entry.weight * 100}%` }} /></i></li>)}</ol>
        <p className="recommendation-gaps"><b>数据缺口：</b>{recommendation.missingData.length ? recommendation.missingData.join('；') : '五类本地信号均已有依据'}</p>
        <div className="recommendation-actions"><button type="button" className="text-button" onClick={(event) => onOpen(item.bean.id, event.currentTarget)}>查看详情</button>{item.bean.followedAt === null && <button type="button" className="text-button" disabled={busy} onClick={(event) => onFollow(item.bean.id, event.currentTarget.previousElementSibling as HTMLElement | null)}>加入关注</button>}<button type="button" className="button-outline" onClick={() => onPurchase(item.bean.id)}>创建购买</button></div>
      </article>;
    })}</div>{recommendations.length > 5 && <button type="button" className="recommendation-expand" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? '收起到前 5 支' : `查看全部 ${recommendations.length} 支`}</button>}</>}
  </section>;
}
